import { and, eq, gte, isNull, lt, or } from "drizzle-orm";
import { db, projectTasksTable, usersTable, threadParticipantsTable, projectsTable, PROJECT_ACTIVE_STATUSES } from "@workspace/db";
import { sql, inArray } from "drizzle-orm";
import { logger } from "../logger";

/**
 * Action-item module: organizer-created tasks (source = "manual") that live
 * alongside the playbook timeline but are driven entirely by conversation.
 *
 * These are the "Jake needs to book the party bus by Thursday" items the
 * organizer dictates in their sidebar DM. They have owners, optional due dates,
 * and generate a 24h-before nudge to the owner's 1:1 thread.
 */

// ── Write helpers ──────────────────────────────────────────────────────────────

/**
 * Creates a new organizer-dictated action item for a project.
 * Always sets source = "manual" so it is distinguishable from playbook steps.
 */
export async function createActionItem(
  projectId: number,
  title: string,
  ownerUserId: number | null,
  dueAt: Date | null,
): Promise<void> {
  await db.insert(projectTasksTable).values({
    projectId,
    title,
    status: "pending",
    ownerUserId,
    dueAt,
    source: "manual",
  });
  logger.info({ projectId, title, ownerUserId, dueAt }, "Action item created");
}

/**
 * Closes an action item by title (case-insensitive partial match).
 * Updates status → done and sets completedAt. Matches only manual items
 * that are not already terminal.
 */
export async function closeActionItem(
  projectId: number,
  titleQuery: string,
): Promise<boolean> {
  const normalized = titleQuery.trim().toLowerCase();
  if (!normalized) return false;

  const items = await db
    .select({ id: projectTasksTable.id, title: projectTasksTable.title })
    .from(projectTasksTable)
    .where(
      and(
        eq(projectTasksTable.projectId, projectId),
        eq(projectTasksTable.source, "manual"),
        or(
          eq(projectTasksTable.status, "pending"),
          eq(projectTasksTable.status, "in_progress"),
        ),
      ),
    );

  // Find best match: exact first, then partial.
  const exact = items.find((i) => i.title.trim().toLowerCase() === normalized);
  const partial = items.find((i) => {
    const t = i.title.trim().toLowerCase();
    return t.includes(normalized) || normalized.includes(t);
  });
  const match = exact ?? partial;
  if (!match) return false;

  await db
    .update(projectTasksTable)
    .set({ status: "done", completedAt: new Date() })
    .where(eq(projectTasksTable.id, match.id));

  logger.info({ projectId, taskId: match.id, title: match.title }, "Action item closed");
  return true;
}

/**
 * Returns all open (non-terminal) manual action items for a project,
 * ordered by due date ascending (nulls last), then by creation date.
 */
export async function getOpenActionItems(
  projectId: number,
): Promise<
  {
    id: number;
    title: string;
    status: string;
    ownerUserId: number | null;
    ownerName: string | null;
    dueAt: Date | null;
    createdAt: Date;
  }[]
> {
  const rows = await db
    .select({
      id: projectTasksTable.id,
      title: projectTasksTable.title,
      status: projectTasksTable.status,
      ownerUserId: projectTasksTable.ownerUserId,
      ownerName: usersTable.displayName,
      dueAt: projectTasksTable.dueAt,
      createdAt: projectTasksTable.createdAt,
    })
    .from(projectTasksTable)
    .leftJoin(usersTable, eq(projectTasksTable.ownerUserId, usersTable.id))
    .where(
      and(
        eq(projectTasksTable.projectId, projectId),
        eq(projectTasksTable.source, "manual"),
        or(
          eq(projectTasksTable.status, "pending"),
          eq(projectTasksTable.status, "in_progress"),
        ),
      ),
    )
    .orderBy(
      sql`${projectTasksTable.dueAt} ASC NULLS LAST, ${projectTasksTable.createdAt} ASC`,
    );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    ownerUserId: r.ownerUserId,
    ownerName: r.ownerName ?? null,
    dueAt: r.dueAt,
    createdAt: r.createdAt,
  }));
}

/** Count of open manual action items for a project. */
export async function countOpenActionItems(projectId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(projectTasksTable)
    .where(
      and(
        eq(projectTasksTable.projectId, projectId),
        eq(projectTasksTable.source, "manual"),
        or(
          eq(projectTasksTable.status, "pending"),
          eq(projectTasksTable.status, "in_progress"),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Builds the action-items section for the engine system-prompt block so the
 * LLM can answer "what's still open?" and "who owns the party bus?" accurately.
 * Returns null when no open items exist.
 */
export async function buildActionItemsPromptSection(projectId: number): Promise<string | null> {
  const items = await getOpenActionItems(projectId);
  if (items.length === 0) return null;

  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const lines = items.map((item) => {
    const owner = item.ownerName ? `owner: ${item.ownerName}` : "unassigned";
    const due = item.dueAt ? `, due: ${fmt(item.dueAt)}` : "";
    return `  - "${item.title}" (${owner}${due}, ${item.status})`;
  });

  return (
    `Open action items (${items.length}):\n${lines.join("\n")}\n` +
    `To create a new one, set task_action.kind = "create". To close one ("Jake sorted the bus"), set kind = "close".`
  );
}

// ── Scheduler helpers ──────────────────────────────────────────────────────────

export interface ActionItemDue {
  taskId: number;
  title: string;
  projectId: number;
  ownerUserId: number;
  ownerPhone: string;
  ownerName: string | null;
  dueAt: Date;
}

/**
 * Returns all open manual action items due within 24 hours that haven't had
 * a nudge sent yet (notifiedAt is null). Used by the daily deadline-nudge scan.
 */
export async function findDueActionItems(): Promise<ActionItemDue[]> {
  const now = new Date();
  const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

  // Items due within the next 24h (not overdue), not yet notified, with an assigned owner.
  const rows = await db
    .select({
      taskId: projectTasksTable.id,
      title: projectTasksTable.title,
      projectId: projectTasksTable.projectId,
      ownerUserId: projectTasksTable.ownerUserId,
      dueAt: projectTasksTable.dueAt,
      ownerPhone: usersTable.phoneNumber,
      ownerName: usersTable.displayName,
    })
    .from(projectTasksTable)
    .innerJoin(usersTable, eq(projectTasksTable.ownerUserId, usersTable.id))
    .where(
      and(
        eq(projectTasksTable.source, "manual"),
        or(
          eq(projectTasksTable.status, "pending"),
          eq(projectTasksTable.status, "in_progress"),
        ),
        isNull(projectTasksTable.notifiedAt),
        gte(projectTasksTable.dueAt, now),
        lt(projectTasksTable.dueAt, windowEnd),
      ),
    );

  // Filter to active projects only.
  if (rows.length === 0) return [];
  const projectIds = [...new Set(rows.map((r) => r.projectId))];
  const activeProjects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        inArray(projectsTable.id, projectIds),
        inArray(projectsTable.status, [...PROJECT_ACTIVE_STATUSES]),
      ),
    );
  const activeIds = new Set(activeProjects.map((p) => p.id));

  return rows
    .filter(
      (r): r is typeof r & { ownerUserId: number; dueAt: Date } =>
        r.ownerUserId !== null && r.dueAt !== null && activeIds.has(r.projectId),
    )
    .map((r) => ({
      taskId: r.taskId,
      title: r.title,
      projectId: r.projectId,
      ownerUserId: r.ownerUserId,
      ownerPhone: r.ownerPhone,
      ownerName: r.ownerName,
      dueAt: r.dueAt,
    }));
}

/** Marks a task's notifiedAt so it is not nudged again. */
export async function markActionItemNotified(taskId: number): Promise<void> {
  await db
    .update(projectTasksTable)
    .set({ notifiedAt: new Date() })
    .where(eq(projectTasksTable.id, taskId));
}

/**
 * Resolves a thread participant's userId by name (case-insensitive partial
 * match), scoped to the project's group thread. Mirrors `findThreadMemberByName`
 * from the ledger module but scoped to the action-items context.
 */
export async function findMemberByNameInThread(
  threadId: number,
  name: string,
): Promise<{ userId: number; displayName: string | null; phoneNumber: string } | null> {
  const participants = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(eq(threadParticipantsTable.threadId, threadId));

  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  const exact = participants.find((p) => p.displayName?.trim().toLowerCase() === normalized);
  if (exact) return { userId: exact.id, displayName: exact.displayName, phoneNumber: exact.phoneNumber };

  const partial = participants.find((p) => {
    const dn = p.displayName?.trim().toLowerCase();
    if (!dn) return false;
    return dn.includes(normalized) || normalized.includes(dn);
  });
  return partial ? { userId: partial.id, displayName: partial.displayName, phoneNumber: partial.phoneNumber } : null;
}
