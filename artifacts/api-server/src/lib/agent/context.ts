import { and, desc, eq, isNotNull, isNull, lte, ne } from "drizzle-orm";
import {
  db,
  messagesTable,
  profilesTable,
  threadParticipantsTable,
  threadsTable,
  usersTable,
  type Message,
  type Profile,
  type Thread,
  type User,
} from "@workspace/db";

const HISTORY_LIMIT = 20;

export interface ThreadParticipantContext {
  user: User;
  profile: Profile | null;
  role: string;
}

export interface ThreadContext {
  thread: Thread;
  participants: ThreadParticipantContext[];
  recentMessages: Message[];
}

/** Finds an existing user by phone number, creating one if it doesn't exist yet. */
export async function findOrCreateUser(phoneNumber: string): Promise<User> {
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.phoneNumber, phoneNumber));
  if (existing) {
    return existing;
  }

  const [created] = await db.insert(usersTable).values({ phoneNumber }).returning();
  if (!created) {
    throw new Error(`Failed to create user for phone number ${phoneNumber}`);
  }

  await db.insert(profilesTable).values({ userId: created.id }).onConflictDoNothing();

  return created;
}

/** Finds the 1:1 thread for a phone number, or creates one and adds the user as a participant. */
export async function findOrCreateDirectThread(phoneNumber: string): Promise<{ thread: Thread; user: User }> {
  const user = await findOrCreateUser(phoneNumber);

  const [existing] = await db
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.primaryPhoneNumber, phoneNumber));

  if (existing) {
    return { thread: existing, user };
  }

  const [created] = await db
    .insert(threadsTable)
    .values({ primaryPhoneNumber: phoneNumber, isGroup: false })
    .returning();
  if (!created) {
    throw new Error(`Failed to create direct thread for ${phoneNumber}`);
  }

  await db
    .insert(threadParticipantsTable)
    .values({ threadId: created.id, userId: user.id, role: "member" })
    .onConflictDoNothing();

  return { thread: created, user };
}

/** Finds the group thread for a Sendblue group id, or creates one from the participant list. */
export async function findOrCreateGroupThread(
  groupId: string,
  participantPhoneNumbers: string[],
): Promise<{ thread: Thread; participants: User[] }> {
  const [existing] = await db
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.sendblueGroupId, groupId));

  const participants = await Promise.all(participantPhoneNumbers.map((phone) => findOrCreateUser(phone)));

  let thread = existing;
  if (!thread) {
    const [created] = await db
      .insert(threadsTable)
      .values({ sendblueGroupId: groupId, isGroup: true })
      .returning();
    if (!created) {
      throw new Error(`Failed to create group thread for ${groupId}`);
    }
    thread = created;
  }

  for (const participant of participants) {
    await db
      .insert(threadParticipantsTable)
      .values({ threadId: thread.id, userId: participant.id, role: "member" })
      .onConflictDoNothing();
  }

  return { thread, participants };
}

/** Loads full context for a thread: participants (with profiles) and recent message history. */
export async function loadThreadContext(threadId: number): Promise<ThreadContext> {
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
  if (!thread) {
    throw new Error(`Thread ${threadId} not found`);
  }

  const participantRows = await db
    .select({ user: usersTable, profile: profilesTable, role: threadParticipantsTable.role })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .leftJoin(profilesTable, eq(profilesTable.userId, usersTable.id))
    .where(eq(threadParticipantsTable.threadId, threadId));

  const recentMessages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.threadId, threadId))
    .orderBy(desc(messagesTable.createdAt))
    .limit(HISTORY_LIMIT);

  return {
    thread,
    participants: participantRows.map((row) => ({
      user: row.user,
      profile: row.profile,
      role: row.role,
    })),
    // Messages were fetched newest-first; restore chronological order for the transcript.
    recentMessages: recentMessages.reverse(),
  };
}

export async function recordMessage(params: {
  threadId: number;
  userId: number | null;
  direction: "inbound" | "outbound";
  role: "user" | "assistant" | "system";
  content: string;
  sendblueMessageHandle?: string | null;
  rawPayload?: unknown;
}): Promise<Message> {
  const [message] = await db
    .insert(messagesTable)
    .values({
      threadId: params.threadId,
      userId: params.userId,
      direction: params.direction,
      role: params.role,
      content: params.content,
      sendblueMessageHandle: params.sendblueMessageHandle ?? null,
      rawPayload: params.rawPayload ?? null,
    })
    .returning();
  if (!message) {
    throw new Error("Failed to record message");
  }
  return message;
}

/** Sets the mute flag for one participant's row on a thread. Deterministic command, never LLM-driven. */
export async function setParticipantMuted(threadId: number, userId: number, isMuted: boolean): Promise<void> {
  await db
    .update(threadParticipantsTable)
    .set({ isMuted })
    .where(and(eq(threadParticipantsTable.threadId, threadId), eq(threadParticipantsTable.userId, userId)));
}

export async function isParticipantMuted(threadId: number, userId: number): Promise<boolean> {
  const [row] = await db
    .select({ isMuted: threadParticipantsTable.isMuted })
    .from(threadParticipantsTable)
    .where(and(eq(threadParticipantsTable.threadId, threadId), eq(threadParticipantsTable.userId, userId)));
  return row?.isMuted ?? false;
}

/**
 * Participants in a group thread who have never received the onboarding
 * disclosure line. Callers should send the disclosure and then call
 * `markDisclosureSent` for each -- kept as two steps so the DB write only
 * happens after the send is attempted.
 */
export async function getParticipantsNeedingDisclosure(threadId: number): Promise<User[]> {
  const rows = await db
    .select({ user: usersTable, disclosureSentAt: threadParticipantsTable.disclosureSentAt })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(eq(threadParticipantsTable.threadId, threadId));

  return rows.filter((row) => !row.disclosureSentAt).map((row) => row.user);
}

export async function markDisclosureSent(threadId: number, userId: number): Promise<void> {
  await db
    .update(threadParticipantsTable)
    .set({ disclosureSentAt: new Date() })
    .where(and(eq(threadParticipantsTable.threadId, threadId), eq(threadParticipantsTable.userId, userId)));
}

/** Whether this group thread has ever received its one-time "I'm this group's AI concierge" intro. */
export async function hasGroupBeenIntroduced(threadId: number): Promise<boolean> {
  const [thread] = await db.select({ introducedAt: threadsTable.introducedAt }).from(threadsTable).where(eq(threadsTable.id, threadId));
  return Boolean(thread?.introducedAt);
}

export async function markGroupIntroduced(threadId: number): Promise<void> {
  await db.update(threadsTable).set({ introducedAt: new Date() }).where(eq(threadsTable.id, threadId));
}

/** Group thread ids a user currently participates in, with each thread's current home city. */
export async function getGroupThreadsForUser(userId: number): Promise<{ id: number; homeCity: string | null }[]> {
  const rows = await db
    .select({ id: threadsTable.id, homeCity: threadsTable.homeCity })
    .from(threadParticipantsTable)
    .innerJoin(threadsTable, eq(threadParticipantsTable.threadId, threadsTable.id))
    .where(and(eq(threadParticipantsTable.userId, userId), eq(threadsTable.isGroup, true)));
  return rows;
}

/** Sets a group thread's best-effort home city, but only if it isn't already set -- never overwrites a known city. */
export async function setThreadHomeCityIfUnset(threadId: number, city: string): Promise<void> {
  await db
    .update(threadsTable)
    .set({ homeCity: city })
    .where(and(eq(threadsTable.id, threadId), isNull(threadsTable.homeCity)));
}

/** Whether every participant of a group thread has completed onboarding (and it has at least one participant). */
export async function isGroupFullyOnboarded(threadId: number): Promise<boolean> {
  const rows = await db
    .select({ onboardingStatus: usersTable.onboardingStatus })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(eq(threadParticipantsTable.threadId, threadId));
  return rows.length > 0 && rows.every((row) => row.onboardingStatus === "completed");
}

/** Whether this group thread's one-time "everyone's set up" kickoff recap has already been sent. */
export async function hasOnboardingRecapBeenSent(threadId: number): Promise<boolean> {
  const [thread] = await db
    .select({ onboardingRecapSentAt: threadsTable.onboardingRecapSentAt })
    .from(threadsTable)
    .where(eq(threadsTable.id, threadId));
  return Boolean(thread?.onboardingRecapSentAt);
}

export async function markOnboardingRecapSent(threadId: number): Promise<void> {
  await db.update(threadsTable).set({ onboardingRecapSentAt: new Date() }).where(eq(threadsTable.id, threadId));
}

/**
 * Users whose onboarding disclosure DM went out at least `olderThanMs` ago,
 * are not yet `completed`, and have at least one group membership that
 * hasn't been nudged yet. Used by both the scheduled stalled-onboarding scan
 * and the ops dashboard's manual nudge action, so both agree on who counts
 * as "stalled".
 */
export async function getStalledOnboardingUserIds(olderThanMs: number): Promise<number[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .select({ userId: usersTable.id })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(
      and(
        isNotNull(threadParticipantsTable.disclosureSentAt),
        lte(threadParticipantsTable.disclosureSentAt, cutoff),
        isNull(threadParticipantsTable.onboardingNudgeSentAt),
        ne(usersTable.onboardingStatus, "completed"),
      ),
    );
  return Array.from(new Set(rows.map((row) => row.userId)));
}

/**
 * Marks every not-yet-nudged, disclosed group membership for a user as
 * nudged, so a single nudge DM never gets re-sent for the same person even
 * though the underlying state is tracked per group membership.
 */
export async function markOnboardingNudgeSentForUser(userId: number): Promise<void> {
  await db
    .update(threadParticipantsTable)
    .set({ onboardingNudgeSentAt: new Date() })
    .where(
      and(
        eq(threadParticipantsTable.userId, userId),
        isNotNull(threadParticipantsTable.disclosureSentAt),
        isNull(threadParticipantsTable.onboardingNudgeSentAt),
      ),
    );
}

/**
 * Per-user onboarding disclosure/nudge summary for the ops dashboard: the
 * earliest disclosure sent while the user is still not `completed` (i.e.
 * how long they've been stalled), and the most recent nudge sent, if any.
 */
export async function getOnboardingProgressByUserId(): Promise<
  Map<number, { disclosedAt: Date | null; nudgedAt: Date | null }>
> {
  const rows = await db
    .select({
      userId: threadParticipantsTable.userId,
      disclosureSentAt: threadParticipantsTable.disclosureSentAt,
      onboardingNudgeSentAt: threadParticipantsTable.onboardingNudgeSentAt,
    })
    .from(threadParticipantsTable);

  const result = new Map<number, { disclosedAt: Date | null; nudgedAt: Date | null }>();
  for (const row of rows) {
    const existing = result.get(row.userId) ?? { disclosedAt: null, nudgedAt: null };
    if (row.disclosureSentAt && (!existing.disclosedAt || row.disclosureSentAt < existing.disclosedAt)) {
      existing.disclosedAt = row.disclosureSentAt;
    }
    if (row.onboardingNudgeSentAt && (!existing.nudgedAt || row.onboardingNudgeSentAt > existing.nudgedAt)) {
      existing.nudgedAt = row.onboardingNudgeSentAt;
    }
    result.set(row.userId, existing);
  }
  return result;
}

/** All group thread ids, for scans that need to walk every group (e.g. the serendipity job). */
export async function getAllGroupThreadIds(): Promise<number[]> {
  const rows = await db.select({ id: threadsTable.id }).from(threadsTable).where(eq(threadsTable.isGroup, true));
  return rows.map((row) => row.id);
}

export async function getOtherParticipants(threadId: number, excludingUserId: number) {
  return db
    .select({ user: usersTable, role: threadParticipantsTable.role })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(and(eq(threadParticipantsTable.threadId, threadId)))
    .then((rows) => rows.filter((row) => row.user.id !== excludingUserId));
}
