import { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { db, threadParticipantsTable } from "@workspace/db";
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

const QUEUES = {
  pollNudge: "poll-nudge",
  pollTiebreakAnnounce: "poll-tiebreak-announce",
  pollTiebreakLock: "poll-tiebreak-lock",
  planReminder: "plan-reminder",
  planRevive: "plan-revive",
  feedbackPrompt: "feedback-prompt",
  occasionScan: "occasion-scan",
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
    if (!(await canSendProactiveMessage(plan.threadId, "nudge"))) continue;
    await sendToThread(
      plan.threadId,
      `Hey -- "${plan.title}" has been sitting for a bit. Still want to lock something in, or should we drop it?`,
    );
    await recordProactiveSend(plan.threadId, "nudge");
  }
}

async function handleFeedbackScan(): Promise<void> {
  const due = await getPlansNeedingFeedbackPrompt();
  for (const plan of due) {
    // Budget gating runs first and skips the plan entirely if denied -- we
    // must never flag a thread as "awaiting feedback" (which hijacks the
    // user's next reply) unless we actually sent the prompt asking for it.
    // The plan stays "confirmed" so the next scan retries it once budget
    // allows.
    if (!(await canSendProactiveMessage(plan.threadId, "nudge"))) continue;

    await sendToThread(plan.threadId, `How was "${plan.title}"? Reply with a quick rating (1-5) or a few words.`);
    await recordProactiveSend(plan.threadId, "nudge");

    // Only now -- after the prompt was actually sent -- do we mark the plan
    // done and flag the thread so the next inbound reply is captured as the
    // answer to this specific prompt.
    await markPlanDone(plan.id);
    await setPendingFeedback(plan.threadId, plan.id);
  }
}

async function handleOccasionScan(): Promise<void> {
  const due = await getOccasionsDueForReminder(OCCASION_REMINDER_WINDOW_MS);
  for (const occasion of due) {
    // Budget gating first, same reasoning as feedback prompts: never mark an
    // occasion "reminded" unless the message actually went out, so a denied
    // send gets retried on the next daily scan instead of being lost.
    if (!(await canSendProactiveMessage(occasion.threadId, "occasion_reminder"))) continue;

    const daysAway = Math.round((occasion.occasionDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    const when = daysAway <= 0 ? "coming right up" : `in about ${daysAway} day${daysAway === 1 ? "" : "s"}`;
    await sendToThread(
      occasion.threadId,
      `Heads up -- ${occasion.label} is ${when}. Want me to help plan something for it?`,
    );
    await recordProactiveSend(occasion.threadId, "occasion_reminder");
    await markOccasionReminded(occasion.id);
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

export async function initScheduler(): Promise<void> {
  if (boss) return;

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    logger.warn("DATABASE_URL not set; proactive scheduler disabled");
    return;
  }

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

  await boss.schedule(QUEUES.planRevive, STALLED_SCAN_CRON);
  await boss.schedule(QUEUES.feedbackPrompt, FEEDBACK_SCAN_CRON);
  await boss.schedule(QUEUES.occasionScan, OCCASION_SCAN_CRON);

  logger.info("Proactive messaging scheduler started");
}
