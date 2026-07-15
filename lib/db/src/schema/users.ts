import { pgTable, text, serial, timestamp, pgEnum, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

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
