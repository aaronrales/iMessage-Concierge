import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

/**
 * Per-project money ledger: tracks estimated costs, attendance commitments,
 * and payment confirmations. The agent NEVER holds, moves, or guarantees
 * funds — this table records facts the organizer tells it ("house was $2,400
 * split 8 ways", "Jake paid me"), and the agent nudges outstanding members.
 *
 * Kind lifecycle:
 *   estimate          — per-person expected contribution, computed from total ÷ headcount
 *   commitment        — member has confirmed they're in (used for headcount tracking)
 *   payment_recorded  — organizer has confirmed receiving payment from this person
 *
 * All amounts in cents (integer) to avoid floating-point rounding.
 */
export const projectLedgerEntriesTable = pgTable("project_ledger_entries", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  /**
   * One of: estimate | commitment | payment_recorded.
   * Free text (not pg-enum) so new kinds never require a schema migration.
   * The application enforces the allowed values in code.
   */
  kind: text("kind").notNull(),
  /** Who this entry is about (the member who owes / committed / paid). Null for project-wide entries. */
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** Amount in cents (e.g. $300.00 → 30000). Always > 0 when set. Null for commitment-only entries. */
  amountCents: integer("amount_cents"),
  /** Human-readable label, e.g. "Airbnb house deposit", "Activity fund", "Paid via Venmo". */
  note: text("note"),
  /**
   * Whether a payment-request DM has been sent to this member for this
   * estimate entry. Used by the scheduler to avoid sending duplicate requests.
   * Only relevant for `estimate` kind rows.
   */
  requestSentAt: timestamp("request_sent_at", { withTimezone: true }),
  /**
   * Last time a payment nudge was sent to this member for an outstanding
   * balance in this project. Used by the scheduler to enforce the nudge
   * cadence (≤ 1 nudge per 5 days per member per project).
   */
  lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ProjectLedgerEntry = typeof projectLedgerEntriesTable.$inferSelect;
export type InsertProjectLedgerEntry = typeof projectLedgerEntriesTable.$inferInsert;

export const LEDGER_ENTRY_KINDS = ["estimate", "commitment", "payment_recorded"] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];
