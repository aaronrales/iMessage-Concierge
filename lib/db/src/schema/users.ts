import { pgTable, text, serial, timestamp, pgEnum, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";

export const onboardingStatusEnum = pgEnum("onboarding_status", [
  "not_started",
  "in_progress",
  "completed",
]);

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  phoneNumber: text("phone_number").notNull().unique(),
  displayName: text("display_name"),
  onboardingStatus: onboardingStatusEnum("onboarding_status").notNull().default("not_started"),
  /**
   * Set to true once a vCard (contact card) has been sent to this user as
   * a media attachment on their first-ever outbound DM. Prevents the contact
   * card from being re-sent on subsequent messages.
   */
  contactCardSent: boolean("contact_card_sent").notNull().default(false),
  /**
   * How this user first entered the funnel. Plain text (not a pg enum) so
   * new acquisition channels never need a migration. Expected values today:
   *   cold_dm   – first 1:1 message from a number we'd never seen
   *   group_add – created as a participant of a group thread
   * Null for legacy rows created before source tracking, and for users
   * created outside the two canonical entry flows (e.g. booking approvers).
   */
  source: text("source"),
  /** Thread that caused this user to be created, when attributable. */
  originThreadId: integer("origin_thread_id").references(() => threadsTable.id, { onDelete: "set null" }),
  /**
   * Set to true by the "forget me" / "delete my data" command. Prevents the
   * concierge from sending any proactive outreach (group intros, disclosure
   * DMs, onboarding nudges) to this user. The user row is kept for referential
   * integrity, but all stored personal data is scrubbed. The user can
   * reactivate by texting the concierge directly.
   */
  doNotContact: boolean("do_not_contact").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
