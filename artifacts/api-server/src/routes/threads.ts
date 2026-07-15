import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  messagesTable,
  pollOptionsTable,
  pollVotesTable,
  pollsTable,
  threadParticipantsTable,
  threadsTable,
  usersTable,
} from "@workspace/db";
import { GetThreadParams, GetThreadResponse, ListThreadsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

async function getParticipantSummaries(threadId: number) {
  const rows = await db
    .select({ user: usersTable, role: threadParticipantsTable.role })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(eq(threadParticipantsTable.threadId, threadId));

  return rows.map((row) => ({
    userId: row.user.id,
    phoneNumber: row.user.phoneNumber,
    displayName: row.user.displayName,
    role: row.role,
  }));
}

router.get("/threads", async (_req, res): Promise<void> => {
  const threads = await db.select().from(threadsTable).orderBy(threadsTable.updatedAt);

  const summaries = await Promise.all(
    threads.map(async (thread) => {
      const participants = await getParticipantSummaries(thread.id);
      const [lastMessage] = await db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.threadId, thread.id))
        .orderBy(messagesTable.createdAt)
        .limit(1);

      const recent = await db.select().from(messagesTable).where(eq(messagesTable.threadId, thread.id));
      const latest = recent.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? lastMessage;

      return {
        id: thread.id,
        isGroup: thread.isGroup,
        title: thread.title,
        participants,
        lastMessagePreview: latest?.content ?? null,
        lastMessageAt: latest?.createdAt ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      };
    }),
  );

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

  const participants = await getParticipantSummaries(thread.id);

  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.threadId, thread.id))
    .orderBy(messagesTable.createdAt);

  const polls = await db.select().from(pollsTable).where(eq(pollsTable.threadId, thread.id));
  const pollSummaries = await Promise.all(
    polls.map(async (poll) => {
      const options = await db
        .select()
        .from(pollOptionsTable)
        .where(eq(pollOptionsTable.pollId, poll.id))
        .orderBy(pollOptionsTable.position);
      const votes = await db.select().from(pollVotesTable).where(eq(pollVotesTable.pollId, poll.id));

      return {
        id: poll.id,
        question: poll.question,
        status: poll.status,
        winningOptionId: poll.winningOptionId,
        options: options.map((option) => ({
          id: option.id,
          label: option.label,
          position: option.position,
          voteCount: votes.filter((vote) => vote.optionId === option.id).length,
        })),
        createdAt: poll.createdAt,
        closedAt: poll.closedAt,
      };
    }),
  );

  res.json(
    GetThreadResponse.parse({
      id: thread.id,
      isGroup: thread.isGroup,
      title: thread.title,
      participants,
      messages,
      polls: pollSummaries,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    }),
  );
});

export default router;
