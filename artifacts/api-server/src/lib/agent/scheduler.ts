import { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { db, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { logger } from "../logger";
import { canSendProactiveMessage, recordProactiveSend } from "./messagingBudget";
import { sendToThread } from "./delivery";
import {
  getOpenPoll,
  countDistinctVoters,
  getLeadingOption,
  announceTiebreak,
  closePollWithWinner,
} from "./polls";
import {
  getActivePlan,
  getMostRecentPlanForThread,
  getPlanById,
  getStalledPlans,
  getPlansNeedingFeedbackPrompt,
  setPendingFeedback,
  markPlanDone,
  setPlanVenue,
  setPlanScheduledFor,
} from "./plans";
import { buildGoogleCalendarLink, describePlanSchedule } from "./calendar";
import { getOccasionsDueForReminder, markOccasionReminded } from "./occasions";
import {
  findOrCreateDirectThread,
  getAllGroupThreadIds,
  getStalledOnboardingUserIds,
  markOnboardingNudgeSentForUser,
} from "./context";
import { DEFAULT_CITY, daysUntilNextSaturday, getForecastForDay } from "./weather";
import { ensureRevalidationConfigSeeded, runRevalidationScan } from "./venueCorpus/revalidation";

const QUEUES = {
  pollNudge: "poll-nudge",
  pollTiebreakAnnounce: "poll-tiebreak-announce",
  pollTiebreakLock: "poll-tiebreak-lock",
  planReminder: "plan-reminder",
  planRevive: "plan-revive",
  feedbackPrompt: "feedback-prompt",
  occasionScan: "occasion-scan",
  serendipityScan: "serendipity-scan",
  onboardingNudge: "onboarding-nudge",
  venueRevalidationScan: "venue-revalidation-scan",
} as const;

const NON_VOTER_NUDGE_DELAY_SECONDS = 4 * 60 * 60; // 4 hours after a poll opens
// Tiebreaker persona: if a poll is still unresolved 4 hours after the soft
// nudge (8h total), the concierge makes a confident call instead of nudging
// forever. The pick then locks in after a 1-hour objection window.
const TIEBREAK_ANNOUNCE_DELAY_SECONDS = 4 * 60 * 60;
const TIEBREAK_OBJECTION_WINDOW_SECONDS = 60 * 60;
const STALLED_PLAN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours with no movement
const STALLED_SCAN_CRON = "0 * * * *"; // hourly
const FEEDBACK_SCAN_CRON = "*/30 * * * *"; // every 30 minutes
const OCCASION_SCAN_CRON = "0 15 * * *"; // daily at 15:00 UTC
const OCCASION_REMINDER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // ~2 weeks out
const SERENDIPITY_SCAN_CRON = "0 16 * * *"; // daily at 16:00 UTC
const ONBOARDING_NUDGE_SCAN_CRON = "*/30 * * * *"; // every 30 minutes
const ONBOARDING_STALL_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours with no reply to the onboarding DM
// Runs daily, but `getVenuesDueForRevalidation` only returns venues whose
// own type's cadence (monthly for restaurants/bars, see
// `venueTypeRevalidationConfigTable`) has actually elapsed -- daily is just
// how often we check whether anything has come due, not the cadence itself.
const VENUE_REVALIDATION_SCAN_CRON = "0 9 * * *"; // daily at 09:00 UTC
// A group has to have gone quiet for a real stretch before an unprompted
// suggestion is worth the interruption -- this is what keeps it feeling
// rare and well-timed instead of naggy.
const SERENDIPITY_MIN_DAYS_SINCE_LAST_PLAN = 21;

let boss: PgBoss | null = null;

interface PollNudgeJobData {
  threadId: number;
  pollId: number;
}

interface PollTiebreakJobData {
  threadId: number;
  pollId: number;
}

interface PlanReminderJobData {
  threadId: number;
  planId: number;
}

async function handlePollNudge({ data }: { data: PollNudgeJobData }): Promise<void> {
  const open = await getOpenPoll(data.threadId);
  if (!open || open.poll.id !== data.pollId) return; // already closed/replaced -- nothing to nudge about

  const participantRows = await db
    .select({ userId: threadParticipantsTable.userId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, data.threadId));
  const voterCount = await countDistinctVoters(data.pollId);
  if (voterCount < participantRows.length) {
    if (await canSendProactiveMessage(data.threadId, "nudge")) {
      await sendToThread(
        data.threadId,
        `Friendly nudge -- still waiting on ${participantRows.length - voterCount} of you for "${open.poll.question}". Reply with your pick when you get a sec.`,
      );
      await recordProactiveSend(data.threadId, "nudge");
    }
  }

  // Tiebreaker persona: whether or not the nudge itself went out (budget may
  // have blocked it), still schedule the escalation check so a quiet group
  // doesn't stall forever just because the nudge was rate-limited.
  if (voterCount < participantRows.length && boss) {
    await boss.sendAfter(
      QUEUES.pollTiebreakAnnounce,
      { threadId: data.threadId, pollId: data.pollId },
      null,
      TIEBREAK_ANNOUNCE_DELAY_SECONDS,
    );
  }
}

async function handlePollTiebreakAnnounce({ data }: { data: PollTiebreakJobData }): Promise<void> {
  const open = await getOpenPoll(data.threadId);
  if (!open || open.poll.id !== data.pollId) return; // already resolved -- nothing to break the tie on

  const participantRows = await db
    .select({ userId: threadParticipantsTable.userId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, data.threadId));
  const voterCount = await countDistinctVoters(data.pollId);
  if (voterCount >= participantRows.length) return; // resolved itself in the meantime

  const leading = await getLeadingOption(data.pollId, open.options);
  if (!leading) return;

  await announceTiebreak(data.pollId, leading.id);
  await sendToThread(
    data.threadId,
    `Executive decision: ${leading.label}. Object within the hour or it's locked in.`,
  );

  if (boss) {
    await boss.sendAfter(
      QUEUES.pollTiebreakLock,
      { threadId: data.threadId, pollId: data.pollId },
      null,
      TIEBREAK_OBJECTION_WINDOW_SECONDS,
    );
  }
}

async function handlePollTiebreakLock({ data }: { data: PollTiebreakJobData }): Promise<void> {
  const open = await getOpenPoll(data.threadId);
  if (!open || open.poll.id !== data.pollId) return; // resolved normally in the meantime
  if (!open.poll.tiebreakAnnouncedAt || !open.poll.tiebreakOptionId) return; // objected to, or never announced

  const optionId = open.poll.tiebreakOptionId;
  const option = open.options.find((candidate) => candidate.id === optionId);
  await closePollWithWinner(data.pollId, optionId);

  if (open.poll.planId && option) {
    if (open.poll.kind === "date" && option.optionDate) {
      await setPlanScheduledFor(open.poll.planId, option.optionDate);
    } else if (open.poll.kind === "choice") {
      await setPlanVenue(open.poll.planId, option.label);
    }
  }

  await sendToThread(
    data.threadId,
    `Locking in ${option?.label ?? "that pick"} since nobody objected. Moving forward with it.`,
  );
}

async function handlePlanReminder({ data }: { data: PlanReminderJobData }): Promise<void> {
  const plan = await getPlanById(data.planId);
  if (!plan || plan.status !== "confirmed") return; // cancelled or never confirmed -- nothing to remind about

  if (!(await canSendProactiveMessage(data.threadId, "plan_reminder"))) return;

  const link = buildGoogleCalendarLink(plan);
  const message = `Reminder: "${plan.title}" is tomorrow (${describePlanSchedule(plan)}).${
    link ? ` Add it to your calendar: ${link}` : ""
  }`;
  await sendToThread(data.threadId, message);
  await recordProactiveSend(data.threadId, "plan_reminder");
}

async function handlePlanRevive(): Promise<void> {
  const stalled = await getStalledPlans(STALLED_PLAN_THRESHOLD_MS);
  for (const plan of stalled) {
    try {
      if (!(await canSendProactiveMessage(plan.threadId, "nudge"))) continue;
      await sendToThread(
        plan.threadId,
        `Hey -- "${plan.title}" has been sitting for a bit. Still want to lock something in, or should we drop it?`,
      );
      await recordProactiveSend(plan.threadId, "nudge");
    } catch (error) {
      logger.error({ error, planId: plan.id, threadId: plan.threadId }, "Failed to process plan-revive item; continuing with the rest of the batch");
    }
  }
}

async function handleFeedbackScan(): Promise<void> {
  const due = await getPlansNeedingFeedbackPrompt();
  for (const plan of due) {
    try {
      // Budget gating runs first and skips the plan entirely if denied -- we
      // must never flag a thread as "awaiting feedback" (which hijacks the
      // user's next reply) unless we're actually about to send the prompt
      // asking for it. The plan stays "confirmed" so the next scan retries
      // it once budget allows.
      if (!(await canSendProactiveMessage(plan.threadId, "nudge"))) continue;

      // Mark done and flag the thread *before* sending: if the process
      // crashes between this write and the send below, the worst case is a
      // skipped prompt (retried never, since the plan is no longer
      // "confirmed") rather than the same prompt going out twice on the next
      // scan. If the send throws synchronously (as opposed to a hard
      // crash), we can and must roll the "awaiting feedback" flag back --
      // otherwise the thread stays flagged and the user's next unrelated
      // message gets misread as feedback for a prompt they never received.
      await markPlanDone(plan.id);
      await setPendingFeedback(plan.threadId, plan.id);

      try {
        await sendToThread(plan.threadId, `How was "${plan.title}"? Reply with a quick rating (1-5) or a few words.`);
        await recordProactiveSend(plan.threadId, "nudge");
      } catch (sendError) {
        await setPendingFeedback(plan.threadId, null);
        throw sendError;
      }
    } catch (error) {
      logger.error({ error, planId: plan.id, threadId: plan.threadId }, "Failed to process feedback-scan item; continuing with the rest of the batch");
    }
  }
}

async function handleOccasionScan(): Promise<void> {
  const due = await getOccasionsDueForReminder(OCCASION_REMINDER_WINDOW_MS);
  for (const occasion of due) {
    try {
      // Budget gating first, same reasoning as feedback prompts: don't mark
      // an occasion "reminded" unless we're actually about to send.
      if (!(await canSendProactiveMessage(occasion.threadId, "occasion_reminder"))) continue;

      // Marked *before* the send so a crash in between skips this occasion's
      // reminder (retried never) rather than sending it twice on the next
      // daily scan.
      await markOccasionReminded(occasion.id);

      const daysAway = Math.round((occasion.occasionDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      const when = daysAway <= 0 ? "coming right up" : `in about ${daysAway} day${daysAway === 1 ? "" : "s"}`;
      await sendToThread(
        occasion.threadId,
        `Heads up -- ${occasion.label} is ${when}. Want me to help plan something for it?`,
      );
      await recordProactiveSend(occasion.threadId, "occasion_reminder");
    } catch (error) {
      logger.error({ error, occasionId: occasion.id, threadId: occasion.threadId }, "Failed to process occasion-scan item; continuing with the rest of the batch");
    }
  }
}

/**
 * Rationed proactive serendipity: once a day, checks every group thread for
 * the rare combination of "good weather coming up" + "this group hasn't met
 * in a while" + "nothing already in flight" + "budget allows it" -- the
 * `serendipity` category is the strictest tier (1 per 14 days), which is
 * what keeps this feeling like an occasional delight instead of a nag.
 */
async function handleSerendipityScan(): Promise<void> {
  const threadIds = await getAllGroupThreadIds();

  for (const threadId of threadIds) {
    try {
      // Never compete with a plan that's already in motion.
      const activePlan = await getActivePlan(threadId);
      if (activePlan) continue;

      const mostRecent = await getMostRecentPlanForThread(threadId);
      const lastPlanAt = mostRecent?.scheduledFor ?? mostRecent?.createdAt ?? null;
      const daysSinceLastPlan = lastPlanAt ? (Date.now() - lastPlanAt.getTime()) / (24 * 60 * 60 * 1000) : Infinity;
      if (daysSinceLastPlan < SERENDIPITY_MIN_DAYS_SINCE_LAST_PLAN) continue;

      if (!(await canSendProactiveMessage(threadId, "serendipity"))) continue;

      const [threadRow] = await db.select({ homeCity: threadsTable.homeCity }).from(threadsTable).where(eq(threadsTable.id, threadId));
      const city = threadRow?.homeCity || DEFAULT_CITY;
      const daysOut = daysUntilNextSaturday();
      const forecast = await getForecastForDay(city, daysOut);
      if (!forecast || !forecast.isGoodWeather) continue;

      const weeksSince = Math.round(daysSinceLastPlan / 7);
      const cadenceLine =
        weeksSince > 0 && Number.isFinite(daysSinceLastPlan)
          ? `you all haven't met up in about ${weeksSince} week${weeksSince === 1 ? "" : "s"}`
          : "it's been a while since you all last got together";
      await sendToThread(
        threadId,
        `${Math.round(forecast.highF)}\u00b0 this Saturday and ${cadenceLine} -- want me to find a spot?`,
      );
      await recordProactiveSend(threadId, "serendipity");
    } catch (error) {
      logger.error({ error, threadId }, "Failed to process serendipity-scan item; continuing with the rest of the batch");
    }
  }
}

/**
 * Sends the one-time stalled-onboarding follow-up DM to a user and marks
 * every disclosed-but-unnudged group membership as nudged, so it can never
 * repeat for this person. Shared by the scheduled scan and the ops
 * dashboard's manual "send nudge now" action so both stay in sync.
 */
export async function sendOnboardingNudge(userId: number): Promise<void> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user || !user.phoneNumber || user.onboardingStatus === "completed") return;

  const { thread } = await findOrCreateDirectThread(user.phoneNumber);

  // Marked before the send: if the process crashes in between, the nudge
  // simply never goes out (fine -- it was one-time and best-effort) rather
  // than risking a duplicate on the next scan or a manual retry.
  await markOnboardingNudgeSentForUser(userId);
  await sendToThread(
    thread.id,
    "No pressure at all -- whenever you get a sec, I'd love to know a bit more about you so I can plan things you'll actually enjoy. Even one quick answer helps!",
  );
}

async function handleOnboardingNudgeScan(): Promise<void> {
  const userIds = await getStalledOnboardingUserIds(ONBOARDING_STALL_THRESHOLD_MS);
  for (const userId of userIds) {
    try {
      await sendOnboardingNudge(userId);
    } catch (error) {
      logger.error({ error, userId }, "Failed to process onboarding-nudge-scan item; continuing with the rest of the batch");
    }
  }
}

export async function scheduleNonVoterNudge(threadId: number, pollId: number): Promise<void> {
  if (!boss) return;
  await boss.sendAfter(QUEUES.pollNudge, { threadId, pollId }, null, NON_VOTER_NUDGE_DELAY_SECONDS);
}

/** Schedules the day-before reminder for a newly-confirmed plan with a known date. */
export async function scheduleDayBeforeReminder(threadId: number, planId: number, scheduledFor: Date): Promise<void> {
  if (!boss) return;
  const reminderAt = new Date(scheduledFor.getTime() - 24 * 60 * 60 * 1000);
  const delaySeconds = Math.max(0, Math.round((reminderAt.getTime() - Date.now()) / 1000));
  await boss.sendAfter(QUEUES.planReminder, { threadId, planId }, null, delaySeconds);
}

async function handleVenueRevalidationScan(): Promise<void> {
  const result = await runRevalidationScan();
  if (result.checked > 0) {
    logger.info({ checked: result.checked, suppressed: result.suppressed }, "Venue revalidation scan complete");
  }
}

export async function initScheduler(): Promise<void> {
  if (boss) return;

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    logger.warn("DATABASE_URL not set; proactive scheduler disabled");
    return;
  }

  await ensureRevalidationConfigSeeded();

  boss = new PgBoss(connectionString);
  boss.on("error", (error: unknown) => logger.error({ error }, "pg-boss error"));

  await boss.start();
  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue);
  }

  await boss.work<PollNudgeJobData>(QUEUES.pollNudge, async (jobs: { data: PollNudgeJobData }[]) => {
    for (const job of jobs) await handlePollNudge(job);
  });
  await boss.work<PollTiebreakJobData>(QUEUES.pollTiebreakAnnounce, async (jobs: { data: PollTiebreakJobData }[]) => {
    for (const job of jobs) await handlePollTiebreakAnnounce(job);
  });
  await boss.work<PollTiebreakJobData>(QUEUES.pollTiebreakLock, async (jobs: { data: PollTiebreakJobData }[]) => {
    for (const job of jobs) await handlePollTiebreakLock(job);
  });
  await boss.work<PlanReminderJobData>(QUEUES.planReminder, async (jobs: { data: PlanReminderJobData }[]) => {
    for (const job of jobs) await handlePlanReminder(job);
  });
  await boss.work(QUEUES.planRevive, async () => {
    await handlePlanRevive();
  });
  await boss.work(QUEUES.feedbackPrompt, async () => {
    await handleFeedbackScan();
  });
  await boss.work(QUEUES.occasionScan, async () => {
    await handleOccasionScan();
  });
  await boss.work(QUEUES.serendipityScan, async () => {
    await handleSerendipityScan();
  });
  await boss.work(QUEUES.onboardingNudge, async () => {
    await handleOnboardingNudgeScan();
  });
  await boss.work(QUEUES.venueRevalidationScan, async () => {
    await handleVenueRevalidationScan();
  });

  await boss.schedule(QUEUES.planRevive, STALLED_SCAN_CRON);
  await boss.schedule(QUEUES.feedbackPrompt, FEEDBACK_SCAN_CRON);
  await boss.schedule(QUEUES.occasionScan, OCCASION_SCAN_CRON);
  await boss.schedule(QUEUES.serendipityScan, SERENDIPITY_SCAN_CRON);
  await boss.schedule(QUEUES.onboardingNudge, ONBOARDING_NUDGE_SCAN_CRON);
  await boss.schedule(QUEUES.venueRevalidationScan, VENUE_REVALIDATION_SCAN_CRON);

  logger.info("Proactive messaging scheduler started");
}
