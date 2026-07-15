import { and, desc, eq, inArray } from "drizzle-orm";
import { db, plansTable, threadParticipantsTable, threadsTable, type Plan } from "@workspace/db";

const ACTIVE_STATUSES = ["proposed", "deciding", "confirmed"] as const;

/** The thread's current in-flight plan, if any (there is at most one active plan per thread at a time). */
export async function getActivePlan(threadId: number): Promise<Plan | null> {
  const rows = await db
    .select()
    .from(plansTable)
    .where(and(eq(plansTable.threadId, threadId), inArray(plansTable.status, [...ACTIVE_STATUSES])))
    .orderBy(desc(plansTable.createdAt));
  return rows[0] ?? null;
}

/** Finds the active plan, or creates a fresh "proposed" one anchored to all current thread participants. */
export async function getOrCreateActivePlan(threadId: number, title: string): Promise<Plan> {
  const existing = await getActivePlan(threadId);
  if (existing) return existing;

  const participantRows = await db
    .select({ userId: threadParticipantsTable.userId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, threadId));

  const [plan] = await db
    .insert(plansTable)
    .values({
      threadId,
      title,
      attendeeUserIds: participantRows.map((row) => row.userId),
      status: "proposed",
    })
    .returning();
  if (!plan) throw new Error("Failed to create plan");
  return plan;
}

export async function setPlanScheduledFor(planId: number, scheduledFor: Date): Promise<Plan> {
  const [plan] = await db
    .update(plansTable)
    .set({ scheduledFor, status: "deciding" })
    .where(eq(plansTable.id, planId))
    .returning();
  if (!plan) throw new Error(`Plan ${planId} not found`);
  return plan;
}

export async function setPlanVenue(planId: number, venue: string): Promise<Plan> {
  const [plan] = await db.update(plansTable).set({ venue }).where(eq(plansTable.id, planId)).returning();
  if (!plan) throw new Error(`Plan ${planId} not found`);
  return plan;
}

/** Advances a plan to "confirmed". Callers are responsible for calendar delivery and feedback scheduling side effects. */
export async function confirmPlan(planId: number): Promise<Plan> {
  const [plan] = await db
    .update(plansTable)
    .set({ status: "confirmed" })
    .where(eq(plansTable.id, planId))
    .returning();
  if (!plan) throw new Error(`Plan ${planId} not found`);
  return plan;
}

export async function markPlanDone(planId: number): Promise<Plan> {
  const [plan] = await db.update(plansTable).set({ status: "done" }).where(eq(plansTable.id, planId)).returning();
  if (!plan) throw new Error(`Plan ${planId} not found`);
  return plan;
}

/** Most recent plan for a thread regardless of status, for cadence calculations (e.g. "how long since this group last met"). */
export async function getMostRecentPlanForThread(threadId: number): Promise<Plan | null> {
  const rows = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.threadId, threadId))
    .orderBy(desc(plansTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPlanById(planId: number): Promise<Plan | null> {
  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, planId));
  return plan ?? null;
}

/** Plans stuck in "proposed" or "deciding" with no update for at least `staleAfterMs` -- candidates for a revival nudge. */
export async function getStalledPlans(staleAfterMs: number): Promise<Plan[]> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .select()
    .from(plansTable)
    .where(inArray(plansTable.status, ["proposed", "deciding"]));
  return rows.filter((plan) => plan.updatedAt.getTime() < cutoff.getTime());
}

/** Confirmed plans whose scheduledFor date has passed, for post-plan feedback scheduling. */
export async function getPlansNeedingFeedbackPrompt(): Promise<Plan[]> {
  const rows = await db.select().from(plansTable).where(eq(plansTable.status, "confirmed"));
  const now = Date.now();
  return rows.filter((plan) => plan.scheduledFor && plan.scheduledFor.getTime() < now);
}

export async function setPendingFeedback(threadId: number, planId: number | null): Promise<void> {
  await db.update(threadsTable).set({ pendingFeedbackPlanId: planId }).where(eq(threadsTable.id, threadId));
}
