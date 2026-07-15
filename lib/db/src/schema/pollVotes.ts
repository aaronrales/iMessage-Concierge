import { pgTable, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pollsTable } from "./polls";
import { pollOptionsTable } from "./pollOptions";
import { usersTable } from "./users";

export const pollVotesTable = pgTable(
  "poll_votes",
  {
    id: serial("id").primaryKey(),
    pollId: integer("poll_id")
      .notNull()
      .references(() => pollsTable.id, { onDelete: "cascade" }),
    optionId: integer("option_id")
      .notNull()
      .references(() => pollOptionsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // "choice" polls always have exactly one row per (pollId, userId), enforced
  // in application code (recordVote deletes-then-inserts). "date" polls allow
  // several rows per (pollId, userId) -- one per date the voter says works --
  // so the unique constraint is on the full triple to prevent exact dupes
  // while still allowing multi-select.
  (table) => [unique().on(table.pollId, table.userId, table.optionId)],
);

export const insertPollVoteSchema = createInsertSchema(pollVotesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPollVote = z.infer<typeof insertPollVoteSchema>;
export type PollVote = typeof pollVotesTable.$inferSelect;
