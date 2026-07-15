import { pgTable, text, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const threadsTable = pgTable("threads", {
  id: serial("id").primaryKey(),
  // Sendblue's group identifier. Null for 1:1 threads.
  sendblueGroupId: text("sendblue_group_id").unique(),
  // For 1:1 threads, the other party's phone number. Used to look up an
  // existing thread by phone number since there is no group id.
  primaryPhoneNumber: text("primary_phone_number").unique(),
  isGroup: boolean("is_group").notNull().default(false),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertThreadSchema = createInsertSchema(threadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertThread = z.infer<typeof insertThreadSchema>;
export type Thread = typeof threadsTable.$inferSelect;
