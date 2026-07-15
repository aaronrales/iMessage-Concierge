import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { threadsTable } from "./threads";
import { plansTable } from "./plans";

export const bookingStatusEnum = pgEnum("booking_status", [
  "drafted",
  "pending_approval",
  "approved",
  "rejected",
  "confirmed",
]);

export const bookingsTable = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => threadsTable.id, { onDelete: "cascade" }),
    // Nullable: not every booking anchors to a plan yet (existing flows predate
    // the plans table), but new plan-driven bookings should set this.
    planId: integer("plan_id").references(() => plansTable.id, { onDelete: "set null" }),
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
  },
  (table) => [
    index("bookings_thread_id_idx").on(table.threadId),
    index("bookings_plan_id_idx").on(table.planId),
    index("bookings_created_by_user_id_idx").on(table.createdByUserId),
    index("bookings_approver_user_id_idx").on(table.approverUserId),
    index("bookings_status_idx").on(table.status),
  ],
);

export const insertBookingSchema = createInsertSchema(bookingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  decidedAt: true,
});
export type InsertBooking = z.infer<typeof insertBookingSchema>;
export type Booking = typeof bookingsTable.$inferSelect;
