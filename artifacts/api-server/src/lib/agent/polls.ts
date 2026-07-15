import { and, eq } from "drizzle-orm";
import { db, pollOptionsTable, pollVotesTable, pollsTable, type Poll } from "@workspace/db";

export interface PollWithOptions {
  poll: Poll;
  options: { id: number; label: string; position: number; optionDate: Date | null }[];
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

/**
 * Creates a new open poll with options, closing any prior open poll on the
 * thread. `kind: "date"` marks it as a date/time coordination poll -- voters
 * may pick several options that work for them and the winner is decided by
 * intersection (see `computeDatePollWinner`) rather than plurality.
 * `optionDates`, if provided, must line up 1:1 with `optionLabels`.
 */
export async function createPoll(
  threadId: number,
  question: string,
  optionLabels: string[],
  opts: { kind?: "choice" | "date"; planId?: number | null; optionDates?: (Date | null)[] } = {},
): Promise<PollWithOptions> {
  await db
    .update(pollsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(pollsTable.threadId, threadId), eq(pollsTable.status, "open")));

  const [poll] = await db
    .insert(pollsTable)
    .values({ threadId, question, kind: opts.kind ?? "choice", planId: opts.planId ?? null })
    .returning();
  if (!poll) throw new Error("Failed to create poll");

  const options = await db
    .insert(pollOptionsTable)
    .values(
      optionLabels.map((label, index) => ({
        pollId: poll.id,
        label,
        position: index,
        optionDate: opts.optionDates?.[index] ?? null,
      })),
    )
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

/**
 * Like `matchOption`, but for "date" kind polls where a reply may name
 * several options that all work (e.g. "friday and saturday work", "1, 3",
 * "any of them"). Splits on common separators and matches each piece
 * independently; returns every option that matched at least one piece.
 */
export function matchOptions(
  content: string,
  options: { id: number; label: string }[],
): { id: number; label: string }[] {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return [];

  if (/\b(any|all|everything|whatever works)\b/.test(normalized)) {
    return options;
  }

  const pieces = normalized.split(/,|\band\b|\bor\b|\/|;/).map((p) => p.trim()).filter(Boolean);
  const matched = new Map<number, { id: number; label: string }>();

  for (const piece of pieces) {
    const single = matchOption(piece, options);
    if (single) matched.set(single.id, single);
  }

  // Fall back to treating the whole message as one selection if splitting
  // produced nothing (e.g. a single date name with no separators).
  if (matched.size === 0) {
    const single = matchOption(normalized, options);
    if (single) matched.set(single.id, single);
  }

  return [...matched.values()];
}

/** Overwrites a single-choice ("choice" kind) vote for this user on this poll. */
export async function recordVote(pollId: number, optionId: number, userId: number): Promise<void> {
  await db.delete(pollVotesTable).where(and(eq(pollVotesTable.pollId, pollId), eq(pollVotesTable.userId, userId)));
  await db.insert(pollVotesTable).values({ pollId, optionId, userId });
}

/** Overwrites all of a user's selections on a "date" kind poll with the given set of option ids. */
export async function recordVotes(pollId: number, optionIds: number[], userId: number): Promise<void> {
  await db.delete(pollVotesTable).where(and(eq(pollVotesTable.pollId, pollId), eq(pollVotesTable.userId, userId)));
  if (optionIds.length === 0) return;
  await db.insert(pollVotesTable).values(optionIds.map((optionId) => ({ pollId, optionId, userId })));
}

/**
 * For "date" kind polls: the option every *expected* participant selected,
 * if one exists ("everyone's free" case). `expectedVoterCount` must be the
 * size of the thread's full participant set, not just those who have voted
 * so far -- comparing against current voters would make the very first vote
 * look like a full intersection and close the poll before anyone else
 * responds. Falls back to the option with the most votes when no single
 * option was picked by everyone, so a poll still resolves even without a
 * perfect overlap once all expected voters have responded.
 */
export async function computeDatePollWinner(
  pollId: number,
  options: { id: number; label: string }[],
  expectedVoterCount: number,
): Promise<{ option: { id: number; label: string }; voteCount: number; isFullIntersection: boolean } | null> {
  const votes = await db.select().from(pollVotesTable).where(eq(pollVotesTable.pollId, pollId));
  if (votes.length === 0) return null;

  const votersByOption = new Map<number, Set<number>>();
  for (const vote of votes) {
    const set = votersByOption.get(vote.optionId) ?? new Set<number>();
    set.add(vote.userId);
    votersByOption.set(vote.optionId, set);
  }

  const withCounts = options
    .map((option) => ({ option, voteCount: votersByOption.get(option.id)?.size ?? 0 }))
    .sort((a, b) => b.voteCount - a.voteCount);

  const best = withCounts[0];
  if (!best || best.voteCount === 0) return null;

  return { ...best, isFullIntersection: expectedVoterCount > 0 && best.voteCount === expectedVoterCount };
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
