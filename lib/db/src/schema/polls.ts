import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";

export const pollStatusEnum = pgEnum("poll_status", ["open", "closed"]);

export const pollsTable = pgTable("polls", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  status: pollStatusEnum("status").notNull().default("open"),
  winningOptionId: integer("winning_option_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertPollSchema = createInsertSchema(pollsTable).omit({
  id: true,
  createdAt: true,
  closedAt: true,
});
export type InsertPoll = z.infer<typeof insertPollSchema>;
export type Poll = typeof pollsTable.$inferSelect;
