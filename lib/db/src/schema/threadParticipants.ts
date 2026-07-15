import { pgTable, serial, integer, text, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { threadsTable } from "./threads";

export const threadParticipantsTable = pgTable(
  "thread_participants",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => threadsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    // When true, the concierge stays silent in this thread for this person's
    // messages except for explicit unmute commands -- set via the "mute me"
    // deterministic command, never by the LLM.
    isMuted: boolean("is_muted").notNull().default(false),
    // Set once the one-time onboarding disclosure ("I'm this group's AI
    // concierge...") has been sent for this participant, so it never repeats.
    disclosureSentAt: timestamp("disclosure_sent_at", { withTimezone: true }),
    // Set once a stalled-onboarding follow-up nudge has been sent for this
    // group membership, so it fires at most once ever per group -- never a
    // repeated pester. See `handleOnboardingNudgeScan` in scheduler.ts.
    onboardingNudgeSentAt: timestamp("onboarding_nudge_sent_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.threadId, table.userId),
    // The (threadId, userId) unique index above already serves threadId-only
    // lookups (it's the leading column); userId-only lookups (e.g. onboarding
    // scans across all of a user's groups) need their own index.
    index("thread_participants_user_id_idx").on(table.userId),
  ],
);

export const insertThreadParticipantSchema = createInsertSchema(threadParticipantsTable).omit({
  id: true,
  joinedAt: true,
});
export type InsertThreadParticipant = z.infer<typeof insertThreadParticipantSchema>;
export type ThreadParticipant = typeof threadParticipantsTable.$inferSelect;
