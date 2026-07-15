import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { threadsTable } from "./threads";

export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound"]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "system"]);

export const messagesTable = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => threadsTable.id, { onDelete: "cascade" }),
    // Null when the message was sent by the agent itself.
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    direction: messageDirectionEnum("direction").notNull(),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    // Unique (Postgres allows multiple NULLs) so a retried Sendblue webhook
    // delivery for the same inbound message can be detected and skipped
    // instead of being recorded and processed twice. See
    // `hasMessageWithHandle` in context.ts.
    sendblueMessageHandle: text("sendblue_message_handle"),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("messages_thread_id_idx").on(table.threadId),
    unique().on(table.sendblueMessageHandle),
  ],
);

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;
