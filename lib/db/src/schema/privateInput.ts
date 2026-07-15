import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";
import { plansTable } from "./plans";
import { usersTable } from "./users";

/**
 * A sensitive question the concierge needs answered by each group member
 * privately (over DM) rather than in the group -- e.g. "what's a realistic
 * amount to chip in for the gift?". Only the aggregate result (see
 * `aggregateSummary`) is ever surfaced back to the group; individual
 * `privateInputResponses` rows are never shown verbatim outside this table.
 */
export const privateInputRequestsTable = pgTable("private_input_requests", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  planId: integer("plan_id").references(() => plansTable.id, { onDelete: "set null" }),
  question: text("question").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  aggregateSummary: text("aggregate_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPrivateInputRequestSchema = createInsertSchema(privateInputRequestsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPrivateInputRequest = z.infer<typeof insertPrivateInputRequestSchema>;
export type PrivateInputRequest = typeof privateInputRequestsTable.$inferSelect;

export const privateInputResponsesTable = pgTable("private_input_responses", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id")
    .notNull()
    .references(() => privateInputRequestsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  answer: text("answer").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPrivateInputResponseSchema = createInsertSchema(privateInputResponsesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPrivateInputResponse = z.infer<typeof insertPrivateInputResponseSchema>;
export type PrivateInputResponse = typeof privateInputResponsesTable.$inferSelect;
