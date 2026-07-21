import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  plansTable,
  projectsTable,
  usersTable,
  PROJECT_ACTIVE_STATUSES,
  type Plan,
  type Project,
} from "@workspace/db";
import { buildTimelinePromptSection } from "./projectTimeline";
import { buildLedgerPromptSection } from "./ledger";
import { buildActionItemsPromptSection } from "./actionItems";
import { getCommitmentStatus } from "./commitmentPoll";
import { buildJITVenuePromptSection, isNYCDestination } from "./venueCorpus/jitExtraction";

/**
 * Projects: the grouping layer above plans for multi-event occasions
 * (bachelorettes, milestone birthdays, reunions, trips). A project owns a
 * date range and an honoree; individual events live on as plans with
 * `projectId` set, so every per-plan lifecycle feature (reminders, plan
 * cards, weather rescue, feedback) works unchanged for project children.
 */

/** The thread's current in-flight project, if any (at most one active project per thread at a time). */
export async function getActiveProject(threadId: number): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.threadId, threadId), inArray(projectsTable.status, [...PROJECT_ACTIVE_STATUSES])))
    .orderBy(desc(projectsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateProjectInput {
  threadId: number;
  type: string;
  honoree: string | null;
  honoreeUserId: number | null;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
  /** Defaults to the sender who triggered project creation. Optional for callers that don't have this context. */
  organizerUserId?: number | null;
}

/** Fills fields that are still null on the existing active project; never overwrites non-null values. */
async function mergeIntoExistingProject(existing: Project, input: CreateProjectInput): Promise<Project> {
  const patch: Partial<typeof projectsTable.$inferInsert> = {};
  if (!existing.honoree && input.honoree) patch.honoree = input.honoree;
  if (!existing.honoreeUserId && input.honoreeUserId) patch.honoreeUserId = input.honoreeUserId;
  if (!existing.dateRangeStart && input.dateRangeStart) patch.dateRangeStart = input.dateRangeStart;
  if (!existing.dateRangeEnd && input.dateRangeEnd) patch.dateRangeEnd = input.dateRangeEnd;
  if (!existing.organizerUserId && input.organizerUserId) patch.organizerUserId = input.organizerUserId;
  if (Object.keys(patch).length === 0) return existing;

  const [updated] = await db
    .update(projectsTable)
    .set(patch)
    .where(eq(projectsTable.id, existing.id))
    .returning();
  return updated ?? existing;
}

/** True when an insert failed on the projects_one_active_per_thread partial unique index. */
function isActiveProjectConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

/**
 * Creates the thread's active project, or merges into the existing one.
 *
 * Idempotent by design: the LLM may set the `project` field again when new
 * details surface ("it'll be June 5-8 actually"), so a second call fills in
 * fields that are still null on the existing active project rather than
 * creating a duplicate. Non-null fields are never overwritten -- ops can
 * correct bad extractions without the LLM stomping the fix on the next turn.
 *
 * "At most one active project per thread" is enforced by a partial unique
 * index, so two concurrent turns cannot both create one: the loser's insert
 * fails and falls back to merging into the winner's row.
 *
 * On creation (not merge), the single most recent still-forming standalone
 * plan (proposed/deciding -- never confirmed) is adopted as the project's
 * first child: the "we're planning Sarah's bachelorette" message usually
 * arrives right after a first event has started forming. Confirmed plans are
 * deliberately left alone -- a locked-in unrelated dinner must not be
 * silently re-labeled as part of the new occasion.
 */
export async function createProjectForThread(
  input: CreateProjectInput,
): Promise<{ project: Project; created: boolean }> {
  const existing = await getActiveProject(input.threadId);
  if (existing) {
    return { project: await mergeIntoExistingProject(existing, input), created: false };
  }

  let project: Project;
  try {
    const [inserted] = await db
      .insert(projectsTable)
      .values({
        threadId: input.threadId,
        type: input.type,
        honoree: input.honoree,
        honoreeUserId: input.honoreeUserId,
        dateRangeStart: input.dateRangeStart,
        dateRangeEnd: input.dateRangeEnd,
        organizerUserId: input.organizerUserId,
        status: "planning",
      })
      .returning();
    if (!inserted) throw new Error("Failed to create project");
    project = inserted;
  } catch (error) {
    if (!isActiveProjectConflict(error)) throw error;
    // Lost the race to a concurrent turn: merge into the winner instead.
    const winner = await getActiveProject(input.threadId);
    if (!winner) throw error;
    return { project: await mergeIntoExistingProject(winner, input), created: false };
  }

  // Adopt the newest still-forming standalone plan (if any) as the first child.
  const [adoptable] = await db
    .select({ id: plansTable.id })
    .from(plansTable)
    .where(
      and(
        eq(plansTable.threadId, input.threadId),
        isNull(plansTable.projectId),
        inArray(plansTable.status, ["proposed", "deciding"]),
      ),
    )
    .orderBy(desc(plansTable.createdAt))
    .limit(1);
  if (adoptable) {
    await db.update(plansTable).set({ projectId: project.id }).where(eq(plansTable.id, adoptable.id));
  }

  return { project, created: true };
}

/**
 * Returns the display name of the organizer for a project, or null if none
 * is set. Used by the dashboard and sidebar routing logic.
 */
export async function getOrganizerForProject(project: Project): Promise<{ id: number; displayName: string | null; phoneNumber: string } | null> {
  if (!project.organizerUserId) return null;
  const [row] = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
    .from(usersTable)
    .where(eq(usersTable.id, project.organizerUserId));
  return row ?? null;
}

/**
 * Returns the most recent active project for which `userId` is the organizer,
 * across ALL threads. Used by the 1:1 sidebar routing to detect when an
 * organizer DM should attach project context to the engine turn.
 */
export async function getActiveProjectForOrganizer(userId: number): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.organizerUserId, userId),
        inArray(projectsTable.status, [...PROJECT_ACTIVE_STATUSES]),
      ),
    )
    .orderBy(desc(projectsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** All child plans of a project, newest first. */
export async function getProjectChildPlans(projectId: number): Promise<Plan[]> {
  return db
    .select()
    .from(plansTable)
    .where(eq(plansTable.projectId, projectId))
    .orderBy(desc(plansTable.createdAt));
}

// ── Pure helpers (unit-tested in tests/projects.test.ts) ────────────────────

/** Human-readable label for a project type slug: "milestone_birthday" -> "milestone birthday". */
export function formatProjectType(type: string): string {
  return type.replace(/_/g, " ");
}

const MAX_TYPE_LENGTH = 40;
const MAX_HONOREE_LENGTH = 80;

/**
 * Parses the raw `project` field from the LLM's JSON response into a clean
 * shape, or null when the field is absent/unusable. Tolerates the usual LLM
 * sloppiness: mixed-case or spaced type labels, invalid dates, and reversed
 * date ranges (start after end gets swapped rather than dropped).
 *
 * Both text fields are persisted and later re-injected into system prompt
 * context (see buildProjectPromptSummary), so they are aggressively
 * sanitized: `type` is reduced to a bounded [a-z0-9_] slug, and `honoree`
 * is stripped of control characters/newlines and length-capped. Free-flowing
 * user text must never ride these fields into a system-priority block.
 */
export function parseProjectField(raw: unknown): {
  type: string;
  honoree: string | null;
  dateRangeStart: Date | null;
  dateRangeEnd: Date | null;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { type?: unknown; honoree?: unknown; date_range_start?: unknown; date_range_end?: unknown };

  const type =
    typeof candidate.type === "string"
      ? candidate.type
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "_")
          .replace(/[^a-z0-9_]/g, "")
          .replace(/_+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, MAX_TYPE_LENGTH) || null
      : null;
  if (!type) return null;

  const honoree =
    typeof candidate.honoree === "string"
      ? candidate.honoree
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_HONOREE_LENGTH) || null
      : null;

  const parseDate = (value: unknown): Date | null => {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  let dateRangeStart = parseDate(candidate.date_range_start);
  let dateRangeEnd = parseDate(candidate.date_range_end);
  if (dateRangeStart && dateRangeEnd && dateRangeStart.getTime() > dateRangeEnd.getTime()) {
    [dateRangeStart, dateRangeEnd] = [dateRangeEnd, dateRangeStart];
  }

  return { type, honoree, dateRangeStart, dateRangeEnd };
}

/**
 * The system-prompt block describing the thread's active project, so the LLM
 * plans each event inside the project frame instead of treating every dinner
 * as an isolated one-off. Child plans are listed so it knows what is already
 * in motion and doesn't re-propose covered events.
 */
export async function buildProjectPromptSummary(project: Project, childPlans: Plan[]): Promise<string> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const range =
    project.dateRangeStart && project.dateRangeEnd
      ? `${fmt(project.dateRangeStart)} to ${fmt(project.dateRangeEnd)}`
      : project.dateRangeStart
        ? `starting ${fmt(project.dateRangeStart)}`
        : "dates not settled yet";

  const destinationNote = project.destination ? ` Destination: ${project.destination}.` : " Destination: not yet decided.";
  const lodgingNote = project.lodgingPropertyName
    ? (() => {
        const parts = [`Lodging: ${project.lodgingPropertyName}`];
        if (project.lodgingCheckIn && project.lodgingCheckOut) {
          parts.push(`(${fmt(project.lodgingCheckIn)} – ${fmt(project.lodgingCheckOut)})`);
        }
        return ` ${parts.join(" ")}.`;
      })()
    : "";

  const header = [
    `Active project in this thread: ${formatProjectType(project.type)}`,
    project.honoree ? `for ${project.honoree}` : null,
    `(${range}, status: ${project.status}).${destinationNote}${lodgingNote}`,
  ]
    .filter(Boolean)
    .join(" ");

  const lines = childPlans.map((plan) => {
    const when = plan.scheduledFor ? plan.scheduledFor.toISOString().slice(0, 10) : "unscheduled";
    const venue = plan.venue ? ` at ${plan.venue}` : "";
    return `- "${plan.title}"${venue} (${when}, ${plan.status})`;
  });

  const eventsBlock = lines.length > 0 ? `\nEvents in this project so far:\n${lines.join("\n")}` : "\nNo events created for it yet.";

  const [timelineSection, ledgerSection, actionItemsSection, commitmentStatus, jitVenueSection] = await Promise.all([
    buildTimelinePromptSection(project.id),
    buildLedgerPromptSection(project.id),
    buildActionItemsPromptSection(project.id),
    getCommitmentStatus(project),
    project.destination && !isNYCDestination(project.destination)
      ? buildJITVenuePromptSection(project.destination)
      : Promise.resolve(null),
  ]);

  let commitmentSection: string | null = null;
  if (commitmentStatus) {
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
    if (commitmentStatus.lockedAt) {
      commitmentSection = `Headcount locked at ${commitmentStatus.lockedCount} (as of ${fmtDate(commitmentStatus.lockedAt)}).`;
    } else {
      const committed = commitmentStatus.committed.map((c) => c.displayName ?? c.phoneNumber);
      const uncommitted = commitmentStatus.uncommitted.map((c) => c.displayName ?? c.phoneNumber);
      const total = commitmentStatus.totalParticipants;
      const target = commitmentStatus.headcountTarget ? ` (target: ${commitmentStatus.headcountTarget})` : "";
      commitmentSection =
        `Commitment round${target}, deadline: ${fmtDate(commitmentStatus.deadline)} (${commitmentStatus.committed.length}/${total} committed).\n` +
        (committed.length > 0 ? `  In (${committed.length}): ${committed.join(", ")}\n` : `  No one has committed yet.\n`) +
        (uncommitted.length > 0 ? `  Not yet in (${uncommitted.length}): ${uncommitted.join(", ")}` : `  Everyone is committed.`);
    }
  }

  return (
    `${header}${eventsBlock}\n` +
    (timelineSection ? `\n${timelineSection}\n` : "") +
    (ledgerSection ? `\n${ledgerSection}\n` : "") +
    (actionItemsSection ? `\n${actionItemsSection}\n` : "") +
    (commitmentSection ? `\n${commitmentSection}\n` : "") +
    (jitVenueSection ? `${jitVenueSection}\n` : "") +
    `Plan within this project frame: multiple events can be in motion at once, so suggesting or coordinating a new event is fine even while another is undecided. Do not set "project" again for this occasion -- it already exists.`
  );
}
