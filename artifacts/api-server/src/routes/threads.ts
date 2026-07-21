import { Router, type IRouter } from "express";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  bookingsTable,
  messagesTable,
  plansTable,
  pollOptionsTable,
  pollVotesTable,
  pollsTable,
  projectsTable,
  PROJECT_ACTIVE_STATUSES,
  threadParticipantsTable,
  threadsTable,
  usersTable,
  type Message,
  type Project,
} from "@workspace/db";
import { GetThreadParams, GetThreadResponse, ListThreadsResponse } from "@workspace/api-zod";
import { getTimelineSummary } from "../lib/agent/projectTimeline";
import { getLedgerSummary } from "../lib/agent/ledger";
import { countOpenActionItems } from "../lib/agent/actionItems";
import { getCommitmentStatus } from "../lib/agent/commitmentPoll";
import { getArrivalResponseStatus } from "../lib/agent/arrivalMatrix";

const router: IRouter = Router();

interface ParticipantSummary {
  userId: number;
  phoneNumber: string;
  displayName: string | null;
  role: string;
}

/** Participant summaries for every thread id given, batched into a single query keyed by thread id. */
async function getParticipantSummariesByThreadId(threadIds: number[]): Promise<Map<number, ParticipantSummary[]>> {
  const result = new Map<number, ParticipantSummary[]>();
  if (threadIds.length === 0) return result;

  const rows = await db
    .select({ threadId: threadParticipantsTable.threadId, user: usersTable, role: threadParticipantsTable.role })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(inArray(threadParticipantsTable.threadId, threadIds));

  for (const row of rows) {
    const list = result.get(row.threadId) ?? [];
    list.push({
      userId: row.user.id,
      phoneNumber: row.user.phoneNumber,
      displayName: row.user.displayName,
      role: row.role,
    });
    result.set(row.threadId, list);
  }
  return result;
}

/** Most recent message per thread id, batched into a single query instead of one per thread. */
async function getLatestMessagesByThreadId(threadIds: number[]): Promise<Map<number, Message>> {
  const result = new Map<number, Message>();
  if (threadIds.length === 0) return result;

  // Ordered newest-first per thread (threadId, then createdAt desc), so the
  // first row seen for a given thread id while iterating is its latest
  // message -- no need to fetch and sort every message per thread.
  const rows = await db
    .select()
    .from(messagesTable)
    .where(inArray(messagesTable.threadId, threadIds))
    .orderBy(messagesTable.threadId, desc(messagesTable.createdAt));

  for (const row of rows) {
    if (!result.has(row.threadId)) {
      result.set(row.threadId, row);
    }
  }
  return result;
}

router.get("/threads", async (_req, res): Promise<void> => {
  const threads = await db.select().from(threadsTable).orderBy(threadsTable.updatedAt);
  const threadIds = threads.map((thread) => thread.id);

  const [participantsByThreadId, latestMessageByThreadId] = await Promise.all([
    getParticipantSummariesByThreadId(threadIds),
    getLatestMessagesByThreadId(threadIds),
  ]);

  const summaries = threads.map((thread) => {
    const latest = latestMessageByThreadId.get(thread.id);
    return {
      id: thread.id,
      isGroup: thread.isGroup,
      title: thread.title,
      participants: participantsByThreadId.get(thread.id) ?? [],
      lastMessagePreview: latest?.content ?? null,
      lastMessageAt: latest?.createdAt ?? null,
      needsAttention: thread.needsAttention,
      needsAttentionAt: thread.needsAttentionAt ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  });

  res.json(ListThreadsResponse.parse(summaries));
});

router.get("/threads/:id", async (req, res): Promise<void> => {
  const params = GetThreadParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, params.data.id));
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  const [participantsByThreadId, messages, polls, activeProject] = await Promise.all([
    getParticipantSummariesByThreadId([thread.id]),
    db.select().from(messagesTable).where(eq(messagesTable.threadId, thread.id)).orderBy(messagesTable.createdAt),
    db.select().from(pollsTable).where(eq(pollsTable.threadId, thread.id)),
    getActiveProjectSummary(thread.id),
  ]);

  const pollIds = polls.map((poll) => poll.id);
  const [allOptions, allVotes] = await Promise.all([
    pollIds.length
      ? db.select().from(pollOptionsTable).where(inArray(pollOptionsTable.pollId, pollIds)).orderBy(pollOptionsTable.position)
      : Promise.resolve([]),
    pollIds.length ? db.select().from(pollVotesTable).where(inArray(pollVotesTable.pollId, pollIds)) : Promise.resolve([]),
  ]);

  const optionsByPollId = new Map<number, typeof allOptions>();
  for (const option of allOptions) {
    const list = optionsByPollId.get(option.pollId) ?? [];
    list.push(option);
    optionsByPollId.set(option.pollId, list);
  }
  const voteCountByOptionId = new Map<number, number>();
  for (const vote of allVotes) {
    voteCountByOptionId.set(vote.optionId, (voteCountByOptionId.get(vote.optionId) ?? 0) + 1);
  }

  const pollSummaries = polls.map((poll) => ({
    id: poll.id,
    question: poll.question,
    status: poll.status,
    winningOptionId: poll.winningOptionId,
    options: (optionsByPollId.get(poll.id) ?? []).map((option) => ({
      id: option.id,
      label: option.label,
      position: option.position,
      voteCount: voteCountByOptionId.get(option.id) ?? 0,
    })),
    createdAt: poll.createdAt,
    closedAt: poll.closedAt,
  }));

  res.json(
    GetThreadResponse.parse({
      id: thread.id,
      isGroup: thread.isGroup,
      title: thread.title,
      adminNotes: thread.adminNotes,
      needsAttention: thread.needsAttention,
      needsAttentionAt: thread.needsAttentionAt ?? null,
      participants: participantsByThreadId.get(thread.id) ?? [],
      messages,
      polls: pollSummaries,
      project: activeProject,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }),
  );
});

/** The thread's active project with its child plan count, shaped for the ThreadDetail response. */
async function getActiveProjectSummary(
  threadId: number,
): Promise<(Omit<Project, "updatedAt"> & { childPlanCount: number; organizerDisplayName: string | null; timeline: { total: number; done: number; nextStep: { title: string; dueAt: Date | null } | null } | null; ledger: { totalEstimatedCents: number; totalCollectedCents: number; outstandingCount: number } | null; openActionItemCount: number; arrival: { requestId: number; respondedCount: number; totalCount: number } | null; commitment: { deadline: Date; headcountTarget: number | null; committedCount: number; totalCount: number; lockedAt: Date | null; lockedCount: number | null } | null }) | null> {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.threadId, threadId), inArray(projectsTable.status, [...PROJECT_ACTIVE_STATUSES])))
    .orderBy(desc(projectsTable.createdAt))
    .limit(1);
  if (!project) return null;

  const [[childCount], organizerRow, timeline, ledgerRaw, openActionItemCount, commitmentStatus, arrivalStatus] = await Promise.all([
    db.select({ value: count() }).from(plansTable).where(eq(plansTable.projectId, project.id)),
    project.organizerUserId
      ? db
          .select({ displayName: usersTable.displayName })
          .from(usersTable)
          .where(eq(usersTable.id, project.organizerUserId))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    getTimelineSummary(project.id),
    getLedgerSummary(project.id),
    countOpenActionItems(project.id),
    getCommitmentStatus(project),
    getArrivalResponseStatus(project),
  ]);

  const ledger = ledgerRaw
    ? {
        totalEstimatedCents: ledgerRaw.totalEstimatedCents,
        totalCollectedCents: ledgerRaw.totalCollectedCents,
        outstandingCount: ledgerRaw.outstandingCount,
      }
    : null;

  return {
    id: project.id,
    threadId: project.threadId,
    type: project.type,
    honoree: project.honoree,
    honoreeUserId: project.honoreeUserId,
    organizerUserId: project.organizerUserId ?? null,
    organizerDisplayName: organizerRow?.displayName ?? null,
    dateRangeStart: project.dateRangeStart,
    dateRangeEnd: project.dateRangeEnd,
    status: project.status,
    destination: project.destination ?? null,
    destinationPollId: project.destinationPollId ?? null,
    commitmentDeadline: project.commitmentDeadline ?? null,
    headcountTarget: project.headcountTarget ?? null,
    commitmentPollId: project.commitmentPollId ?? null,
    headcountLockedAt: project.headcountLockedAt ?? null,
    headcountLockedCount: project.headcountLockedCount ?? null,
    lodgingPerPersonCents: project.lodgingPerPersonCents ?? null,
    lodgingPropertyName: project.lodgingPropertyName ?? null,
    lodgingCheckIn: project.lodgingCheckIn ?? null,
    lodgingCheckOut: project.lodgingCheckOut ?? null,
    arrivalCollectionRequestId: project.arrivalCollectionRequestId ?? null,
    closeoutPromptSentAt: project.closeoutPromptSentAt ?? null,
    closedAt: project.closedAt ?? null,
    childPlanCount: childCount?.value ?? 0,
    timeline,
    ledger,
    openActionItemCount,
    arrival: arrivalStatus,
    commitment: commitmentStatus
      ? {
          deadline: commitmentStatus.deadline,
          headcountTarget: commitmentStatus.headcountTarget,
          committedCount: commitmentStatus.committed.length,
          totalCount: commitmentStatus.totalParticipants,
          lockedAt: commitmentStatus.lockedAt,
          lockedCount: commitmentStatus.lockedCount,
        }
      : null,
    createdAt: project.createdAt,
  };
}

const ThreadIdParam = z.object({ id: z.coerce.number().int() });
const PatchAdminNotesBody = z.object({ adminNotes: z.string() });

/**
 * Updates the admin steering notes for a thread. These notes are injected
 * into the agent's system prompt on every future turn for this thread, giving
 * ops a per-thread lever for corrections that don't require a code change.
 */
router.patch("/threads/:id/admin-notes", async (req, res): Promise<void> => {
  const params = ThreadIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid thread id" });
    return;
  }
  const body = PatchAdminNotesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [updated] = await db
    .update(threadsTable)
    .set({ adminNotes: body.data.adminNotes || null })
    .where(eq(threadsTable.id, params.data.id))
    .returning({ id: threadsTable.id });

  if (!updated) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  res.json({ ok: true });
});

/**
 * Clears the needsAttention flag on a thread. Called by ops after they've
 * reviewed and addressed whatever triggered the flag.
 */
router.post("/threads/:id/resolve-attention", async (req, res): Promise<void> => {
  const params = ThreadIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid thread id" });
    return;
  }

  const [updated] = await db
    .update(threadsTable)
    .set({ needsAttention: false, needsAttentionAt: null })
    .where(eq(threadsTable.id, params.data.id))
    .returning({ id: threadsTable.id });

  if (!updated) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  res.json({ ok: true });
});

/**
 * Hard-deletes a thread and all associated records (participants, messages,
 * polls, plans, bookings). This is a destructive, irreversible action.
 */
router.delete("/threads/:id", async (req, res): Promise<void> => {
  const params = ThreadIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid thread id" });
    return;
  }

  const [thread] = await db.select({ id: threadsTable.id }).from(threadsTable).where(eq(threadsTable.id, params.data.id));
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  // Delete in dependency order: votes → options → polls, then other FK rows.
  const polls = await db.select({ id: pollsTable.id }).from(pollsTable).where(eq(pollsTable.threadId, params.data.id));
  if (polls.length > 0) {
    const pollIds = polls.map((p) => p.id);
    await db.delete(pollVotesTable).where(inArray(pollVotesTable.pollId, pollIds));
    await db.delete(pollOptionsTable).where(inArray(pollOptionsTable.pollId, pollIds));
    await db.delete(pollsTable).where(eq(pollsTable.threadId, params.data.id));
  }
  await db.delete(bookingsTable).where(eq(bookingsTable.threadId, params.data.id));
  await db.delete(plansTable).where(eq(plansTable.threadId, params.data.id));
  await db.delete(messagesTable).where(eq(messagesTable.threadId, params.data.id));
  await db.delete(threadParticipantsTable).where(eq(threadParticipantsTable.threadId, params.data.id));
  await db.delete(threadsTable).where(eq(threadsTable.id, params.data.id));

  res.json({ deleted: true });
});

export default router;
