import { pgTable, serial, integer, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { threadsTable } from "./threads";

export const occasionKindEnum = pgEnum("occasion_kind", ["birthday", "anniversary", "visit", "other"]);

/**
 * A passing mention of a future occasion ("when Jake visits in March",
 * "it's Sarah's birthday next month") captured from conversation, so the
 * concierge can proactively resurface it ~2 weeks out and offer to plan
 * something -- gated by the Phase 0 messaging budget (`occasion_reminder`
 * category), never fired more than once per occasion.
 */
export const occasionsTable = pgTable("occasions", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  // The person the occasion is about. Nullable -- the person mentioned (e.g.
  // "Jake") may not be a known user of the concierge at all.
  aboutUserId: integer("about_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  mentionedByUserId: integer("mentioned_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  kind: occasionKindEnum("kind").notNull().default("other"),
  label: text("label").notNull(),
  occasionDate: timestamp("occasion_date", { withTimezone: true }).notNull(),
  // Set once the proactive "hey, X is coming up" prompt has actually been
  // sent, so the scan never double-fires for the same occasion.
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  // Linked project created after the organizer accepts the occasion reminder.
  projectId: integer("project_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOccasionSchema = createInsertSchema(occasionsTable).omit({
  id: true,
  createdAt: true,
  remindedAt: true,
});
export type InsertOccasion = z.infer<typeof insertOccasionSchema>;
export type Occasion = typeof occasionsTable.$inferSelect;
