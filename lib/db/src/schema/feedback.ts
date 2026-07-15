import { pgTable, serial, integer, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";
import { usersTable } from "./users";
import { plansTable } from "./plans";

/**
 * The outcomes table: the input to the taste engine (Phase 3) and the record
 * that "continuously learning" is a real mechanism. Later phases write rating
 * replies, poll-winner outcomes, and suggestion accept/ignore signals here;
 * nothing writes to it yet in Phase 0.
 */
export const feedbackKindEnum = pgEnum("feedback_kind", [
  "rating",
  "poll_winner",
  "suggestion_accepted",
  "suggestion_ignored",
  "free_text",
]);

export const feedbackTable = pgTable("feedback", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  planId: integer("plan_id").references(() => plansTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  kind: feedbackKindEnum("kind").notNull(),
  // Shape depends on `kind`, e.g. { rating: 4 }, { text: "..." }, { optionLabel: "..." }.
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertFeedbackSchema = createInsertSchema(feedbackTable).omit({
  id: true,
  createdAt: true,
});
export type InsertFeedback = z.infer<typeof insertFeedbackSchema>;
export type Feedback = typeof feedbackTable.$inferSelect;
