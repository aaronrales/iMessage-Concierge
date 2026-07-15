import { Router, type IRouter } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import {
  db,
  messagesTable,
  pollOptionsTable,
  pollVotesTable,
  pollsTable,
  threadParticipantsTable,
  threadsTable,
  usersTable,
  type Message,
} from "@workspace/db";
import { GetThreadParams, GetThreadResponse, ListThreadsResponse } from "@workspace/api-zod";

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

  const [participantsByThreadId, messages, polls] = await Promise.all([
    getParticipantSummariesByThreadId([thread.id]),
    db.select().from(messagesTable).where(eq(messagesTable.threadId, thread.id)).orderBy(messagesTable.createdAt),
    db.select().from(pollsTable).where(eq(pollsTable.threadId, thread.id)),
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
      participants: participantsByThreadId.get(thread.id) ?? [],
      messages,
      polls: pollSummaries,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }),
  );
});

export default router;
