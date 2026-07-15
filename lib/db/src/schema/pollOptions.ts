import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pollsTable } from "./polls";

export const pollOptionsTable = pgTable("poll_options", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id")
    .notNull()
    .references(() => pollsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  position: integer("position").notNull().default(0),
  // Only set for "date" kind polls -- the structured date/time this option
  // represents, so intersection logic can reason about it without re-parsing
  // the label.
  optionDate: timestamp("option_date", { withTimezone: true }),
});

export const insertPollOptionSchema = createInsertSchema(pollOptionsTable).omit({ id: true });
export type InsertPollOption = z.infer<typeof insertPollOptionSchema>;
export type PollOption = typeof pollOptionsTable.$inferSelect;
