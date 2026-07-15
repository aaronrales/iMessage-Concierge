import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { threadsTable } from "./threads";

export const bookingStatusEnum = pgEnum("booking_status", [
  "drafted",
  "pending_approval",
  "approved",
  "rejected",
  "confirmed",
]);

export const bookingsTable = pgTable("bookings", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  approverUserId: integer("approver_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  title: text("title").notNull(),
  // Structured booking details, e.g. { venue, date, time, partySize, notes }.
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  status: bookingStatusEnum("status").notNull().default("drafted"),
  // Groundwork for a future real provider integration (OpenTable/Resy/etc).
  // Not called in this build -- provider bookings are simulated once approved.
  provider: text("provider"),
  providerBookingId: text("provider_booking_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const insertBookingSchema = createInsertSchema(bookingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  decidedAt: true,
});
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookingsTable.$inferSelect;
