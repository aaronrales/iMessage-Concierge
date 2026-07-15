import { pgTable, serial, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";
import { usersTable } from "./users";

// Priority order (highest to lowest) that the messaging-budget governor
// enforces: occasion reminders > plan reminders > nudges > serendipity. See
// `canSendProactiveMessage` / `recordProactiveSend` in the agent lib.
export const proactiveMessageCategoryEnum = pgEnum("proactive_message_category", [
  "occasion_reminder",
  "plan_reminder",
  "nudge",
  "serendipity",
]);

/**
 * Log of proactive (agent-initiated, not reply-triggered) messages sent per
 * thread/user. Every proactive feature must check `canSendProactiveMessage`
 * before sending and call `recordProactiveSend` after -- this is the only
 * source of truth the governor reads from.
 */
export const proactiveMessageSendsTable = pgTable("proactive_message_sends", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  // Null when the send targets the whole thread rather than one member.
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  category: proactiveMessageCategoryEnum("category").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertProactiveMessageSendSchema = createInsertSchema(proactiveMessageSendsTable).omit({
  id: true,
  sentAt: true,
});
export type InsertProactiveMessageSend = z.infer<typeof insertProactiveMessageSendSchema>;
export type ProactiveMessageSend = typeof proactiveMessageSendsTable.$inferSelect;
