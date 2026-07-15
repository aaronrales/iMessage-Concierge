import { pgTable, text, serial, integer, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Public/private visibility for learnable profile fields. Private fields may
// still shape recommendations (they're always available to the agent's
// reasoning), but enforcement code must strip them out of any text sent into
// a group thread -- see `scrubPrivateProfileLeaks` in the agent engine.
export const profileFieldVisibilityEnum = pgEnum("profile_field_visibility", ["public", "private"]);

export const profilesTable = pgTable("profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  budget: text("budget"),
  budgetVisibility: profileFieldVisibilityEnum("budget_visibility").notNull().default("private"),
  dietaryNeeds: text("dietary_needs"),
  dietaryNeedsVisibility: profileFieldVisibilityEnum("dietary_needs_visibility").notNull().default("private"),
  preferences: jsonb("preferences").$type<string[]>().notNull().default([]),
  preferencesVisibility: profileFieldVisibilityEnum("preferences_visibility").notNull().default("public"),
  pastChoices: jsonb("past_choices").$type<string[]>().notNull().default([]),
  notes: text("notes"),
  notesVisibility: profileFieldVisibilityEnum("notes_visibility").notNull().default("private"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertProfileSchema = createInsertSchema(profilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Profile = typeof profilesTable.$inferSelect;
