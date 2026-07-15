import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, bookingsTable, usersTable } from "@workspace/db";
import {
  ApproveBookingParams,
  ApproveBookingResponse,
  GetBookingParams,
  GetBookingResponse,
  ListBookingsQueryParams,
  ListBookingsResponse,
  RejectBookingParams,
  RejectBookingResponse,
} from "@workspace/api-zod";
import { confirmBooking, rejectBookingRecord } from "../lib/agent/bookings";
import { sendDirectMessage, sendGroupMessage } from "../lib/sendblue";
import { threadsTable } from "@workspace/db";
import { recordMessage } from "../lib/agent/context";

const router: IRouter = Router();

async function withApproverPhone(booking: typeof bookingsTable.$inferSelect) {
  if (!booking.approverUserId) {
    return { ...booking, approverPhoneNumber: null };
  }
  const [approver] = await db.select().from(usersTable).where(eq(usersTable.id, booking.approverUserId));
  return { ...booking, approverPhoneNumber: approver?.phoneNumber ?? null };
}

router.get("/bookings", async (req, res): Promise<void> => {
  const query = ListBookingsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db.select().from(bookingsTable).orderBy(bookingsTable.createdAt);
  const filtered = query.data.status ? rows.filter((row) => row.status === query.data.status) : rows;
  const withPhones = await Promise.all(filtered.map(withApproverPhone));

  res.json(ListBookingsResponse.parse(withPhones));
});

router.get("/bookings/:id", async (req, res): Promise<void> => {
  const params = GetBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [booking] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, params.data.id));
  if (!booking) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }

  res.json(GetBookingResponse.parse(await withApproverPhone(booking)));
});

async function notifyThread(threadId: number, content: string): Promise<void> {
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
  if (!thread) return;

  try {
    if (thread.isGroup && thread.sendblueGroupId) {
      await sendGroupMessage({ groupId: thread.sendblueGroupId, content });
    } else if (thread.primaryPhoneNumber) {
      await sendDirectMessage({ to: thread.primaryPhoneNumber, content });
    }
  } catch {
    // Outbound send failures are logged inside the sendblue client; the
    // booking decision itself should still succeed.
  }

  await recordMessage({ threadId, userId: null, direction: "outbound", role: "assistant", content });
}

router.patch("/bookings/:id/approve", async (req, res): Promise<void> => {
  const params = ApproveBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (existing.status !== "pending_approval") {
    res.status(409).json({ error: `Booking is ${existing.status}, not pending approval` });
    return;
  }

  const booking = await confirmBooking(params.data.id);
  await notifyThread(booking.threadId, `Confirmed: "${booking.title}". I'll follow up here once it's actually locked in with the venue.`);

  res.json(ApproveBookingResponse.parse(await withApproverPhone(booking)));
});

router.patch("/bookings/:id/reject", async (req, res): Promise<void> => {
  const params = RejectBookingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [existing] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Booking not found" });
    return;
  }
  if (existing.status !== "pending_approval") {
    res.status(409).json({ error: `Booking is ${existing.status}, not pending approval` });
    return;
  }

  const booking = await rejectBookingRecord(params.data.id);
  await notifyThread(booking.threadId, `No problem, I've dropped "${booking.title}".`);

  res.json(RejectBookingResponse.parse(await withApproverPhone(booking)));
});

export default router;
