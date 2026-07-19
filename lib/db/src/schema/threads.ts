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
  // Set once the group's one-time "I'm this group's AI concierge" intro has
  // been sent, so it never repeats even as new members join later (new
  // members instead get a short one-line welcome, see thread_participants).
  introducedAt: timestamp("introduced_at", { withTimezone: true }),
  // Best-effort home city for this group, used to localize weather lookups
  // for the serendipity feature. Backfilled from a confirmed booking's
  // `details.city` when known; falls back to a default city when null.
  homeCity: text("home_city"),
  // Set once the one-time "everyone's set up" onboarding recap has been sent
  // for this group, so it fires exactly once when the last member completes
  // onboarding rather than once per person.
  onboardingRecapSentAt: timestamp("onboarding_recap_sent_at", { withTimezone: true }),
  /**
   * Admin-authored free-text instructions for this specific thread. Injected
   * into the agent's system prompt on every future turn so ops can steer
   * poorly-performing threads without editing code. E.g. "this group hates
   * loud venues" or "always suggest places in Brooklyn".
   */
  adminNotes: text("admin_notes"),
  /**
   * Set to true when a user sends a support-flag phrase ("this is broken",
   * "contact support", etc.). Surfaced prominently on the Threads dashboard so
   * ops cannot accidentally miss a thread that needs attention. Cleared by ops
   * clicking "Resolved" in the detail pane.
   */
  needsAttention: boolean("needs_attention").notNull().default(false),
  /** Timestamp of the most recent time needsAttention was set to true. Null when never flagged or after resolution. */
  needsAttentionAt: timestamp("needs_attention_at", { withTimezone: true }),
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
