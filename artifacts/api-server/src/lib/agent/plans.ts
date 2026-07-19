import { and, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { db, plansTable, threadParticipantsTable, threadsTable, type Plan, type Project } from "@workspace/db";
import { getActiveProject } from "./projects";

const ACTIVE_STATUSES = ["proposed", "deciding", "confirmed"] as const;

/**
 * The thread's current conversational-focus plan, if any: the most recently
 * created active plan. Standalone threads have at most one active plan, so
 * this is unambiguous; threads with an active project may have several
 * concurrent child plans, and "most recent" matches what the group is
 * currently talking about. Callers needing every in-flight plan should use
 * `getActivePlansForThread`.
 */
export async function getActivePlan(threadId: number): Promise<Plan | null> {
  const rows = await getActivePlansForThread(threadId);
  return rows[0] ?? null;
}

/** Every in-flight (proposed/deciding/confirmed) plan for a thread, newest first. */
export async function getActivePlansForThread(threadId: number): Promise<Plan[]> {
  return db
    .select()
    .from(plansTable)
    .where(and(eq(plansTable.threadId, threadId), inArray(plansTable.status, [...ACTIVE_STATUSES])))
    .orderBy(desc(plansTable.createdAt));
}

/**
 * Pure scoping rule for which existing active plan (if any) an incoming
 * poll/booking should hang off. Exported for unit tests.
 *
 * - No active project: classic behavior -- reuse the most recent active plan.
 * - Active project: reuse the most recent active child of that project.
 *   A leftover still-forming *standalone* plan (proposed/deciding) is reused
 *   too, but flagged for adoption into the project so the "standalone plans
 *   are singular" rule self-heals (normally adoption already happened at
 *   project creation). A *confirmed* standalone plan is never adopted -- a
 *   locked-in event that predates the project must not be silently
 *   re-labeled as part of it. Active children of a *different*
 *   (older/finished) project are never reused or re-parented either.
 * - Nothing reusable: the caller creates a fresh plan (attached to the
 *   active project when there is one).
 */
export function chooseActivePlanForReuse(
  activePlans: Plan[],
  activeProject: Project | null,
): { plan: Plan | null; needsAdoption: boolean } {
  if (!activeProject) {
    return { plan: activePlans[0] ?? null, needsAdoption: false };
  }
  const child = activePlans.find((plan) => plan.projectId === activeProject.id);
  if (child) return { plan: child, needsAdoption: false };

  const adoptable = activePlans.find(
    (plan) => plan.projectId === null && (plan.status === "proposed" || plan.status === "deciding"),
  );
  if (adoptable) return { plan: adoptable, needsAdoption: true };

  return { plan: null, needsAdoption: false };
}

/**
 * Finds the active plan for the thread's current scope, or creates a fresh
 * "proposed" one anchored to all current thread participants. When the
 * thread has an active project, new plans are attached to it automatically
 * and coexist with the project's other active children.
 */
export async function getOrCreateActivePlan(threadId: number, title: string): Promise<Plan> {
  const [activePlans, activeProject] = await Promise.all([
    getActivePlansForThread(threadId),
    getActiveProject(threadId),
  ]);

  const { plan: reusable, needsAdoption } = chooseActivePlanForReuse(activePlans, activeProject);
  if (reusable) {
    if (needsAdoption && activeProject) {
      const [adopted] = await db
        .update(plansTable)
        .set({ projectId: activeProject.id })
        .where(eq(plansTable.id, reusable.id))
        .returning();
      return adopted ?? reusable;
    }
    return reusable;
  }

  return createPlanInThread(threadId, title, activeProject?.id ?? null);
}

/**
 * Always creates a new active plan as a child of the given project, even if
 * the project already has other active plans -- the explicit coexistence
 * path (a second event of the same occasion, a playbook timeline step, ...).
 */
export async function createPlanInProject(projectId: number, threadId: number, title: string): Promise<Plan> {
  return createPlanInThread(threadId, title, projectId);
}

async function createPlanInThread(threadId: number, title: string, projectId: number | null): Promise<Plan> {
  const participantRows = await db
    .select({ userId: threadParticipantsTable.userId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, threadId));

  const [plan] = await db
    .insert(plansTable)
    .values({
      threadId,
      projectId,
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

/**
 * Confirmed plans scheduled in the next `windowMs` milliseconds that have
 * never received a weather-rescue nudge. These are candidates for the daily
 * weather-rescue scan: if their venue is outdoor and bad weather is forecast,
 * the scanner sends a proactive message suggesting indoor alternatives.
 */
export async function getConfirmedPlansForWeatherCheck(windowMs: number): Promise<Plan[]> {
  const now = new Date();
  const windowEnd = new Date(Date.now() + windowMs);
  const rows = await db
    .select()
    .from(plansTable)
    .where(
      and(
        eq(plansTable.status, "confirmed"),
        gte(plansTable.scheduledFor, now),
        lte(plansTable.scheduledFor, windowEnd),
        isNull(plansTable.weatherRescueSentAt),
      ),
    );
  return rows;
}

/** Records that the weather-rescue nudge has been sent for this plan, so it cannot repeat. */
export async function markPlanWeatherWarned(planId: number): Promise<void> {
  await db.update(plansTable).set({ weatherRescueSentAt: new Date() }).where(eq(plansTable.id, planId));
}

export async function setPendingFeedback(threadId: number, planId: number | null): Promise<void> {
  await db.update(threadsTable).set({ pendingFeedbackPlanId: planId }).where(eq(threadsTable.id, threadId));
}
