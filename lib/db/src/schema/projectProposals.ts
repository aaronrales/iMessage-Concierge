import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";
import { threadsTable } from "./threads";

/**
 * A draft proposal that the concierge wants to release to a group thread, but
 * which must first be approved by the project organizer via their private DM
 * sidebar. Covers polls, venue shortlists, and plain "message" broadcasts.
 *
 * Lifecycle: pending → approved → released (or pending → rejected).
 *
 * `proposalContent` is free-form JSONB. Expected shapes per type:
 *   poll:           { question, options, kind, optionDates, reply }
 *   venue_shortlist:{ reply, venueCarousels }
 *   message:        { reply }
 *
 * Only one pending proposal per project is expected at a time in practice,
 * but the table allows multiple (e.g. if the organizer is slow to respond)
 * so nothing is lost. The oldest pending proposal is always surfaced first.
 */
export const projectProposalsTable = pgTable("project_proposals", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  groupThreadId: integer("group_thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  proposalType: text("proposal_type").notNull(), // poll | venue_shortlist | message
  proposalContent: jsonb("proposal_content").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | released
  organizerReply: text("organizer_reply"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
});

export const insertProjectProposalSchema = createInsertSchema(projectProposalsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertProjectProposal = z.infer<typeof insertProjectProposalSchema>;
export type ProjectProposal = typeof projectProposalsTable.$inferSelect;
