import { and, eq, inArray, isNull, desc, isNotNull } from "drizzle-orm";
import {
  db,
  projectTasksTable,
  pollsTable,
  bookingsTable,
  plansTable,
  type Project,
  type ProjectTask,
} from "@workspace/db";
import { getPlaybook, type PlaybookStep } from "./playbooks";
import { logger } from "../logger";

/**
 * Timeline module: instantiates, recomputes, auto-completes, and queries
 * project task timelines derived from playbook templates.
 */

/** Statuses that count as "terminal" for a project task (done = success, skipped = intentional skip). */
const TERMINAL_STATUSES = ["done", "skipped"] as const;

// ── Instantiation ─────────────────────────────────────────────────────────────

/**
 * Computes dueAt for a step given the project's event date (dateRangeStart)
 * and the step's lead time in days. Returns null when no event date is known.
 */
function computeDueAt(eventDate: Date | null, leadTimeDays: number): Date | null {
  if (!eventDate) return null;
  const due = new Date(eventDate.getTime() - leadTimeDays * 24 * 60 * 60 * 1000);
  return due;
}

/**
 * Creates project_tasks rows from the playbook template for the given project.
 * Safe to call on a project that already has tasks (noop for existing steps).
 * Should be called immediately after a project is created (created: true).
 */
export async function instantiateTimeline(project: Project): Promise<ProjectTask[]> {
  const playbook = getPlaybook(project.type);
  if (!playbook) {
    // No playbook for this occasion type -- fine, not all types have templates.
    return [];
  }

  // Check if tasks already exist (guards against double-instantiation races).
  const existing = await db
    .select({ sourceStep: projectTasksTable.sourceStep })
    .from(projectTasksTable)
    .where(eq(projectTasksTable.projectId, project.id));
  const existingKeys = new Set(existing.map((r) => r.sourceStep));

  const eventDate = project.dateRangeStart;
  const stepsToInsert: PlaybookStep[] = playbook.steps.filter((s) => !existingKeys.has(s.key));
  if (stepsToInsert.length === 0) return [];

  const rows = await db
    .insert(projectTasksTable)
    .values(
      stepsToInsert.map((step) => ({
        projectId: project.id,
        title: step.title,
        status: "pending" as const,
        dueAt: computeDueAt(eventDate, step.leadTimeDays),
        sourceStep: step.key,
        actionHint: step.actionHint,
        completionTrigger: step.completionTrigger,
      })),
    )
    .returning();

  logger.info({ projectId: project.id, type: project.type, count: rows.length }, "Timeline instantiated");
  return rows;
}

// ── Recompute due dates ───────────────────────────────────────────────────────

/**
 * When the project's date range changes (e.g. the event date is finally
 * pinned after starting as null, or gets shifted), recomputes dueAt for all
 * pending tasks so they stay anchored to the actual event date.
 *
 * Terminal (done/skipped) tasks are left unchanged to preserve history.
 * Safe to call repeatedly (idempotent when date hasn't changed).
 */
export async function recomputeDueDates(project: Project): Promise<void> {
  const eventDate = project.dateRangeStart;
  const playbook = getPlaybook(project.type);
  if (!playbook) return;

  const pendingTasks = await db
    .select()
    .from(projectTasksTable)
    .where(
      and(
        eq(projectTasksTable.projectId, project.id),
        inArray(projectTasksTable.status, ["pending", "in_progress"]),
      ),
    );

  if (pendingTasks.length === 0) return;

  // Build a map from sourceStep key to lead time, for efficient lookup.
  const leadTimeByKey = new Map<string, number>(playbook.steps.map((s) => [s.key, s.leadTimeDays]));

  await Promise.all(
    pendingTasks.map(async (task) => {
      const leadTimeDays = task.sourceStep ? (leadTimeByKey.get(task.sourceStep) ?? null) : null;
      if (leadTimeDays === null) return;
      const newDueAt = computeDueAt(eventDate, leadTimeDays);
      await db
        .update(projectTasksTable)
        .set({ dueAt: newDueAt })
        .where(eq(projectTasksTable.id, task.id));
    }),
  );

  logger.info({ projectId: project.id, count: pendingTasks.length }, "Timeline due dates recomputed");
}

// ── Auto-completion ───────────────────────────────────────────────────────────

/**
 * Marks steps done when their completionTrigger condition is already satisfied
 * in the thread's underlying state. Called by the daily timeline scanner so
 * auto-completion happens once per day without wiring into every state
 * transition in the system.
 *
 * Trigger conditions (approximate — good enough for planning tool accuracy):
 *   date_poll_closed   → any date-kind poll in the group thread is closed with a winner
 *   venue_poll_closed  → any choice-kind poll in the group thread is closed with a winner
 *   booking_confirmed  → any booking in the thread is confirmed
 *   plan_confirmed     → any plan in the thread is confirmed
 */
export async function autoCompleteSteps(project: Project): Promise<number> {
  const threadId = project.threadId;

  // Load pending tasks that have auto-completion triggers.
  const pending = await db
    .select()
    .from(projectTasksTable)
    .where(
      and(
        eq(projectTasksTable.projectId, project.id),
        inArray(projectTasksTable.status, ["pending", "in_progress"]),
      ),
    );

  const toAutoComplete = pending.filter(
    (t) => t.completionTrigger && t.completionTrigger !== "none",
  );
  if (toAutoComplete.length === 0) return 0;

  // Lazily load signals (only fetch what we need).
  let datePollClosed: boolean | null = null;
  let venuePollClosed: boolean | null = null;
  let bookingConfirmed: boolean | null = null;
  let planConfirmed: boolean | null = null;

  // ── Project-scoped trigger checks ────────────────────────────────────────
  // All checks are scoped to the CURRENT project, not the thread, to avoid
  // historical polls/bookings/plans from prior projects on the same thread
  // incorrectly auto-completing steps on a newly created project.
  //
  // Polls and bookings link to plans via planId (nullable FK). We only
  // auto-complete when that FK is set and the linked plan belongs to this
  // project. If planId is null (orphan poll/booking not tied to a plan),
  // we conservatively skip auto-completion — a false negative is safe, a
  // false positive would be a silent data corruption.

  const checkDatePollClosed = async (): Promise<boolean> => {
    if (datePollClosed !== null) return datePollClosed;
    // Join polls → plans to ensure the poll belongs to a child plan of this project.
    const rows = await db
      .select({ id: pollsTable.id })
      .from(pollsTable)
      .innerJoin(plansTable, eq(pollsTable.planId, plansTable.id))
      .where(
        and(
          eq(plansTable.projectId, project.id),
          eq(pollsTable.kind, "date"),
          eq(pollsTable.status, "closed"),
          isNotNull(pollsTable.planId),
        ),
      )
      .limit(1);
    datePollClosed = rows.length > 0;
    return datePollClosed;
  };

  const checkVenuePollClosed = async (): Promise<boolean> => {
    if (venuePollClosed !== null) return venuePollClosed;
    const rows = await db
      .select({ id: pollsTable.id })
      .from(pollsTable)
      .innerJoin(plansTable, eq(pollsTable.planId, plansTable.id))
      .where(
        and(
          eq(plansTable.projectId, project.id),
          eq(pollsTable.kind, "choice"),
          eq(pollsTable.status, "closed"),
          isNotNull(pollsTable.planId),
        ),
      )
      .limit(1);
    venuePollClosed = rows.length > 0;
    return venuePollClosed;
  };

  const checkBookingConfirmed = async (): Promise<boolean> => {
    if (bookingConfirmed !== null) return bookingConfirmed;
    // Bookings link to plans via planId; join to check project membership.
    const rows = await db
      .select({ id: bookingsTable.id })
      .from(bookingsTable)
      .innerJoin(plansTable, eq(bookingsTable.planId, plansTable.id))
      .where(
        and(
          eq(plansTable.projectId, project.id),
          eq(bookingsTable.status, "confirmed"),
          isNotNull(bookingsTable.planId),
        ),
      )
      .limit(1);
    bookingConfirmed = rows.length > 0;
    return bookingConfirmed;
  };

  const checkPlanConfirmed = async (): Promise<boolean> => {
    if (planConfirmed !== null) return planConfirmed;
    // Plans carry projectId directly — no join needed.
    const rows = await db
      .select({ id: plansTable.id })
      .from(plansTable)
      .where(
        and(
          eq(plansTable.projectId, project.id),
          eq(plansTable.status, "confirmed"),
        ),
      )
      .limit(1);
    planConfirmed = rows.length > 0;
    return planConfirmed;
  };

  let completed = 0;
  for (const task of toAutoComplete) {
    let shouldComplete = false;
    switch (task.completionTrigger) {
      case "date_poll_closed":
        shouldComplete = await checkDatePollClosed();
        break;
      case "venue_poll_closed":
        shouldComplete = await checkVenuePollClosed();
        break;
      case "booking_confirmed":
        shouldComplete = await checkBookingConfirmed();
        break;
      case "plan_confirmed":
        shouldComplete = await checkPlanConfirmed();
        break;
    }

    if (shouldComplete) {
      await db
        .update(projectTasksTable)
        .set({ status: "done", completedAt: new Date() })
        .where(eq(projectTasksTable.id, task.id));
      completed++;
    }
  }

  if (completed > 0) {
    logger.info({ projectId: project.id, completed }, "Timeline steps auto-completed");
  }
  return completed;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/** All tasks for a project, ordered by dueAt ascending (nulls last), then by creation order. */
export async function getProjectTimeline(projectId: number): Promise<ProjectTask[]> {
  const all = await db
    .select()
    .from(projectTasksTable)
    .where(eq(projectTasksTable.projectId, projectId))
    .orderBy(projectTasksTable.createdAt); // creation order = playbook order

  // Sort: tasks with dueAt first (ascending), then undated tasks in playbook order.
  return all.sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return 0;
  });
}

/**
 * Returns the NEXT actionable step for organizer nudging, enforcing two
 * invariants that prevent premature or out-of-order nudges:
 *
 * 1. **Sequencing**: only the first pending step in playbook order (earliest
 *    dueAt, then creation order for ties) is a nudge candidate. Later steps
 *    cannot be nudged while an earlier step is still pending, even if they
 *    have entered their own lead window.
 *
 * 2. **Due-date gate**: the candidate step must have a real dueAt that falls
 *    within the nudge lookahead window. Steps without a dueAt (project has no
 *    event date yet) are NEVER actionable — nudging before dates are set would
 *    permanently suppress the step (via notifiedAt) before the real timeline
 *    even begins.
 *
 * The step must also not have been notified yet (notifiedAt IS NULL).
 */
export async function getNextActionableStep(
  projectId: number,
  lookaheadMs: number = 14 * 24 * 60 * 60 * 1000,
): Promise<ProjectTask | null> {
  const windowEnd = new Date(Date.now() + lookaheadMs);

  // Fetch all pending steps in playbook/creation order to enforce sequencing.
  const all = await db
    .select()
    .from(projectTasksTable)
    .where(
      and(
        eq(projectTasksTable.projectId, projectId),
        inArray(projectTasksTable.status, ["pending", "in_progress"]),
      ),
    )
    .orderBy(projectTasksTable.createdAt);

  // Sort: dated steps before undated, earliest-due first.
  const sorted = all.sort((a, b) => {
    if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return 0;
  });

  // The FIRST pending step in playbook order is the only candidate.
  // We check it (and only it) against both gates.
  const candidate = sorted[0];
  if (!candidate) return null;

  // Gate 1: must not already have been notified.
  if (candidate.notifiedAt !== null) return null;

  // Gate 2: must have a real due date (project has event date set).
  if (!candidate.dueAt) return null;

  // Gate 3: must be within the nudge lookahead window (due date is approaching).
  if (candidate.dueAt > windowEnd) return null;

  return candidate;
}

/** Marks a step as notified (so it won't be nudged again). */
export async function markStepNotified(taskId: number): Promise<void> {
  await db
    .update(projectTasksTable)
    .set({ notifiedAt: new Date() })
    .where(eq(projectTasksTable.id, taskId));
}

/** Marks a step as done. */
export async function markStepDone(taskId: number): Promise<void> {
  await db
    .update(projectTasksTable)
    .set({ status: "done", completedAt: new Date() })
    .where(eq(projectTasksTable.id, taskId));
}

// ── Summary helpers ───────────────────────────────────────────────────────────

export interface TimelineSummary {
  total: number;
  done: number;
  /** The next pending step (earliest by due date), or null if all done/skipped. */
  nextStep: { title: string; dueAt: Date | null } | null;
}

/** Compact summary for API responses, dashboard display, and engine prompt injection. */
export async function getTimelineSummary(projectId: number): Promise<TimelineSummary | null> {
  const tasks = await getProjectTimeline(projectId);
  if (tasks.length === 0) return null;

  const done = tasks.filter((t) => TERMINAL_STATUSES.includes(t.status as typeof TERMINAL_STATUSES[number])).length;
  const pending = tasks.filter((t) => !TERMINAL_STATUSES.includes(t.status as typeof TERMINAL_STATUSES[number]));

  const next = pending[0] ?? null;
  return {
    total: tasks.length,
    done,
    nextStep: next ? { title: next.title, dueAt: next.dueAt } : null,
  };
}

/**
 * Builds the timeline section for the engine system-prompt block so the LLM
 * can answer "where are we on the bachelorette?" accurately.
 */
export async function buildTimelinePromptSection(projectId: number): Promise<string | null> {
  const tasks = await getProjectTimeline(projectId);
  if (tasks.length === 0) return null;

  const lines = tasks.map((t) => {
    const dueStr = t.dueAt ? ` (due ${t.dueAt.toISOString().slice(0, 10)})` : "";
    return `  - [${t.status}] ${t.title}${dueStr}`;
  });

  const done = tasks.filter((t) => TERMINAL_STATUSES.includes(t.status as typeof TERMINAL_STATUSES[number])).length;
  return `Occasion timeline (${done} of ${tasks.length} steps done):\n${lines.join("\n")}`;
}

// ── Active projects with timelines (for the scheduler) ────────────────────────

/**
 * Returns all active projects that have at least one instantiated timeline
 * step. Used by the daily scanner to know which projects need attention.
 */
export async function getActiveProjectsWithTimelines(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ projectId: projectTasksTable.projectId })
    .from(projectTasksTable)
    .where(inArray(projectTasksTable.status, ["pending", "in_progress"]));
  return rows.map((r) => r.projectId);
}
