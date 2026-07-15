import { eq } from "drizzle-orm";
import { db, bookingsTable, type Booking } from "@workspace/db";

export interface DraftBookingInput {
  threadId: number;
  planId?: number | null;
  createdByUserId: number;
  approverUserId: number;
  title: string;
  details: Record<string, unknown>;
}

/** Creates a booking draft and immediately moves it to pending_approval. */
export async function draftBooking(input: DraftBookingInput): Promise<Booking> {
  const [booking] = await db
    .insert(bookingsTable)
    .values({
      threadId: input.threadId,
      planId: input.planId ?? null,
      createdByUserId: input.createdByUserId,
      approverUserId: input.approverUserId,
      title: input.title,
      details: input.details,
      status: "pending_approval",
    })
    .returning();
  if (!booking) throw new Error("Failed to create booking draft");
  return booking;
}

export async function findPendingBookingForApprover(approverUserId: number): Promise<Booking | null> {
  const rows = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.approverUserId, approverUserId));

  const pending = rows.filter((row) => row.status === "pending_approval");
  // Most recent pending booking for this approver.
  pending.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return pending[0] ?? null;
}

/**
 * Marks a booking confirmed. This build does not call a real booking provider
 * yet -- confirmation is simulated, but the provider/providerBookingId fields
 * exist so a future integration can populate them.
 */
export async function confirmBooking(bookingId: number): Promise<Booking> {
  const [booking] = await db
    .update(bookingsTable)
    .set({ status: "confirmed", decidedAt: new Date() })
    .where(eq(bookingsTable.id, bookingId))
    .returning();
  if (!booking) throw new Error(`Booking ${bookingId} not found`);
  return booking;
}

export async function rejectBookingRecord(bookingId: number): Promise<Booking> {
  const [booking] = await db
    .update(bookingsTable)
    .set({ status: "rejected", decidedAt: new Date() })
    .where(eq(bookingsTable.id, bookingId))
    .returning();
  if (!booking) throw new Error(`Booking ${bookingId} not found`);
  return booking;
}

const APPROVE_PATTERN = /\b(yes|yep|yeah|approve|approved|confirm|confirmed|ok|okay|sure|sounds good|do it)\b/i;
const REJECT_PATTERN = /\b(no|nope|reject|rejected|deny|denied|cancel|don'?t)\b/i;

export type ApprovalIntent = "approve" | "reject" | "unclear";

export function detectApprovalIntent(content: string): ApprovalIntent {
  const normalized = content.trim();
  if (REJECT_PATTERN.test(normalized)) return "reject";
  if (APPROVE_PATTERN.test(normalized)) return "approve";
  return "unclear";
}
