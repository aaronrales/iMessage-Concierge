import { PgBoss } from "pg-boss";
import { eq, inArray } from "drizzle-orm";
import { db, profilesTable, projectsTable, threadParticipantsTable, threadsTable, usersTable, PROJECT_ACTIVE_STATUSES } from "@workspace/db";
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
  getConfirmedPlansForWeatherCheck,
  getMostRecentPlanForThread,
  getPlanById,
  getStalledPlans,
  getPlansNeedingFeedbackPrompt,
  markPlanWeatherWarned,
  setPendingFeedback,
  markPlanDone,
  setPlanVenue,
  setPlanScheduledFor,
} from "./plans";
import { isVenueOutdoor, lookupIndoorAlternatives } from "./venueCorpus/lookup";
import { buildGoogleCalendarLink, describePlanSchedule, CONCIERGE_TIMEZONE } from "./calendar";
import { getOccasionsDueForReminder, markOccasionReminded } from "./occasions";
import {
  findOrCreateDirectThread,
  getAllGroupThreadIds,
  getStalledOnboardingUserIds,
  markOnboardingNudgeSentForUser,
  threadHasOptedOutParticipant,
} from "./context";
import {
  autoCompleteSteps,
  getActiveProjectsWithTimelines,
  getNextActionableStep,
  markStepNotified,
} from "./projectTimeline";
import { getActiveProject, getOrganizerForProject } from "./projects";
import { buildTimelineNudgeMessage } from "./playbooks";
import {
  getOutstandingBalancesForNudge,
  buildPaymentRequestMessage,
  formatDollars,
  markPaymentNudgeSent,
} from "./ledger";
import { getOnboardingStep } from "./onboarding";
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
  weatherRescueScan: "weather-rescue-scan",
  projectTimelineScan: "project-timeline-scan",
  paymentNudgeScan: "payment-nudge-scan",
} as const;

const NON_VOTER_NUDGE_DELAY_SECONDS = 4 * 60 * 60; // 4 hours after a poll opens
// Tiebreaker persona: if a poll is still unresolved 4 hours after the soft
// nudge (8h total), the concierge makes a confident call instead of nudging
// forever. The pick then locks in after a 1-hour objection window.
const TIEBREAK_ANNOUNCE_DELAY_SECONDS = 4 * 60 * 60;
const TIEBREAK_OBJECTION_WINDOW_SECONDS = 60 * 60;
const STALLED_PLAN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours with no movement
const STALLED_SCAN_CRON = "0 * * * *"; // hourly (timezone-agnostic)
const FEEDBACK_SCAN_CRON = "*/30 * * * *"; // every 30 minutes (timezone-agnostic)
// Times below are in CONCIERGE_TIMEZONE (America/New_York by default) thanks
// to the `tz` option passed to boss.schedule(). 10am local = good morning
// window for occasion and serendipity nudges; 9am local for background jobs.
const OCCASION_SCAN_CRON = "0 10 * * *"; // daily at 10:00 local
const OCCASION_REMINDER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // ~2 weeks out
const SERENDIPITY_SCAN_CRON = "0 16 * * *"; // daily at 16:00 local
const ONBOARDING_NUDGE_SCAN_CRON = "*/30 * * * *"; // every 30 minutes (timezone-agnostic)
const ONBOARDING_STALL_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours with no reply to the onboarding DM
// Runs daily, but `getVenuesDueForRevalidation` only returns venues whose
// own type's cadence (monthly for restaurants/bars, see
// `venueTypeRevalidationConfigTable`) has actually elapsed -- daily is just
// how often we check whether anything has come due, not the cadence itself.
const VENUE_REVALIDATION_SCAN_CRON = "0 9 * * *"; // daily at 09:00 local
// Runs daily in the morning so groups get weather warnings well before the
// plan day. Checks all confirmed outdoor plans scheduled within the next 48
// hours; each plan is warned at most once (guarded by `weatherRescueSentAt`).
const WEATHER_RESCUE_SCAN_CRON = "0 8 * * *"; // daily at 08:00 local
const WEATHER_RESCUE_WINDOW_MS = 48 * 60 * 60 * 1000; // plans in next 48 hours
const WEATHER_RESCUE_PRECIPITATION_THRESHOLD = 60; // % probability of precipitation
// Timeline scan: runs daily at 9am local. Finds steps entering their 14-day
// lead window, auto-completes steps whose trigger condition is met, and sends
// a nudge to the organizer's sidebar DM for actionable steps.
const PROJECT_TIMELINE_SCAN_CRON = "0 9 * * *"; // daily at 09:00 local
const TIMELINE_NUDGE_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000; // 14-day lead window
// Payment nudge scan: once per day after the morning digest window. Sends
// gentle per-member reminders for outstanding balances past the 3-day grace
// period. Category budget (1 per 5 days) prevents nagging.
const PAYMENT_NUDGE_SCAN_CRON = "0 11 * * *"; // daily at 11:00 local
// A group has to have gone quiet for a real stretch before an unprompted
// suggestion is worth the interruption -- this is what keeps it feeling
// rare and well-timed instead of naggy.
const SERENDIPITY_MIN_DAYS_SINCE_LAST_PLAN = 21;

// ── Quiet-hours helpers ────────────────────────────────────────────────────
// Delayed messages (poll nudge, tiebreak, day-before reminder) should not
// arrive at 3am. Any target time that falls in the quiet window (10pm–8am
// in CONCIERGE_TIMEZONE) is pushed forward to 9am the next morning.

const QUIET_HOURS_START = 22; // 10pm local — no sends after this
const QUIET_HOURS_END = 8; // 8am local — no sends before this
const QUIET_CLAMP_HOUR = 9; // push to 9am when outside the window

/**
 * If `target` falls outside the 8am–10pm window in `timezone`, returns the
 * next 9am in that timezone. Otherwise returns `target` unchanged.
 */
export function clampToQuietHours(target: Date, timezone: string): Date {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(target),
    10,
  );

  if (hour >= QUIET_HOURS_END && hour < QUIET_HOURS_START) return target;

  // Get the local date components so we can build a "9am on the right day".
  const localParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(target);

  const year = parseInt(localParts.find((p) => p.type === "year")!.value, 10);
  const month = parseInt(localParts.find((p) => p.type === "month")!.value, 10);
  const day = parseInt(localParts.find((p) => p.type === "day")!.value, 10);

  // After 10pm → next morning. Before 8am → same morning.
  const dayOffset = hour >= QUIET_HOURS_START ? 1 : 0;

  // Build the UTC timestamp that corresponds to QUIET_CLAMP_HOUR:00 local time
  // on the target day using a round-trip technique (handles DST correctly to
  // within the nearest hour, which is more than precise enough here).
  const naiveUtc = new Date(Date.UTC(year, month - 1, day + dayOffset, QUIET_CLAMP_HOUR, 0, 0));
  const naiveLocal = new Date(naiveUtc.toLocaleString("en-US", { timeZone: timezone }));
  const offsetMs = naiveUtc.getTime() - naiveLocal.getTime();
  return new Date(naiveUtc.getTime() + offsetMs);
}

/**
 * Converts a relative `delaySeconds` value into a quiet-hours-safe delay.
 * Computes the absolute target time, clamps it if needed, and returns the
 * new delay in seconds (always ≥ 0).
 */
function clampedDelaySeconds(delaySeconds: number): number {
  const target = new Date(Date.now() + delaySeconds * 1000);
  const clamped = clampToQuietHours(target, CONCIERGE_TIMEZONE);
  return Math.max(0, Math.round((clamped.getTime() - Date.now()) / 1000));
}

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
      clampedDelaySeconds(TIEBREAK_ANNOUNCE_DELAY_SECONDS),
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

  // Opted-out participants in the thread must not receive proactive messages
  // even via the tiebreak path (which bypasses canSendProactiveMessage).
  if (await threadHasOptedOutParticipant(data.threadId)) return;

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
      clampedDelaySeconds(TIEBREAK_OBJECTION_WINDOW_SECONDS),
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

  // Opted-out participants must not receive the lock-in announcement.
  if (await threadHasOptedOutParticipant(data.threadId)) return;

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

      // For birthdays and anniversaries landing today (daysAway ≤ 0), send
      // the reminder with balloons so it feels like a proper celebration
      // greeting rather than a dry calendar alert.
      const isToday = daysAway <= 0;
      const isCelebration = occasion.kind === "birthday" || occasion.kind === "anniversary";
      const occasionSendStyle = isToday && isCelebration ? "balloons" : undefined;

      await sendToThread(
        occasion.threadId,
        `Heads up -- ${occasion.label} is ${when}. Want me to help plan something for it?`,
        undefined,
        occasionSendStyle,
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

  // Load the profile so we can determine which step the user stalled on and
  // re-ask exactly that question rather than sending a generic check-in.
  const [profile] = await db
    .select({ budget: profilesTable.budget, dietaryNeeds: profilesTable.dietaryNeeds, preferences: profilesTable.preferences })
    .from(profilesTable)
    .where(eq(profilesTable.userId, userId));

  const step = getOnboardingStep(user.onboardingStatus, user.displayName, profile ?? null);

  // Build a nudge message specific to the step the user went quiet on.
  const name = user.displayName;
  let nudgeMessage: string;
  switch (step) {
    case 0:
      // not_started -- shouldn't happen here (scan only returns in_progress),
      // but safe to handle: re-send the opener.
      nudgeMessage = "Still there? What should I call you?";
      break;
    case 1:
      // Waiting for name.
      nudgeMessage = "Still there? What should I call you?";
      break;
    case 2:
      // Have name, waiting for practical constraint.
      nudgeMessage = name
        ? `Still there, ${name}? Any dietary needs or budget range I should keep in mind for suggestions?`
        : "Still there? Any dietary needs or budget range I should keep in mind for suggestions?";
      break;
    case 3:
      // Have practical, waiting for personality signal.
      nudgeMessage = name
        ? `Still there, ${name}? Last thing -- what's your go-to cuisine or vibe when you want a good night out?`
        : "Still there? Last thing -- what's your go-to cuisine or vibe when you want a good night out?";
      break;
    default:
      // "complete" -- profile is fully filled but status wasn't marked yet.
      // Nothing useful to nudge about; skip.
      return;
  }

  const { thread } = await findOrCreateDirectThread(user.phoneNumber);

  // Marked before the send: if the process crashes in between, the nudge
  // simply never goes out (fine -- it was one-time and best-effort) rather
  // than risking a duplicate on the next scan or a manual retry.
  await markOnboardingNudgeSentForUser(userId);
  await sendToThread(thread.id, nudgeMessage);
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
  await boss.sendAfter(QUEUES.pollNudge, { threadId, pollId }, null, clampedDelaySeconds(NON_VOTER_NUDGE_DELAY_SECONDS));
}

/** Schedules the day-before reminder for a newly-confirmed plan with a known date. */
export async function scheduleDayBeforeReminder(threadId: number, planId: number, scheduledFor: Date): Promise<void> {
  if (!boss) return;
  const reminderAt = clampToQuietHours(
    new Date(scheduledFor.getTime() - 24 * 60 * 60 * 1000),
    CONCIERGE_TIMEZONE,
  );
  const delaySeconds = Math.max(0, Math.round((reminderAt.getTime() - Date.now()) / 1000));
  await boss.sendAfter(QUEUES.planReminder, { threadId, planId }, null, delaySeconds);
}

/**
 * Daily scan: for every confirmed plan scheduled in the next 48 hours where
 * the venue has a confirmed outdoor / patio attribute, checks Open-Meteo. If
 * precipitation probability exceeds WEATHER_RESCUE_PRECIPITATION_THRESHOLD,
 * sends a proactive message naming 2–3 indoor alternatives from the corpus
 * and asking whether the group wants to switch. Fires at most once per plan
 * (guarded by `weatherRescueSentAt`).
 */
async function handleWeatherRescueScan(): Promise<void> {
  const plans = await getConfirmedPlansForWeatherCheck(WEATHER_RESCUE_WINDOW_MS);

  for (const plan of plans) {
    try {
      if (!plan.venue || !plan.scheduledFor) continue;

      // Only outdoor / patio venues need a weather rescue nudge.
      const outdoor = await isVenueOutdoor(plan.venue);
      if (!outdoor) continue;

      const [threadRow] = await db
        .select({ homeCity: threadsTable.homeCity })
        .from(threadsTable)
        .where(eq(threadsTable.id, plan.threadId));
      const city = threadRow?.homeCity || DEFAULT_CITY;

      const msUntilPlan = plan.scheduledFor.getTime() - Date.now();
      const daysOut = Math.max(0, Math.round(msUntilPlan / (24 * 60 * 60 * 1000)));
      const forecast = await getForecastForDay(city, daysOut);
      if (!forecast) continue;
      if (forecast.precipitationChance < WEATHER_RESCUE_PRECIPITATION_THRESHOLD) continue;

      if (!(await canSendProactiveMessage(plan.threadId, "nudge"))) continue;

      const alternatives = await lookupIndoorAlternatives(city, plan.venue, 3);
      const altText =
        alternatives.length > 0
          ? ` A few covered options nearby: ${alternatives.map((r) => r.venue.name).join(", ")}.`
          : "";

      // Mark before send: a crash between here and the send skips the nudge
      // for this plan rather than risking a duplicate on the next scan.
      await markPlanWeatherWarned(plan.id);

      try {
        const dateStr = plan.scheduledFor.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: CONCIERGE_TIMEZONE,
        });
        await sendToThread(
          plan.threadId,
          `Heads up -- there's a ${forecast.precipitationChance}% chance of rain on ${dateStr} and "${plan.venue}" has outdoor seating.${altText} Want me to find a covered spot instead?`,
        );
        await recordProactiveSend(plan.threadId, "nudge");
      } catch (sendError) {
        logger.error({ sendError, planId: plan.id }, "Weather-rescue send failed after marking; nudge will not retry");
        throw sendError;
      }
    } catch (error) {
      logger.error({ error, planId: plan.id, threadId: plan.threadId }, "Failed to process weather-rescue item; continuing with rest of batch");
    }
  }
}

async function handleVenueRevalidationScan(): Promise<void> {
  const result = await runRevalidationScan();
  if (result.checked > 0) {
    logger.info({ checked: result.checked, suppressed: result.suppressed }, "Venue revalidation scan complete");
  }
}

/**
 * Daily scan: for each active project with outstanding balances past the
 * grace period, sends a gentle payment nudge to each unpaid member's 1:1 DM.
 *
 * Budget-gated under `payment_nudge` (1 per 5 days per member thread).
 * Mark-before-send ordering (fail toward under-send).
 *
 * The agent never implies it holds funds. Nudge text is friendly, not
 * debt-collector language.
 */
async function handlePaymentNudgeScan(): Promise<void> {
  const outstanding = await getOutstandingBalancesForNudge();
  if (outstanding.length === 0) return;

  logger.info({ count: outstanding.length }, "Payment nudge scan: outstanding balances found");

  for (const item of outstanding) {
    try {
      const { member, organizerName, organizerPhone } = item;

      // Find / create the member's 1:1 thread.
      const { thread: memberThread } = await findOrCreateDirectThread(member.phoneNumber);

      // Budget gate.
      if (!(await canSendProactiveMessage(memberThread.id, "payment_nudge"))) continue;

      // Mark before send (fail toward under-send).
      await markPaymentNudgeSent(item.projectId, member.userId);

      // Friendly nudge — not a full payment-request (that already went out).
      const amount = formatDollars(member.outstandingCents);
      const nudgeText =
        organizerName
          ? `Hey — just a reminder that ${amount} is still outstanding with ${organizerName} for the trip. Whenever you get a chance!`
          : `Hey — just a reminder that ${amount} is still outstanding for the trip. Whenever you get a chance!`;

      await sendToThread(memberThread.id, nudgeText);
      await recordProactiveSend(memberThread.id, "payment_nudge", member.userId);

      logger.info(
        { projectId: item.projectId, userId: member.userId, outstandingCents: member.outstandingCents },
        "Payment nudge sent to member",
      );
    } catch (error) {
      logger.error(
        { error, projectId: item.projectId, userId: item.member.userId },
        "Failed to send payment nudge; continuing with rest of batch",
      );
    }
  }
}

/**
 * Daily scan: for every active project with an instantiated timeline,
 * auto-completes steps whose trigger condition is met, then nudges the
 * organizer's sidebar DM for any step that has entered its 14-day lead
 * window and hasn't been notified yet.
 *
 * Nudges flow through the messaging-budget governor under `timeline_nudge`
 * (2 per 3 days per thread) and are clamped to quiet hours.
 *
 * Design note: the scheduler sends to the ORGANIZER's 1:1 thread, not the
 * group thread, so the group budget is unaffected. The organizer thread id
 * is found by looking up the organizer's phone via getOrganizerForProject
 * and calling findOrCreateDirectThread.
 */
async function handleProjectTimelineScan(): Promise<void> {
  const projectIds = await getActiveProjectsWithTimelines();
  if (projectIds.length === 0) return;

  logger.info({ count: projectIds.length }, "Project timeline scan: checking projects");

  for (const projectId of projectIds) {
    try {
      const [proj] = await db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.id, projectId));
      if (!proj) continue;
      if (!PROJECT_ACTIVE_STATUSES.includes(proj.status as typeof PROJECT_ACTIVE_STATUSES[number])) continue;

      // 1. Auto-complete steps whose trigger condition is satisfied.
      await autoCompleteSteps(proj);

      // 2. Find the next step entering its lead window.
      const step = await getNextActionableStep(projectId, TIMELINE_NUDGE_LOOKAHEAD_MS);
      if (!step) continue;

      // 3. Route the nudge to the organizer's sidebar DM.
      if (!proj.organizerUserId) {
        // No organizer set — mark as notified so this step doesn't re-fire
        // on every scan, but don't send anything (nobody to notify).
        await markStepNotified(step.id);
        continue;
      }

      const organizer = await getOrganizerForProject(proj);
      if (!organizer?.phoneNumber) {
        await markStepNotified(step.id);
        continue;
      }

      const { thread: orgThread } = await findOrCreateDirectThread(organizer.phoneNumber);

      // Budget gate: use the organizer's 1:1 thread id.
      if (!(await canSendProactiveMessage(orgThread.id, "timeline_nudge"))) continue;

      // Mark before send (fail toward under-send, per project convention).
      await markStepNotified(step.id);

      const nudgeText = buildTimelineNudgeMessage(step.title, step.dueAt, step.actionHint ?? "");
      await sendToThread(orgThread.id, nudgeText);
      await recordProactiveSend(orgThread.id, "timeline_nudge");

      logger.info(
        { projectId, stepId: step.id, sourceStep: step.sourceStep, organizerUserId: proj.organizerUserId },
        "Timeline nudge sent to organizer sidebar",
      );
    } catch (error) {
      logger.error({ error, projectId }, "Failed to process project timeline scan item; continuing with rest of batch");
    }
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
  await boss.work(QUEUES.weatherRescueScan, async () => {
    await handleWeatherRescueScan();
  });
  await boss.work(QUEUES.projectTimelineScan, async () => {
    await handleProjectTimelineScan();
  });
  await boss.work(QUEUES.paymentNudgeScan, async () => {
    await handlePaymentNudgeScan();
  });

  // All time-of-day crons are interpreted in CONCIERGE_TIMEZONE so reminders
  // fire at the right local time regardless of where the server is hosted.
  const tzOpt = { tz: CONCIERGE_TIMEZONE };
  await boss.schedule(QUEUES.planRevive, STALLED_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.feedbackPrompt, FEEDBACK_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.occasionScan, OCCASION_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.serendipityScan, SERENDIPITY_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.onboardingNudge, ONBOARDING_NUDGE_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.venueRevalidationScan, VENUE_REVALIDATION_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.weatherRescueScan, WEATHER_RESCUE_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.projectTimelineScan, PROJECT_TIMELINE_SCAN_CRON, {}, tzOpt);
  await boss.schedule(QUEUES.paymentNudgeScan, PAYMENT_NUDGE_SCAN_CRON, {}, tzOpt);

  logger.info("Proactive messaging scheduler started");
}
