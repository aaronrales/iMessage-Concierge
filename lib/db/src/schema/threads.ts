import { pgTable, text, serial, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const threadsTable = pgTable("threads", {
  id: serial("id").primaryKey(),
  // Sendblue's group identifier. Null for 1:1 threads.
  sendblueGroupId: text("sendblue_group_id").unique(),
  // For 1:1 threads, the other party's phone number. Used to look up an
  // existing thread by phone number since there is no group id.
  primaryPhoneNumber: text("primary_phone_number").unique(),
  isGroup: boolean("is_group").notNull().default(false),
  title: text("title"),
  // Set while a post-plan "how was it?" prompt is outstanding for this
  // thread, so the webhook handler knows the next reply is a feedback answer
  // rather than a normal conversational turn. No FK to `plansTable` here to
  // avoid a schema import cycle (plans.ts already imports threads.ts); the
  // relationship is enforced in application code instead.
  pendingFeedbackPlanId: integer("pending_feedback_plan_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertThreadSchema = createInsertSchema(threadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertThread = z.infer<typeof insertThreadSchema>;
export type Thread = typeof threadsTable.$inferSelect;
