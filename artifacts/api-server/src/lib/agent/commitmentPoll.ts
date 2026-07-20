/**
 * Headcount commitment mechanics.
 *
 * The organizer sets a deadline ("Lock headcount at 8 by Friday"). The agent
 * creates a simple two-option poll in the group thread ("I'm in" / "I'm out")
 * and stores the deadline on the project row. The daily scheduler:
 *   1. 24h before deadline → nudges uncommitted participants 1:1
 *   2. At/after deadline   → announces the locked headcount to the group,
 *                            marks the project as locked, and recomputes
 *                            per-person estimates if the ledger is active.
 */

import { and, eq, isNotNull, isNull, lt, not, inArray } from "drizzle-orm";
import {
  db,
  pollsTable,
  pollOptionsTable,
  pollVotesTable,
  projectsTable,
  threadParticipantsTable,
  usersTable,
  PROJECT_ACTIVE_STATUSES,
  type Project,
} from "@workspace/db";
import { logger } from "../logger";

// The two canonical option labels for a commitment poll.
export const COMMITMENT_IN_LABEL = "I'm in";
export const COMMITMENT_OUT_LABEL = "I'm out";

// ── Creation ──────────────────────────────────────────────────────────────────

/**
 * Creates a commitment poll in the group thread and stamps the project with
 * the deadline + headcount target. Closes any previously open poll in the
 * thread first (same behaviour as createPoll in polls.ts).
 *
 * Returns the newly created poll ID.
 */
export async function createCommitmentPoll(
  projectId: number,
  groupThreadId: number,
  deadline: Date,
  headcountTarget: number | null,
): Promise<number> {
  // Close any currently open poll in the group thread.
  await db
    .update(pollsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(pollsTable.threadId, groupThreadId), eq(pollsTable.status, "open")));

  // Create the commitment poll (kind = "choice", no planId).
  const [poll] = await db
    .insert(pollsTable)
    .values({ threadId: groupThreadId, question: "Are you in for the trip?", kind: "choice" })
    .returning();
  if (!poll) throw new Error("Failed to create commitment poll");

  // Insert options in canonical order: I'm in (0), I'm out (1).
  await db
    .insert(pollOptionsTable)
    .values([
      { pollId: poll.id, label: COMMITMENT_IN_LABEL, position: 0 },
      { pollId: poll.id, label: COMMITMENT_OUT_LABEL, position: 1 },
    ]);

  // Stamp the project with deadline, target, and the new poll ID.
  await db
    .update(projectsTable)
    .set({
      commitmentDeadline: deadline,
      headcountTarget: headcountTarget ?? null,
      commitmentPollId: poll.id,
      // Clear any prior lock so the round is fresh.
      headcountLockedAt: null,
      headcountLockedCount: null,
    })
    .where(eq(projectsTable.id, projectId));

  logger.info({ projectId, pollId: poll.id, deadline, headcountTarget }, "Commitment poll created");
  return poll.id;
}

// ── Status query ──────────────────────────────────────────────────────────────

export interface CommitmentStatus {
  pollId: number;
  deadline: Date;
  headcountTarget: number | null;
  /** User IDs + phones/names of people who voted "I'm in". */
  committed: { userId: number; displayName: string | null; phoneNumber: string }[];
  /**
   * User IDs + phones/names of thread participants who are NOT committed —
   * includes both "I'm out" voters AND those who haven't responded at all.
   * These are the people who receive pre-deadline nudges and whose estimates
   * are zeroed out when headcount locks.
   */
  uncommitted: { userId: number; displayName: string | null; phoneNumber: string }[];
  /** Total thread participant count (committed + all others). */
  totalParticipants: number;
  lockedAt: Date | null;
  lockedCount: number | null;
}

/**
 * Returns the full commitment status for a project that has an active
 * commitment poll. Returns null when the project has no poll.
 */
export async function getCommitmentStatus(project: Project): Promise<CommitmentStatus | null> {
  if (!project.commitmentPollId || !project.commitmentDeadline) return null;

  const pollId = project.commitmentPollId;

  // Find the "I'm in" option.
  const [inOption] = await db
    .select()
    .from(pollOptionsTable)
    .where(and(eq(pollOptionsTable.pollId, pollId), eq(pollOptionsTable.label, COMMITMENT_IN_LABEL)));

  if (!inOption) return null;

  // Who voted "I'm in"?
  const inVotes = await db
    .select({ userId: pollVotesTable.userId })
    .from(pollVotesTable)
    .where(eq(pollVotesTable.optionId, inOption.id));

  const inUserIds = new Set(inVotes.map((v) => v.userId));

  // All thread participants (excluding roles like "assistant" — just human participants).
  const participants = await db
    .select({ userId: usersTable.id, displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(eq(threadParticipantsTable.threadId, project.threadId));

  // Who voted anything at all (any option).
  const allVotes = await db
    .select({ userId: pollVotesTable.userId })
    .from(pollVotesTable)
    .innerJoin(pollOptionsTable, eq(pollVotesTable.optionId, pollOptionsTable.id))
    .where(eq(pollOptionsTable.pollId, pollId));
  const anyVoterIds = new Set(allVotes.map((v) => v.userId));

  const committed = participants.filter((p) => inUserIds.has(p.userId));
  // Uncommitted = everyone NOT in "I'm in" camp: includes "I'm out" voters AND non-responders.
  // Both groups need nudges and both have their estimates zeroed at lock.
  const uncommitted = participants.filter((p) => !inUserIds.has(p.userId));

  return {
    pollId,
    deadline: project.commitmentDeadline,
    headcountTarget: project.headcountTarget ?? null,
    committed,
    uncommitted,
    totalParticipants: participants.length,
    lockedAt: project.headcountLockedAt ?? null,
    lockedCount: project.headcountLockedCount ?? null,
  };
}

// ── Lock ──────────────────────────────────────────────────────────────────────

/**
 * Closes the commitment poll and stamps the locked headcount on the project.
 * Returns the locked count (number of "I'm in" votes).
 * Idempotent if already locked (returns existing lockedCount).
 */
export async function lockHeadcount(project: Project): Promise<number> {
  if (project.headcountLockedAt) {
    return project.headcountLockedCount ?? 0;
  }

  if (!project.commitmentPollId) return 0;

  const pollId = project.commitmentPollId;

  // Find the "I'm in" option ID.
  const [inOption] = await db
    .select()
    .from(pollOptionsTable)
    .where(and(eq(pollOptionsTable.pollId, pollId), eq(pollOptionsTable.label, COMMITMENT_IN_LABEL)));

  const committedCount = inOption
    ? (await db.select().from(pollVotesTable).where(eq(pollVotesTable.optionId, inOption.id))).length
    : 0;

  // Close the poll.
  await db
    .update(pollsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(pollsTable.id, pollId));

  // Stamp the lock on the project.
  const now = new Date();
  await db
    .update(projectsTable)
    .set({ headcountLockedAt: now, headcountLockedCount: committedCount })
    .where(eq(projectsTable.id, project.id));

  logger.info({ projectId: project.id, committedCount }, "Headcount locked");
  return committedCount;
}

// ── Scheduler queries ─────────────────────────────────────────────────────────

export interface CommitmentProjectRow {
  project: Project;
  organizerPhone: string | null;
  organizerName: string | null;
}

/**
 * Returns active projects whose commitment deadline falls within the next 24h
 * AND whose headcount has NOT yet been locked. Used to send pre-deadline nudges
 * to uncommitted participants.
 */
export async function getProjectsDueForPreDeadlineNudge(): Promise<CommitmentProjectRow[]> {
  const now = new Date();
  const nudgeWindowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const projects = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        isNotNull(projectsTable.commitmentDeadline),
        isNull(projectsTable.headcountLockedAt),
        inArray(projectsTable.status, [...PROJECT_ACTIVE_STATUSES]),
        // Deadline is between now and 24h from now.
        lt(projectsTable.commitmentDeadline, nudgeWindowEnd),
        not(lt(projectsTable.commitmentDeadline, now)),
      ),
    );

  return loadOrganizerInfo(projects);
}

/**
 * Returns active projects whose commitment deadline has passed AND whose
 * headcount has NOT yet been locked. Used to announce the final headcount.
 */
export async function getProjectsDueForLock(): Promise<CommitmentProjectRow[]> {
  const now = new Date();

  const projects = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        isNotNull(projectsTable.commitmentDeadline),
        isNull(projectsTable.headcountLockedAt),
        inArray(projectsTable.status, [...PROJECT_ACTIVE_STATUSES]),
        lt(projectsTable.commitmentDeadline, now),
      ),
    );

  return loadOrganizerInfo(projects);
}

/**
 * Returns true when the given poll ID is the active commitment poll for any
 * project. Used by the vote handler to suppress winner-based auto-close on
 * commitment polls (the deadline scanner governs the lock, not vote totals).
 */
export async function isCommitmentPoll(pollId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.commitmentPollId, pollId))
    .limit(1);
  return row != null;
}

async function loadOrganizerInfo(projects: Project[]): Promise<CommitmentProjectRow[]> {
  const result: CommitmentProjectRow[] = [];
  for (const project of projects) {
    let organizerPhone: string | null = null;
    let organizerName: string | null = null;
    if (project.organizerUserId) {
      const [org] = await db
        .select({ phoneNumber: usersTable.phoneNumber, displayName: usersTable.displayName })
        .from(usersTable)
        .where(eq(usersTable.id, project.organizerUserId));
      organizerPhone = org?.phoneNumber ?? null;
      organizerName = org?.displayName ?? null;
    }
    result.push({ project, organizerPhone, organizerName });
  }
  return result;
}
