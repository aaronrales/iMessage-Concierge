import { and, eq } from "drizzle-orm";
import { db, pollOptionsTable, pollVotesTable, pollsTable, type Poll } from "@workspace/db";

export interface PollWithOptions {
  poll: Poll;
  options: { id: number; label: string; position: number }[];
}

export async function getOpenPoll(threadId: number): Promise<PollWithOptions | null> {
  const [poll] = await db
    .select()
    .from(pollsTable)
    .where(and(eq(pollsTable.threadId, threadId), eq(pollsTable.status, "open")));
  if (!poll) return null;

  const options = await db
    .select()
    .from(pollOptionsTable)
    .where(eq(pollOptionsTable.pollId, poll.id))
    .orderBy(pollOptionsTable.position);

  return { poll, options };
}

/** Creates a new open poll with options, closing any prior open poll on the thread. */
export async function createPoll(threadId: number, question: string, optionLabels: string[]): Promise<PollWithOptions> {
  await db
    .update(pollsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(pollsTable.threadId, threadId), eq(pollsTable.status, "open")));

  const [poll] = await db.insert(pollsTable).values({ threadId, question }).returning();
  if (!poll) throw new Error("Failed to create poll");

  const options = await db
    .insert(pollOptionsTable)
    .values(optionLabels.map((label, index) => ({ pollId: poll.id, label, position: index })))
    .returning();

  return { poll, options };
}

/** Finds the poll option whose label best matches the given free-text message content. */
export function matchOption(
  content: string,
  options: { id: number; label: string }[],
): { id: number; label: string } | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;

  // Exact or substring match against option labels.
  const byLabel = options.find(
    (option) =>
      normalized === option.label.toLowerCase() || normalized.includes(option.label.toLowerCase()),
  );
  if (byLabel) return byLabel;

  // Numeric shorthand, e.g. "1" or "2" for the first/second option.
  const numeric = Number.parseInt(normalized, 10);
  if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1] ?? null;
  }

  return null;
}

export async function recordVote(pollId: number, optionId: number, userId: number): Promise<void> {
  await db
    .insert(pollVotesTable)
    .values({ pollId, optionId, userId })
    .onConflictDoUpdate({ target: [pollVotesTable.pollId, pollVotesTable.userId], set: { optionId } });
}

export interface PollTally {
  option: { id: number; label: string };
  voteCount: number;
}

export async function tallyPoll(pollId: number, options: { id: number; label: string }[]): Promise<PollTally[]> {
  const votes = await db.select().from(pollVotesTable).where(eq(pollVotesTable.pollId, pollId));

  return options.map((option) => ({
    option,
    voteCount: votes.filter((vote) => vote.optionId === option.id).length,
  }));
}

export async function countDistinctVoters(pollId: number): Promise<number> {
  const votes = await db.select().from(pollVotesTable).where(eq(pollVotesTable.pollId, pollId));
  return new Set(votes.map((vote) => vote.userId)).size;
}

export async function closePollWithWinner(pollId: number, winningOptionId: number): Promise<void> {
  await db
    .update(pollsTable)
    .set({ status: "closed", closedAt: new Date(), winningOptionId })
    .where(eq(pollsTable.id, pollId));
}
