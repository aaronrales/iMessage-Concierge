import { and, eq, gte } from "drizzle-orm";
import { db, proactiveMessageSendsTable, threadParticipantsTable, usersTable, type ProactiveMessageSend } from "@workspace/db";

export type ProactiveMessageCategory = "occasion_reminder" | "plan_reminder" | "nudge" | "serendipity";

/**
 * Priority order, highest first. Nothing in Phase 0 consults this ordering
 * directly (no proactive sends exist yet), but it's the contract every later
 * phase's scheduler must follow when multiple candidate messages compete for
 * the same thread's budget.
 */
export const PROACTIVE_CATEGORY_PRIORITY: ProactiveMessageCategory[] = [
  "occasion_reminder",
  "plan_reminder",
  "nudge",
  "serendipity",
];

interface BudgetRule {
  /** Max sends of this category allowed within the rolling window. */
  maxPerWindow: number;
  windowDays: number;
}

// Deliberately conservative defaults -- easy to loosen later, brutal to
// tighten after users have already been burned by over-texting.
const CATEGORY_RULES: Record<ProactiveMessageCategory, BudgetRule> = {
  occasion_reminder: { maxPerWindow: 1, windowDays: 14 },
  plan_reminder: { maxPerWindow: 5, windowDays: 3 },
  nudge: { maxPerWindow: 2, windowDays: 1 },
  serendipity: { maxPerWindow: 1, windowDays: 14 },
};

/** Hard ceiling on total proactive sends into a single thread per day, regardless of category. */
const DAILY_THREAD_CEILING = 3;

function windowStart(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function countSendsSince(threadId: number, since: Date, category?: ProactiveMessageCategory): Promise<number> {
  const rows = await db
    .select()
    .from(proactiveMessageSendsTable)
    .where(
      and(
        eq(proactiveMessageSendsTable.threadId, threadId),
        gte(proactiveMessageSendsTable.sentAt, since),
        ...(category ? [eq(proactiveMessageSendsTable.category, category)] : []),
      ),
    );
  return rows.length;
}

/**
 * Governor check every proactive feature (nudges, reminders, serendipity,
 * occasion surfacing) must call before sending. Returns false if sending now
 * would exceed either the category's own frequency cap or the thread's daily
 * ceiling across all categories.
 */
/**
 * Returns true if any participant in the given thread has opted out via
 * "forget me" (users.doNotContact = true). Group iMessage sends are broadcast
 * to all members, so a single opted-out participant blocks all proactive sends
 * to the whole thread.
 */
async function threadHasOptedOutParticipant(threadId: number): Promise<boolean> {
  const rows = await db
    .select({ doNotContact: usersTable.doNotContact })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(and(eq(threadParticipantsTable.threadId, threadId), eq(usersTable.doNotContact, true)))
    .limit(1);
  return rows.length > 0;
}

export async function canSendProactiveMessage(
  threadId: number,
  category: ProactiveMessageCategory,
): Promise<boolean> {
  const rule = CATEGORY_RULES[category];

  // Never send proactive messages to a thread that contains an opted-out user.
  // Group iMessage cannot target individual recipients, so the entire thread
  // must be suppressed when any member has invoked their right to be forgotten.
  if (await threadHasOptedOutParticipant(threadId)) return false;

  const [categoryCount, dailyCount] = await Promise.all([
    countSendsSince(threadId, windowStart(rule.windowDays), category),
    countSendsSince(threadId, windowStart(1)),
  ]);

  if (categoryCount >= rule.maxPerWindow) return false;
  if (dailyCount >= DAILY_THREAD_CEILING) return false;

  return true;
}

/** Records a proactive send after it goes out, so future budget checks see it. */
export async function recordProactiveSend(
  threadId: number,
  category: ProactiveMessageCategory,
  userId?: number | null,
): Promise<ProactiveMessageSend> {
  const [row] = await db
    .insert(proactiveMessageSendsTable)
    .values({ threadId, category, userId: userId ?? null })
    .returning();
  if (!row) throw new Error("Failed to record proactive message send");
  return row;
}
