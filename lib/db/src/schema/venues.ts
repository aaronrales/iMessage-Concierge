import { pgTable, serial, integer, text, timestamp, jsonb, pgEnum, numeric, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { threadsTable } from "./threads";
import { plansTable } from "./plans";
import { usersTable } from "./users";

/**
 * Curated venue corpus (NYC launch). A `venues` row is the anchor; signals
 * (per-source, e.g. Google rating, Reddit mentions) and attributes
 * (per-dimension, e.g. vibe, noise level) hang off it in their own tables so
 * each can carry its own confidence/source/schema-version metadata and be
 * re-extracted independently on revalidation.
 *
 * Tier lifecycle: everything the extraction pipeline writes lands at
 * `pending_review` -- never directly into a tier the agent recommends from.
 * A human reviewer (or the revalidation job, for suppression only) is what
 * moves a venue into `tier1`/`tier2`/`untiered`.
 */
export const venueTierEnum = pgEnum("venue_tier", ["pending_review", "tier1", "tier2", "untiered"]);

export const venuesTable = pgTable(
  "venues",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    // Free-text on purpose (not a pg enum): the BRD explicitly calls for the
    // schema to not block adding event/activity venue types later without a
    // migration. "restaurant" | "bar" today.
    venueType: text("venue_type").notNull().default("restaurant"),
    neighborhood: text("neighborhood").notNull(),
    borough: text("borough"),
    city: text("city").notNull().default("New York"),
    address: text("address"),
    // Free-text category/cuisine as sourced from the candidate list (e.g. Yelp categories string).
    category: text("category"),
    tier: venueTierEnum("tier").notNull().default("pending_review"),
    // Weighted composite of signals; null until the scoring pass has run at least once.
    compositeScore: numeric("composite_score", { precision: 6, scale: 3 }),
    // Groundwork for first-party outcome data to progressively take over
    // ranking -- 0 today (hand-tuned weights only), a real value once there's
    // enough recommendation_events/venue_feedback volume to fit against.
    firstPartyWeight: numeric("first_party_weight", { precision: 4, scale: 3 }).notNull().default("0"),
    // Set by the revalidation job's closure check; suppressed venues are
    // excluded from lookups regardless of tier until a human clears this.
    closureSuspected: boolean("closure_suspected").notNull().default(false),
    // Best-effort provenance for where this candidate came from (e.g. a Yelp business id/url), for traceability during review.
    candidateSourceRef: text("candidate_source_ref"),
    // Google Places ID (e.g. "ChIJ..."). Populated by ops reviewers via the
    // admin dashboard; used at recommendation time to fetch photo carousels.
    googlePlaceId: text("google_place_id"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique("venues_name_neighborhood_unique").on(table.name, table.neighborhood)],
);

export const insertVenueSchema = createInsertSchema(venuesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVenue = z.infer<typeof insertVenueSchema>;
export type Venue = typeof venuesTable.$inferSelect;

/**
 * One row per (venue, source) -- the cross-signal validation graph. `source`
 * is free-text (e.g. "google_rating", "infatuation", "eater38", "michelin",
 * "reddit_mentions", "resy_bookable", "opentable_bookable") rather than a pg
 * enum so new signal sources can be added without a migration.
 */
export const venueSignalsTable = pgTable(
  "venue_signals",
  {
    id: serial("id").primaryKey(),
    venueId: integer("venue_id")
      .notNull()
      .references(() => venuesTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    // Shape depends on `source`, e.g. { rating: 4.5 }, { present: true, guideName: "Eater 38", sentiment: "positive" }.
    value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0"),
    sourceUrls: jsonb("source_urls").$type<string[]>().notNull().default([]),
    schemaVersion: integer("schema_version").notNull().default(1),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("venue_signals_venue_source_unique").on(table.venueId, table.source)],
);

export const insertVenueSignalSchema = createInsertSchema(venueSignalsTable).omit({
  id: true,
  extractedAt: true,
});
export type InsertVenueSignal = z.infer<typeof insertVenueSignalSchema>;
export type VenueSignal = typeof venueSignalsTable.$inferSelect;

/**
 * One row per (venue, dimension) -- the LLM-extracted attribute layer (vibe,
 * group-friendliness, price honesty, etc). `dimension` is free-text for the
 * same forward-compatibility reason as `source` above.
 */
export const venueAttributesTable = pgTable(
  "venue_attributes",
  {
    id: serial("id").primaryKey(),
    venueId: integer("venue_id")
      .notNull()
      .references(() => venuesTable.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    // Shape depends on `dimension`, e.g. { level: "loud" }, { honest: true, note: "..." }.
    value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0"),
    sourceCount: integer("source_count").notNull().default(0),
    sourceUrls: jsonb("source_urls").$type<string[]>().notNull().default([]),
    schemaVersion: integer("schema_version").notNull().default(1),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("venue_attributes_venue_dimension_unique").on(table.venueId, table.dimension)],
);

export const insertVenueAttributeSchema = createInsertSchema(venueAttributesTable).omit({
  id: true,
  extractedAt: true,
});
export type InsertVenueAttribute = z.infer<typeof insertVenueAttributeSchema>;
export type VenueAttribute = typeof venueAttributesTable.$inferSelect;

/**
 * Per-venue-type revalidation cadence (monthly for restaurants/bars, weekly
 * for anything time-sensitive later). A config table rather than a constant
 * so ops can tune cadence per type without a deploy.
 */
export const venueTypeRevalidationConfigTable = pgTable("venue_type_revalidation_config", {
  id: serial("id").primaryKey(),
  venueType: text("venue_type").notNull().unique(),
  cadenceDays: integer("cadence_days").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertVenueTypeRevalidationConfigSchema = createInsertSchema(venueTypeRevalidationConfigTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVenueTypeRevalidationConfig = z.infer<typeof insertVenueTypeRevalidationConfigSchema>;
export type VenueTypeRevalidationConfig = typeof venueTypeRevalidationConfigTable.$inferSelect;

/**
 * Every venue recommendation shown to a group, whether or not ranking
 * consumes it yet -- the first-party outcome data the BRD wants laid down
 * now so weights can be fit against it later.
 */
export const recommendationOutcomeEnum = pgEnum("recommendation_outcome", ["shown", "picked", "ignored", "rejected"]);

export const recommendationEventsTable = pgTable("recommendation_events", {
  id: serial("id").primaryKey(),
  // Nullable: a recommendation can reference a corpus venue, or (during the
  // fallback path / before the corpus exists for a market) an ad-hoc
  // raw-search result that never got a `venues` row.
  venueId: integer("venue_id").references(() => venuesTable.id, { onDelete: "set null" }),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  planId: integer("plan_id").references(() => plansTable.id, { onDelete: "set null" }),
  outcome: recommendationOutcomeEnum("outcome").notNull(),
  // e.g. { query, tierAtRecommendation, venueName } -- useful even for the untiered/fallback case where venueId is null.
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRecommendationEventSchema = createInsertSchema(recommendationEventsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRecommendationEvent = z.infer<typeof insertRecommendationEventSchema>;
export type RecommendationEvent = typeof recommendationEventsTable.$inferSelect;

/**
 * Post-plan feedback specifically about the venue (distinct from the
 * generic `feedbackTable`, which is about the plan as a whole). Nothing
 * consumes this for ranking yet -- see `firstPartyWeight` above.
 */
export const venueFeedbackTable = pgTable("venue_feedback", {
  id: serial("id").primaryKey(),
  venueId: integer("venue_id").references(() => venuesTable.id, { onDelete: "set null" }),
  threadId: integer("thread_id")
    .notNull()
    .references(() => threadsTable.id, { onDelete: "cascade" }),
  planId: integer("plan_id").references(() => plansTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  rating: integer("rating"),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVenueFeedbackSchema = createInsertSchema(venueFeedbackTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVenueFeedback = z.infer<typeof insertVenueFeedbackSchema>;
export type VenueFeedback = typeof venueFeedbackTable.$inferSelect;
