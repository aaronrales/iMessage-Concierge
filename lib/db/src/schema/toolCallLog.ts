import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per tool call executed by the agent. Outcome tags:
 *   success       — tool returned non-empty results
 *   empty         — tool returned zero results (valid call, no data found)
 *   api_error     — the external API returned a non-OK response
 *   not_configured — required env key was absent; call was not attempted
 */
export const toolCallLogTable = pgTable("tool_call_log", {
  id: serial("id").primaryKey(),
  toolName: text("tool_name").notNull(),
  outcome: text("outcome").notNull(), // 'success' | 'empty' | 'api_error' | 'not_configured'
  durationMs: integer("duration_ms").notNull(),
  threadId: integer("thread_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type ToolCallLog = typeof toolCallLogTable.$inferSelect;
export type NewToolCallLog = typeof toolCallLogTable.$inferInsert;
