import { pgTable, serial, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { threadsTable } from "./threads";

export const threadParticipantsTable = pgTable(
  "thread_participants",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => threadsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.threadId, table.userId)],
);

export const insertThreadParticipantSchema = createInsertSchema(threadParticipantsTable).omit({
  id: true,
  joinedAt: true,
});
export type InsertThreadParticipant = z.infer<typeof insertThreadParticipantSchema>;
export type ThreadParticipant = typeof threadParticipantsTable.$inferSelect;
