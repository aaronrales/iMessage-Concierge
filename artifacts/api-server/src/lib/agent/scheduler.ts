import { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { db, threadParticipantsTable } from "@workspace/db";
import { logger } from "../logger";
import { canSendProactiveMessage, recordProactiveSend } from "./messagingBudget";
import { sendToThread } from "./delivery";
import { getOpenPoll, countDistinctVoters } from "./polls";
import { getPlanById, getStalledPlans, getPlansNeedingFeedbackPrompt, setPendingFeedback, markPlanDone } from "./plans";
import { buildGoogleCalendarLink, describePlanSchedule } from "./calendar";

const QUEUES = {
  pollNudge: "poll-nudge",
  planReminder: "plan-reminder",
  planRevive: "plan-revive",
  feedbackPrompt: "feedback-prompt",
} as const;

const NON_VOTER_NUDGE_DELAY_SECONDS = 4 * 60 * 60; // 4 hours after a poll opens
const STALLED_PLAN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours with no movement
const STALLED_SCAN_CRON = "0 * * * *"; // hourly
const FEEDBACK_SCAN_CRON = "*/30 * * * *"; // every 30 minutes

let boss: PgBoss | null = null;

interface PollNudgeJobData {
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
  if (voterCount >= participantRows.length) return; // everyone already voted

  if (!(await canSendProactiveMessage(data.threadId, "nudge"))) return;

  await sendToThread(
    data.threadId,
    `Friendly nudge -- still waiting on ${participantRows.length - voterCount} of you for "${open.poll.question}". Reply with your pick when you get a sec.`,
  );
  await recordProactiveSend(data.threadId, "nudge");
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
  await boss.work<PlanReminderJobData>(QUEUES.planReminder, async (jobs: { data: PlanReminderJobData }[]) => {
    for (const job of jobs) await handlePlanReminder(job);
  });
  await boss.work(QUEUES.planRevive, async () => {
    await handlePlanRevive();
  });
  await boss.work(QUEUES.feedbackPrompt, async () => {
    await handleFeedbackScan();
  });

  await boss.schedule(QUEUES.planRevive, STALLED_SCAN_CRON);
  await boss.schedule(QUEUES.feedbackPrompt, FEEDBACK_SCAN_CRON);

  logger.info("Proactive messaging scheduler started");
}
