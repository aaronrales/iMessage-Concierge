import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
export const llmCostLogTable = pgTable("llm_cost_log", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id"),
  module: text("module").notNull(),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type LlmCostLog = typeof llmCostLogTable.$inferSelect;
