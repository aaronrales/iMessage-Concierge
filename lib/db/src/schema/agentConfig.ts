import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Simple key-value store for admin-controlled agent configuration.
 *
 * Currently used for one key: `globalGuidance` — a free-text block that is
 * prepended to every agent system prompt across all threads. Intended for
 * cross-cutting corrections that should apply everywhere ("always confirm
 * dietary restrictions before booking") without having to edit code.
 *
 * The table is intentionally tiny and human-readable. Add new keys as needed
 * rather than bundling everything into a single JSONB column.
 */
export const agentConfigTable = pgTable("agent_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AgentConfig = typeof agentConfigTable.$inferSelect;
