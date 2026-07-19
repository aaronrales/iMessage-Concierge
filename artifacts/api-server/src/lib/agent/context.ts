import { and, desc, eq, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm";
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
import { recordActivationEvent } from "./activation";

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

/** Attribution metadata set only at user creation — never overwritten for existing users. */
export interface UserAttribution {
  /** Free-text acquisition channel: "cold_dm" | "group_add" */
  source: string;
  /** Thread the user was first encountered in. */
  originThreadId: number;
}

/**
 * Finds an existing user by phone number, or creates one. Race-safe: the
 * insert uses onConflictDoNothing so two concurrent creates for the same
 * number collapse into one row. Returns the user plus an `isNew` flag so
 * callers can fire `added_to_group` or other creation-only side effects.
 *
 * `attribution` is only applied when creating a new row; existing users are
 * never overwritten (even if their source column is null).
 */
export async function findOrCreateUser(
  phoneNumber: string,
  attribution?: UserAttribution,
): Promise<{ user: User; isNew: boolean }> {
  // Try insert first — wins the race when two callers hit simultaneously.
  const [inserted] = await db
    .insert(usersTable)
    .values({
      phoneNumber,
      ...(attribution ? { source: attribution.source, originThreadId: attribution.originThreadId } : {}),
    })
    .onConflictDoNothing({ target: usersTable.phoneNumber })
    .returning();

  if (inserted) {
    await db.insert(profilesTable).values({ userId: inserted.id }).onConflictDoNothing();
    return { user: inserted, isNew: true };
  }

  // Existing user — re-select to get the current row.
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.phoneNumber, phoneNumber));
  if (!existing) {
    throw new Error(`Race: user for ${phoneNumber} not found after conflicting insert`);
  }
  return { user: existing, isNew: false };
}

/** Finds the 1:1 thread for a phone number, or creates one and adds the user as a participant. */
export async function findOrCreateDirectThread(phoneNumber: string): Promise<{ thread: Thread; user: User }> {
  // Resolve the thread first so we can stamp the user's originThreadId at creation.
  const [existingThread] = await db
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.primaryPhoneNumber, phoneNumber));

  let resolvedThread: Thread;
  if (existingThread) {
    resolvedThread = existingThread;
  } else {
    const [created] = await db
      .insert(threadsTable)
      .values({ primaryPhoneNumber: phoneNumber, isGroup: false })
      .returning();
    if (!created) throw new Error(`Failed to create direct thread for ${phoneNumber}`);
    resolvedThread = created;
  }

  // Attribution is only applied when creating a new user row.
  const { user } = await findOrCreateUser(phoneNumber, {
    source: "cold_dm",
    originThreadId: resolvedThread.id,
  });

  await db
    .insert(threadParticipantsTable)
    .values({ threadId: resolvedThread.id, userId: user.id, role: "member" })
    .onConflictDoNothing();

  return { thread: resolvedThread, user };
}

/** Finds the group thread for a Sendblue group id, or creates one from the participant list. */
export async function findOrCreateGroupThread(
  groupId: string,
  participantPhoneNumbers: string[],
): Promise<{ thread: Thread; participants: User[] }> {
  // Resolve thread first so we can stamp originThreadId on newly created users.
  const [existing] = await db
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.sendblueGroupId, groupId));

  let thread: Thread;
  if (existing) {
    thread = existing;
  } else {
    const [created] = await db
      .insert(threadsTable)
      .values({ sendblueGroupId: groupId, isGroup: true })
      .returning();
    if (!created) throw new Error(`Failed to create group thread for ${groupId}`);
    thread = created;
  }

  const participantResults = await Promise.all(
    participantPhoneNumbers.map((phone) =>
      findOrCreateUser(phone, { source: "group_add", originThreadId: thread.id }),
    ),
  );

  // Record added_to_group for brand-new users (idempotent via unique index).
  await Promise.all(
    participantResults
      .filter((r) => r.isNew)
      .map((r) => recordActivationEvent(r.user.id, "added_to_group")),
  );

  const participants = participantResults.map((r) => r.user);

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

/**
 * Whether an inbound message with this Sendblue message handle has already
 * been recorded. Cheap pre-check the webhook handler uses to skip a retried
 * delivery *before* doing any work at all. Not sufficient on its own to
 * guarantee at-most-once processing under concurrent deliveries -- see
 * `claimInboundMessage`, which is the actual atomic guard.
 */
export async function hasMessageWithHandle(sendblueMessageHandle: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(eq(messagesTable.sendblueMessageHandle, sendblueMessageHandle));
  return Boolean(existing);
}

/**
 * Atomically claims an inbound message by its Sendblue message handle:
 * inserts the message row, relying on the unique constraint on
 * `sendblueMessageHandle` to make exactly one concurrent caller win. Returns
 * the inserted row if this call claimed it, or `null` if another delivery
 * (near-simultaneous retry) already claimed it first.
 *
 * The webhook handler must call this -- and check the result -- *before*
 * running any side effects (group intro, disclosure welcomes, agent turn),
 * not just the cheaper `hasMessageWithHandle` pre-check, or two
 * near-simultaneous retries of the same delivery can both pass the
 * pre-check and both run those side effects before either insert lands.
 */
export async function claimInboundMessage(params: {
  threadId: number;
  userId: number | null;
  content: string;
  sendblueMessageHandle: string;
  rawPayload?: unknown;
}): Promise<Message | null> {
  const [message] = await db
    .insert(messagesTable)
    .values({
      threadId: params.threadId,
      userId: params.userId,
      direction: "inbound",
      role: "user",
      content: params.content,
      sendblueMessageHandle: params.sendblueMessageHandle,
      rawPayload: params.rawPayload ?? null,
    })
    .onConflictDoNothing({ target: messagesTable.sendblueMessageHandle })
    .returning();
  return message ?? null;
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

// ─── Instant group creation — participant resolution ──────────────────────────

/**
 * Pure resolution logic (no DB): maps participant names to phones using a
 * pre-built contact map. Exported for unit testing.
 *
 * Invariants:
 * - Explicit phones are always included regardless of name-lookup outcome.
 * - Ambiguous names (map value `null`) are never auto-resolved.
 * - A name is only flagged `unknown` if it cannot be resolved AND the total
 *   number of explicit phones doesn't already cover that participant (coverage
 *   is by count, since names and phones are parallel-but-unordered).
 */
export function resolveParticipantsFromContacts(
  participantNames: string[],
  participantPhones: string[],
  /** name.toLowerCase() → phone, or null when multiple contacts share the name */
  contactNameToPhone: Map<string, string | null>,
): { resolvedPhones: string[]; ambiguousNames: string[]; unknownNames: string[] } {
  const resolvedPhones = new Set<string>(participantPhones.filter((p) => p.trim().length > 0));
  const ambiguousNames: string[] = [];

  for (const name of participantNames) {
    const phone = contactNameToPhone.get(name.toLowerCase());
    if (phone !== undefined && phone !== null) {
      resolvedPhones.add(phone); // unique, unambiguous match
    } else if (phone === null) {
      ambiguousNames.push(name); // multiple contacts — never auto-pick
    }
    // phone === undefined → not in sender's contacts; may be covered by an explicit phone
  }

  // Coverage gap: participants not covered by any phone source.
  const explicitCount = participantPhones.filter((p) => p.trim().length > 0).length;
  const nameResolvedCount = resolvedPhones.size - explicitCount;
  // shortfall = names that have neither an explicit phone nor a name resolution
  const shortfall = participantNames.length - explicitCount - nameResolvedCount - ambiguousNames.length;

  const unknownNames: string[] = [];
  if (shortfall > 0) {
    let remaining = shortfall;
    for (const name of participantNames) {
      if (remaining <= 0) break;
      if (!contactNameToPhone.has(name.toLowerCase())) {
        unknownNames.push(name);
        remaining--;
      }
    }
  }

  return { resolvedPhones: [...resolvedPhones], ambiguousNames, unknownNames };
}

/**
 * Resolves participant names to phone numbers for group creation. Scopes the
 * display-name lookup to contacts in threads the sender already shares with
 * others — never a global user scan — and requires an unambiguous match
 * (duplicate display names are flagged rather than resolved arbitrarily).
 */
export async function resolveGroupParticipants(
  senderUserId: number,
  participantNames: string[],
  participantPhones: string[],
): Promise<{ resolvedPhones: string[]; ambiguousNames: string[]; unknownNames: string[] }> {
  const explicitPhones = participantPhones.filter((p) => p.trim().length > 0);

  // Fast path: explicit phones already cover every named participant.
  if (explicitPhones.length >= participantNames.length) {
    return { resolvedPhones: explicitPhones, ambiguousNames: [], unknownNames: [] };
  }

  // Scope the name lookup to threads the sender is already part of.
  const senderThreadIds = await db
    .select({ threadId: threadParticipantsTable.threadId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.userId, senderUserId))
    .then((rows) => rows.map((r) => r.threadId));

  const nameToPhone = new Map<string, string | null>();
  if (senderThreadIds.length > 0) {
    const contactRows = await db
      .select({ displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
      .from(threadParticipantsTable)
      .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
      .where(
        and(
          inArray(threadParticipantsTable.threadId, senderThreadIds),
          isNotNull(usersTable.phoneNumber),
          isNotNull(usersTable.displayName),
        ),
      );

    // Deduplicate by phone number (stable identity) before building the
    // name→phone map. The same contact can appear in multiple shared threads,
    // and naive row-iteration would mark them ambiguous on the second occurrence
    // even though there is only one real person.
    const uniqueContacts = new Map<string, string>(); // phone → displayName
    for (const { displayName, phoneNumber } of contactRows) {
      if (!displayName || !phoneNumber) continue;
      if (!uniqueContacts.has(phoneNumber)) {
        uniqueContacts.set(phoneNumber, displayName);
      }
    }

    // Now build name→phone from the deduplicated set; genuine duplicate names
    // (two different people with the same display name) remain ambiguous (null).
    for (const [phone, name] of uniqueContacts) {
      const key = name.toLowerCase();
      nameToPhone.set(key, nameToPhone.has(key) ? null : phone);
    }
  }

  return resolveParticipantsFromContacts(participantNames, explicitPhones, nameToPhone);
}

export async function getOtherParticipants(threadId: number, excludingUserId: number) {
  return db
    .select({ user: usersTable, role: threadParticipantsTable.role })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(and(eq(threadParticipantsTable.threadId, threadId)))
    .then((rows) => rows.filter((row) => row.user.id !== excludingUserId));
}
