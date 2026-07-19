import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  db,
  projectLedgerEntriesTable,
  projectsTable,
  threadParticipantsTable,
  usersTable,
  PROJECT_ACTIVE_STATUSES,
  type Project,
  type ProjectLedgerEntry,
} from "@workspace/db";
import { logger } from "../logger";

/**
 * Money ledger for a project. Tracks per-person estimates (what they owe),
 * commitments (who's in), and confirmed payments (who settled up).
 *
 * Design principles:
 *   - Amounts in cents throughout to avoid floating-point rounding.
 *   - Agent never claims to hold or process money. Language must reflect that.
 *   - Organizer is always the implicit creditor; the model is member ↔ organizer.
 *   - Each estimate row is per-person (one row per member, computed from total ÷ headcount).
 *   - Outstanding = SUM(estimate) – SUM(payment_recorded) per person.
 */

// ── Payment deep links ────────────────────────────────────────────────────────

/**
 * Builds a Venmo payment-request URL pre-filled with amount and note.
 * Format: https://venmo.com/?txn=pay&note={note}&amount={dollars}
 * No Venmo API integration — this is a standard web deep link that opens
 * the Venmo app (or website) with the fields pre-filled. The recipient
 * must tap "Request" themselves.
 *
 * @param amountCents — amount in cents (integer, e.g. 30000 for $300.00)
 * @param note        — short description shown in the Venmo transaction feed
 */
export function buildVenmoLink(amountCents: number, note: string): string {
  const dollars = (amountCents / 100).toFixed(2);
  const url = new URL("https://venmo.com/");
  url.searchParams.set("txn", "pay");
  url.searchParams.set("note", note.slice(0, 280)); // Venmo note max
  url.searchParams.set("amount", dollars);
  return url.toString();
}

/**
 * Returns a Zelle instruction string. Zelle has no public universal deep link;
 * it opens through bank apps via their own schemes. The standard approach is
 * to tell the recipient the phone number or email to send to.
 *
 * @param recipientPhone — organizer's phone number (the person who should receive)
 * @param amountCents    — amount in cents
 */
export function buildZelleInstruction(recipientPhone: string, amountCents: number): string {
  const dollars = formatDollars(amountCents);
  return `Zelle ${dollars} to ${recipientPhone}`;
}

/** Formats cents as a dollar string, e.g. 30000 → "$300.00" (omits cents when even). */
export function formatDollars(amountCents: number): string {
  const dollars = amountCents / 100;
  if (amountCents % 100 === 0) return `$${(dollars).toFixed(0)}`;
  return `$${dollars.toFixed(2)}`;
}

/**
 * Builds the full 1:1 DM message sent to a group member requesting payment.
 * Includes Venmo deep link; Zelle instruction if organizer phone is provided.
 * Never implies the agent holds funds or guarantees collection.
 *
 * @param recipientName   — member's display name (or phone if unknown)
 * @param amountCents     — their share in cents
 * @param note            — e.g. "Airbnb house deposit for the bachelorette"
 * @param organizerName   — display name of the organizer they should pay
 * @param organizerPhone  — organizer's phone for Zelle instruction (optional)
 */
export function buildPaymentRequestMessage(
  recipientName: string,
  amountCents: number,
  note: string,
  organizerName: string,
  organizerPhone?: string | null,
): string {
  const venmoLink = buildVenmoLink(amountCents, note);
  const amount = formatDollars(amountCents);
  const lines: string[] = [
    `Hey ${recipientName} — ${organizerName} asked me to send over the payment info for the trip.`,
    `Your share: ${amount} (${note})`,
    `Venmo: ${venmoLink}`,
  ];
  if (organizerPhone) {
    lines.push(buildZelleInstruction(organizerPhone, amountCents));
  }
  lines.push("Let me know if you have any questions about the amount.");
  return lines.join("\n");
}

// ── DB write helpers ───────────────────────────────────────────────────────────

/**
 * Records one estimate row per provided userId. Used when the organizer
 * tells the agent "the house was $2,400, split across 8" — this splits the
 * total by headcount and creates per-person estimate entries.
 *
 * If headcount differs from the actual participant list (e.g. some guests
 * aren't in the thread), use the specified headcount for math and create
 * rows only for the provided userIds.
 *
 * @param projectId     — project to attach entries to
 * @param userIds       — member user IDs to create estimate rows for
 * @param perPersonCents — each person's share in cents
 * @param note          — e.g. "Airbnb house deposit"
 */
export async function recordEstimates(
  projectId: number,
  userIds: number[],
  perPersonCents: number,
  note: string,
): Promise<ProjectLedgerEntry[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .insert(projectLedgerEntriesTable)
    .values(userIds.map((userId) => ({ projectId, kind: "estimate" as const, userId, amountCents: perPersonCents, note })))
    .returning();
  logger.info({ projectId, count: rows.length, perPersonCents }, "Ledger estimates recorded");
  return rows;
}

/**
 * Records a commitment entry (member has confirmed they're attending).
 * Commitments don't have an amount — they're headcount signals.
 */
export async function recordCommitment(projectId: number, userId: number, note?: string): Promise<ProjectLedgerEntry> {
  const [row] = await db
    .insert(projectLedgerEntriesTable)
    .values({ projectId, kind: "commitment", userId, amountCents: null, note: note ?? null })
    .returning();
  if (!row) throw new Error("Failed to record commitment");
  return row;
}

/**
 * Records that the organizer has received payment from a specific member.
 * The organizer says "Jake paid me" — this logs the receipt.
 *
 * If amountCents is null, it defaults to the member's outstanding estimate
 * balance (full settlement). The caller should resolve this before calling.
 */
export async function recordPayment(
  projectId: number,
  userId: number,
  amountCents: number,
  note: string,
): Promise<ProjectLedgerEntry> {
  const [row] = await db
    .insert(projectLedgerEntriesTable)
    .values({ projectId, kind: "payment_recorded", userId, amountCents, note })
    .returning();
  if (!row) throw new Error("Failed to record payment");
  logger.info({ projectId, userId, amountCents }, "Payment recorded in ledger");
  return row;
}

/** Marks an estimate row's payment request as sent (so it isn't sent again). */
export async function markRequestSent(entryId: number): Promise<void> {
  await db
    .update(projectLedgerEntriesTable)
    .set({ requestSentAt: new Date() })
    .where(eq(projectLedgerEntriesTable.id, entryId));
}

/** Records the last-nudged timestamp on all estimate rows for a user in a project. */
export async function markPaymentNudgeSent(projectId: number, userId: number): Promise<void> {
  await db
    .update(projectLedgerEntriesTable)
    .set({ lastNudgedAt: new Date() })
    .where(
      and(
        eq(projectLedgerEntriesTable.projectId, projectId),
        eq(projectLedgerEntriesTable.userId, userId),
        eq(projectLedgerEntriesTable.kind, "estimate"),
      ),
    );
}

// ── Balance computation ────────────────────────────────────────────────────────

export interface MemberBalance {
  userId: number;
  displayName: string | null;
  phoneNumber: string;
  estimatedCents: number;    // total they're expected to contribute
  paidCents: number;         // total organizer has confirmed received
  outstandingCents: number;  // estimatedCents - paidCents (≥ 0)
  lastNudgedAt: Date | null;
  /** Earliest estimate entry for this member — used by scheduler grace-period check. */
  oldestEstimateAt: Date | null;
}

export interface LedgerSummary {
  totalEstimatedCents: number;
  totalCollectedCents: number;
  outstandingCount: number;  // number of members with outstandingCents > 0
  balances: MemberBalance[];
}

/**
 * Computes per-member balances for a project. Only includes members who have
 * at least one estimate entry (i.e. they owe something). Members who have
 * paid in full still appear with outstandingCents = 0.
 */
export async function getLedgerBalances(projectId: number): Promise<MemberBalance[]> {
  // Pull all estimate and payment_recorded entries for this project.
  const entries = await db
    .select()
    .from(projectLedgerEntriesTable)
    .where(
      and(
        eq(projectLedgerEntriesTable.projectId, projectId),
        isNotNull(projectLedgerEntriesTable.userId),
      ),
    );

  if (entries.length === 0) return [];

  // Collect unique userIds from entries.
  const userIds = [...new Set(entries.map((e) => e.userId!))];

  // Load user display names and phone numbers in one query.
  const users = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
    .from(usersTable)
    .where(sql`${usersTable.id} = ANY(ARRAY[${sql.join(userIds.map((id) => sql`${id}`), sql`, `)}]::int[])`);

  const userMap = new Map(users.map((u) => [u.id, u]));

  // Group entries by userId.
  const byUser = new Map<
    number,
    { estimates: number[]; payments: number[]; lastNudgedAt: Date | null; oldestEstimateAt: Date | null }
  >();
  for (const e of entries) {
    const uid = e.userId!;
    if (!byUser.has(uid)) byUser.set(uid, { estimates: [], payments: [], lastNudgedAt: null, oldestEstimateAt: null });
    const bucket = byUser.get(uid)!;
    if (e.kind === "estimate" && e.amountCents != null) {
      bucket.estimates.push(e.amountCents);
      // Track the earliest estimate creation date per member for grace-period checks.
      if (!bucket.oldestEstimateAt || e.createdAt < bucket.oldestEstimateAt) {
        bucket.oldestEstimateAt = e.createdAt;
      }
    }
    if (e.kind === "payment_recorded" && e.amountCents != null) bucket.payments.push(e.amountCents);
    if (e.kind === "estimate" && e.lastNudgedAt) {
      if (!bucket.lastNudgedAt || e.lastNudgedAt > bucket.lastNudgedAt) bucket.lastNudgedAt = e.lastNudgedAt;
    }
  }

  const balances: MemberBalance[] = [];
  for (const [userId, bucket] of byUser.entries()) {
    const estimatedCents = bucket.estimates.reduce((a, b) => a + b, 0);
    if (estimatedCents === 0) continue; // commitment-only user, no owed amount
    const paidCents = bucket.payments.reduce((a, b) => a + b, 0);
    const outstandingCents = Math.max(0, estimatedCents - paidCents);
    const user = userMap.get(userId);
    if (!user) continue;
    balances.push({
      userId,
      displayName: user.displayName,
      phoneNumber: user.phoneNumber,
      estimatedCents,
      paidCents,
      outstandingCents,
      lastNudgedAt: bucket.lastNudgedAt,
      oldestEstimateAt: bucket.oldestEstimateAt,
    });
  }

  // Sort: outstanding members first, then fully-paid.
  return balances.sort((a, b) => b.outstandingCents - a.outstandingCents);
}

/** Compact ledger summary for API responses and engine prompt. Returns null when no estimates exist. */
export async function getLedgerSummary(projectId: number): Promise<LedgerSummary | null> {
  const balances = await getLedgerBalances(projectId);
  if (balances.length === 0) return null;

  const totalEstimatedCents = balances.reduce((s, b) => s + b.estimatedCents, 0);
  const totalCollectedCents = balances.reduce((s, b) => s + b.paidCents, 0);
  const outstandingCount = balances.filter((b) => b.outstandingCents > 0).length;

  return { totalEstimatedCents, totalCollectedCents, outstandingCount, balances };
}

/**
 * Builds the ledger section for the engine system-prompt block so the LLM
 * can answer "who still owes me?" accurately without accessing the DB itself.
 * Returns null when no estimates have been recorded for this project.
 */
export async function buildLedgerPromptSection(projectId: number): Promise<string | null> {
  const summary = await getLedgerSummary(projectId);
  if (!summary) return null;

  const lines = summary.balances.map((b) => {
    const status = b.outstandingCents > 0
      ? `owes ${formatDollars(b.outstandingCents)} of ${formatDollars(b.estimatedCents)}`
      : `paid in full (${formatDollars(b.paidCents)})`;
    return `  - ${b.displayName ?? b.phoneNumber}: ${status}`;
  });

  return (
    `Payment ledger (${formatDollars(summary.totalCollectedCents)} collected` +
    ` of ${formatDollars(summary.totalEstimatedCents)} estimated,` +
    ` ${summary.outstandingCount} outstanding):\n` +
    lines.join("\n") +
    `\nNOTE: These are self-reported facts from the organizer. The agent does not hold or process any money.`
  );
}

// ── Scheduler helpers ─────────────────────────────────────────────────────────

/** Grace period before the first payment nudge fires after an estimate is recorded. */
export const PAYMENT_NUDGE_GRACE_DAYS = 3;
/** Minimum days between repeat nudges for the same member. */
export const PAYMENT_NUDGE_REPEAT_DAYS = 5;

export interface OutstandingBalance {
  projectId: number;
  threadId: number;
  organizerUserId: number | null;
  organizerPhone: string | null;
  organizerName: string | null;
  member: MemberBalance;
}

/**
 * Returns all project+member pairs with outstanding balances that are past
 * the grace period and haven't been nudged recently.
 * Used by the daily payment-nudge scheduler scan.
 *
 * Grace-period enforcement is per-member: a member is only eligible if THEIR
 * oldest estimate entry is older than PAYMENT_NUDGE_GRACE_DAYS, regardless of
 * whether other members in the same project have older estimates. This prevents
 * members whose costs were added mid-trip from receiving early nudges.
 */
export async function getOutstandingBalancesForNudge(): Promise<OutstandingBalance[]> {
  const graceCutoff = new Date(Date.now() - PAYMENT_NUDGE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const nudgeCutoff = new Date(Date.now() - PAYMENT_NUDGE_REPEAT_DAYS * 24 * 60 * 60 * 1000);

  // Get active project IDs that have at least one estimate entry (any age).
  // We can't filter by age at project level — that must be done per-member below.
  const projectRows = await db
    .selectDistinct({ projectId: projectLedgerEntriesTable.projectId })
    .from(projectLedgerEntriesTable)
    .where(
      and(
        eq(projectLedgerEntriesTable.kind, "estimate"),
        isNotNull(projectLedgerEntriesTable.userId),
      ),
    );

  if (projectRows.length === 0) return [];

  // Filter to active projects only.
  const projects = await db
    .select()
    .from(projectsTable)
    .where(
      sql`${projectsTable.id} = ANY(ARRAY[${sql.join(projectRows.map((r) => sql`${r.projectId}`), sql`, `)}]::int[]) AND ${projectsTable.status} = ANY(ARRAY[${sql.join(PROJECT_ACTIVE_STATUSES.map((s) => sql`${s}`), sql`, `)}]::text[])`,
    );

  const result: OutstandingBalance[] = [];

  for (const project of projects) {
    const balances = await getLedgerBalances(project.id);
    const outstanding = balances.filter(
      (b) =>
        b.outstandingCents > 0 &&
        // Per-member grace period: this member's own oldest estimate must be old enough.
        b.oldestEstimateAt !== null &&
        b.oldestEstimateAt < graceCutoff &&
        // Not nudged recently (or never nudged).
        (!b.lastNudgedAt || b.lastNudgedAt < nudgeCutoff),
    );

    if (outstanding.length === 0) continue;

    // Load organizer info once per project.
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

    for (const member of outstanding) {
      result.push({
        projectId: project.id,
        threadId: project.threadId,
        organizerUserId: project.organizerUserId,
        organizerPhone,
        organizerName,
        member,
      });
    }
  }

  return result;
}

/**
 * Finds a user in the given thread by display name (case-insensitive, partial
 * match OK). Returns the first match or null if not found.
 * Used by the organizer sidebar to resolve "Jake paid me" → userId.
 */
export async function findThreadMemberByName(
  threadId: number,
  name: string,
): Promise<{ userId: number; displayName: string | null; phoneNumber: string } | null> {
  const participants = await db
    .select({ id: usersTable.id, displayName: usersTable.displayName, phoneNumber: usersTable.phoneNumber })
    .from(threadParticipantsTable)
    .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id))
    .where(eq(threadParticipantsTable.threadId, threadId));

  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;

  // 1. Exact match on non-empty display name.
  const exact = participants.find(
    (p) => p.displayName?.trim().toLowerCase() === normalized,
  );
  if (exact) return { userId: exact.id, displayName: exact.displayName, phoneNumber: exact.phoneNumber };

  // 2. Prefix/substring match — only against participants who have a non-empty
  //    display name. Participants with null/empty display names are never matched
  //    on a partial basis because the empty-string edge case (`"".includes(x)` or
  //    `x.includes("")`) would produce false positives on arbitrary organizer input.
  const partial = participants.find((p) => {
    const dn = p.displayName?.trim().toLowerCase();
    if (!dn) return false; // skip participants with no display name
    return dn.includes(normalized) || normalized.includes(dn);
  });
  return partial ? { userId: partial.id, displayName: partial.displayName, phoneNumber: partial.phoneNumber } : null;
}

/**
 * Returns the thread participant user IDs for a project's group thread,
 * excluding the organizer (who is the creditor, not a debtor).
 */
export async function getProjectMemberIds(threadId: number, organizerUserId: number | null): Promise<number[]> {
  const rows = await db
    .select({ userId: threadParticipantsTable.userId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.threadId, threadId));
  return rows.map((r) => r.userId).filter((id) => id !== organizerUserId);
}
