import { pgTable, serial, integer, text } from "drizzle-orm/pg-core";
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
});

export const insertPollOptionSchema = createInsertSchema(pollOptionsTable).omit({ id: true });
export type InsertPollOption = z.infer<typeof insertPollOptionSchema>;
export type PollOption = typeof pollOptionsTable.$inferSelect;
