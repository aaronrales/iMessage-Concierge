import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { messagesTable } from "./messages";
import { threadsTable } from "./threads";

/**
 * Admin ratings on individual agent turns. Each row corresponds to one
 * assistant message and captures a thumbs-up / thumbs-down signal plus an
 * optional failure tag and free-text notes. Used by the ops dashboard Turns
 * page to turn dogfood sessions into structured prompt-improvement signal.
 *
 * One row per message (upserted on repeat ratings). The message cascade
 * means ratings are automatically removed if the message is deleted.
 */
export const turnRatingsTable = pgTable("turn_ratings", {
  id: serial("id").primaryKey(),
  /** The assistant message being rated. */
  messageId: integer("message_id")
    .notNull()
    .unique()
    .references(() => messagesTable.id, { onDelete: "cascade" }),
  /** Denormalised for fast per-thread queries without joining messages. */
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  /** "thumbs_up" or "thumbs_down" */
  rating: text("rating").notNull(),
  /**
   * Why did this turn fail? One of a fixed vocabulary:
   * wrong_venue | missed_context | wrong_tone | too_long | off_topic | other
   * Null for thumbs-up ratings.
   */
  failureTag: text("failure_tag"),
  /** Admin free-text notes — also used to steer the thread. */
  notes: text("notes"),
  ratedAt: timestamp("rated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TurnRating = typeof turnRatingsTable.$inferSelect;
