import { pgTable, serial, integer, text, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";
import { usersTable } from "./users";

/**
 * A multi-event occasion (bachelorette, milestone birthday, reunion, trip)
 * that groups several plans under one umbrella. Plans reference a project via
 * `plans.projectId`; standalone plans (projectId null) keep the classic
 * one-active-plan-per-thread behavior, while project children may coexist.
 *
 * `type` and `status` are deliberately plain text (not pg enums) so new
 * occasion types or lifecycle states never need a migration -- the LLM
 * extracts these values from conversation and the vocabulary will grow.
 * Expected values today:
 *   type:   bachelorette | milestone_birthday | reunion | trip
 *   status: forming -> planning -> active -> done (cancelled from any)
 */
export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  // Freeform honoree name as mentioned in conversation ("Sarah"). Kept even
  // when honoreeUserId resolves, since the honoree often isn't in the thread
  // (surprise parties, the bride not being in the logistics group, etc.).
  honoree: text("honoree"),
  honoreeUserId: integer("honoree_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  dateRangeStart: timestamp("date_range_start", { withTimezone: true }),
  dateRangeEnd: timestamp("date_range_end", { withTimezone: true }),
  status: text("status").notNull().default("planning"),
  /**
   * The user who is responsible for this project — they receive all proposal
   * drafts via private DM before anything is released to the group, and can
   * issue tiebreak overrides from the organizer sidebar. Defaults to whoever
   * triggered project creation (the first person to discuss the occasion).
   */
  organizerUserId: integer("organizer_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /**
   * Headcount commitment round fields. Set by the organizer via sidebar DM.
   * `commitmentPollId` references the open "I'm in / I'm out" poll in the
   * group thread. `headcountLockedAt` + `headcountLockedCount` are stamped
   * when the deadline passes and the agent announces the final headcount.
   */
  commitmentDeadline: timestamp("commitment_deadline", { withTimezone: true }),
  headcountTarget: integer("headcount_target"),
  commitmentPollId: integer("commitment_poll_id"),
  headcountLockedAt: timestamp("headcount_locked_at", { withTimezone: true }),
  headcountLockedCount: integer("headcount_locked_count"),
  /**
   * Destination shortlist and decision fields for trip projects.
   * `destination` is set once the group decides (poll closes or organizer
   * overrides). `destinationPollId` tracks the currently-open destination
   * choice poll so the poll-close path knows to stamp the winner here.
   */
  destination: text("destination"),
  destinationPollId: integer("destination_poll_id"),
  /**
   * Tracks the active private-input request used to collect per-member
   * arrival details (flight info, driving ETA). Set when the organizer
   * triggers the arrival-collection round; cleared/replaced if re-opened.
   * References private_input_requests.id but kept as a bare integer (no FK)
   * to mirror the commitmentPollId / destinationPollId pattern.
   */
  arrivalCollectionRequestId: integer("arrival_collection_request_id"),
  /**
   * Per-person lodging cost in cents, set when the organizer reports a
   * lodging estimate ("Found an Airbnb for $2,400, 8 people"). Used by the
   * dashboard to show the per-person cost without recomputing from the ledger.
   */
  lodgingPerPersonCents: integer("lodging_per_person_cents"),
  /**
   * Lodging property details set when the organizer reports a chosen property
   * ("Found an Airbnb for $2,400, 4 nights, 8 people" / "we're staying at the
   * Pulitzer Amsterdam"). The property name is the single most-needed piece of
   * information on travel day, so it must survive beyond the chat transcript.
   */
  lodgingPropertyName: text("lodging_property_name"),
  lodgingCheckIn: timestamp("lodging_check_in", { withTimezone: true }),
  lodgingCheckOut: timestamp("lodging_check_out", { withTimezone: true }),
  closeoutPromptSentAt: timestamp("closeout_prompt_sent_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  // DB-enforced "at most one active project per thread": concurrent webhook
  // turns that both try to create a project race on this index, and the
  // loser falls back to the merge path (see agent/projects.ts). The
  // predicate hardcodes the active statuses -- status is a code-controlled
  // lifecycle (unlike `type`, which is open vocabulary), so extending it is
  // a deliberate migration.
  uniqueIndex("projects_one_active_per_thread")
    .on(table.threadId)
    .where(sql`status IN ('forming', 'planning', 'active')`),
]);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;

/** Statuses that count as "in flight" for active-project resolution. */
export const PROJECT_ACTIVE_STATUSES = ["forming", "planning", "active"] as const;
