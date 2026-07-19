import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

/**
 * Lifecycle milestones each user hits at most once. `event` is plain text
 * (not a pg enum) so new funnel stages never need a migration. Expected
 * values today are the members of `ACTIVATION_EVENTS`.
 */
export const ACTIVATION_EVENTS = ["added_to_group", "first_reply", "onboarding_complete"] as const;
export type ActivationEvent = (typeof ACTIVATION_EVENTS)[number];

/**
 * One row per (user, milestone). The funnel semantics are "has this user
 * ever reached this stage", so the unique index makes writes idempotent:
 * recorders can insert unconditionally with `onConflictDoNothing` and
 * concurrent webhook retries / repeat transitions (e.g. the LLM re-flagging
 * onboarding complete) can never produce duplicate rows that would inflate
 * conversion counts.
 */
export const activationEventsTable = pgTable(
  "activation_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("activation_events_user_event_unique").on(table.userId, table.event)],
);

export const insertActivationEventSchema = createInsertSchema(activationEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertActivationEvent = z.infer<typeof insertActivationEventSchema>;
export type ActivationEventRow = typeof activationEventsTable.$inferSelect;
