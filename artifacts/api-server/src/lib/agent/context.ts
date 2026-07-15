import { and, desc, eq } from "drizzle-orm";
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

export async function getOtherParticipants(threadId: number, excludingUserId: number) {
  return db
    .select({ user: usersTable, role: threadParticipantsTable.role })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(and(eq(threadParticipantsTable.threadId, threadId)))
    .then((rows) => rows.filter((row) => row.user.id !== excludingUserId));
}
