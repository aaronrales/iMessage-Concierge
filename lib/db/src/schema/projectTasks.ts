import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

/**
 * Instantiated playbook steps for a project's occasion timeline.
 *
 * When a project is created with a known occasion type, its playbook template
 * is hydrated into rows here. `dueAt` is computed relative to the project's
 * event date (dateRangeStart) using each step's lead-time offset.
 *
 * Status lifecycle: pending → in_progress → done | skipped.
 * Steps can also be auto-completed by the daily timeline scanner when the
 * underlying state satisfies the step's completionTrigger (e.g. a date poll
 * closes → the "lock date" step is marked done automatically).
 */
export const projectTasksTable = pgTable("project_tasks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  /**
   * One of: pending | in_progress | done | skipped.
   * Free text (not pg-enum) so schema migrations are never required to add
   * new statuses. The application enforces the allowed values in code.
   */
  status: text("status").notNull().default("pending"),
  /** When this step is due, computed as (project.dateRangeStart - leadTimeDays). Null until date is known. */
  dueAt: timestamp("due_at", { withTimezone: true }),
  /** Optional assignment to a specific group member (future feature). Nullable for now. */
  ownerUserId: integer("owner_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** The playbook step key this row was instantiated from (e.g. "lock_date", "collect_budgets"). */
  sourceStep: text("source_step"),
  /** Action hint from the playbook template — drives scheduler nudge message content. */
  actionHint: text("action_hint"),
  /**
   * What automatic state transition can mark this step done without human input.
   * One of: date_poll_closed | venue_poll_closed | booking_confirmed | plan_confirmed | none.
   * The daily scanner checks these and auto-completes eligible steps.
   */
  completionTrigger: text("completion_trigger"),
  /** Timestamp when the organizer sidebar last received a proactive nudge for this step. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ProjectTask = typeof projectTasksTable.$inferSelect;
export type InsertProjectTask = typeof projectTasksTable.$inferInsert;

export const PROJECT_TASK_STATUSES = ["pending", "in_progress", "done", "skipped"] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];
