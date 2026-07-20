import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Tracks forward-looking commitments the agent makes when it hands off to an
 * async tool (JIT venue/lodging extraction). When the agent says "I'll pull
 * together hotel options" and kicks off a background job, a row is inserted
 * here. The completion handler delivers results back to the thread and marks
 * the row delivered. A scheduler scan finds rows past expectedByAt and either
 * re-tries delivery (if the underlying job finished) or sends a fallback
 * apology message so no promise ever goes permanently silent.
 *
 * kind values:
 *   "venue_options"   — JIT venue extraction for a non-NYC destination
 *   "lodging_options" — lodging search results for a trip destination
 */
export const pendingDeliverablesTable = pgTable("pending_deliverables", {
  id: serial("id").primaryKey(),
  /** Thread to deliver results back to. */
  threadId: integer("thread_id").notNull(),
  /** Optional project context (useful for follow-up agent turns). */
  projectId: integer("project_id"),
  /**
   * What type of result was promised.
   * "venue_options" | "lodging_options" | "destination_options"
   */
  kind: text("kind").notNull(),
  /** The exact text the agent sent to the user (e.g. "I'll pull together some hotel options"). */
  promisedText: text("promised_text").notNull(),
  /**
   * Normalized destination key (lowercase) used to match back to JIT extraction
   * results. E.g. "lake como, italy". Null for kinds not tied to a destination.
   */
  destinationKey: text("destination_key"),
  /**
   * Lifecycle:
   *  pending    → waiting for the background job
   *  delivered  → results sent to thread
   *  failed     → background job failed; fallback sent
   *  timed_out  → past expectedByAt; backstop message sent
   */
  status: text("status").notNull().default("pending"),
  /**
   * Short SLA — createdAt + 3–5 min. The scheduler scan fires backstop
   * messages for rows still pending after this timestamp.
   */
  expectedByAt: timestamp("expected_by_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  /** Structured payload stored on delivery for auditing (not sent to the user). */
  deliveryContent: jsonb("delivery_content"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PendingDeliverable = typeof pendingDeliverablesTable.$inferSelect;
export type NewPendingDeliverable = typeof pendingDeliverablesTable.$inferInsert;
