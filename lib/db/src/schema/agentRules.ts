import { pgTable, serial, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Admin-controlled agent behavioral rules.
 *
 * Each row is a named, categorized block of prompt text that the engine
 * injects into the system prompt at runtime when `enabled = true`. Rules are
 * ordered by `sort_order` (ascending) and injected as a single system message
 * between SYSTEM_PROMPT and the persona block.
 *
 * Built-in rules (is_built_in = true) are seeded from the codebase on first
 * start and can be edited or disabled, but not deleted.
 *
 * User-added rules (is_built_in = false) support full CRUD.
 *
 * NOTE: To update a built-in rule's content in production, use the dashboard —
 * seeding only runs when the table is empty, so code changes to seed content
 * will NOT propagate to existing installs.
 */
export const agentRulesTable = pgTable("agent_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  category: text("category").notNull(), // "behavior" | "project" | "tool"
  content: text("content").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  isBuiltIn: boolean("is_built_in").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AgentRule = typeof agentRulesTable.$inferSelect;
export type NewAgentRule = typeof agentRulesTable.$inferInsert;
