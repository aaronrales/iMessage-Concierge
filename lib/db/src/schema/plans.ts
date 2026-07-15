import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";

// proposed -> deciding -> confirmed -> done is the happy path; cancelled can
// happen from proposed or deciding.
export const planStatusEnum = pgEnum("plan_status", ["proposed", "deciding", "confirmed", "done", "cancelled"]);

/**
 * The anchor object for a real-world plan. Polls, bookings, reminders,
 * feedback, and memory all hang off a plan -- see `planId` on `pollsTable`
 * and `bookingsTable`. Nothing populates this with rich data yet in Phase 0;
 * later phases progress it through its status lifecycle.
 */
export const plansTable = pgTable("plans", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  venue: text("venue"),
  // User ids of expected/confirmed attendees.
  attendeeUserIds: jsonb("attendee_user_ids").$type<number[]>().notNull().default([]),
  status: planStatusEnum("status").notNull().default("proposed"),
  // Set when the weather-rescue nudge is sent for this plan, so the scan
  // never repeats for the same plan even if rain persists.
  weatherRescueSentAt: timestamp("weather_rescue_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertPlanSchema = createInsertSchema(plansTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type Plan = typeof plansTable.$inferSelect;
