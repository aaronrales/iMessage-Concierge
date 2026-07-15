/**
 * Shared vocabulary for the curated venue corpus. Kept as plain string
 * unions (not pg enums) so new signal sources / attribute dimensions / venue
 * types can be added without a schema migration -- see `lib/db/src/schema/venues.ts`.
 */

/** Cross-signal validation graph sources, all sourced via LLM web search (no scraping/partner APIs). */
export const SIGNAL_SOURCES = [
  "google_rating",
  "infatuation",
  "eater38",
  "michelin",
  "reddit_mentions",
  "resy_bookable",
  "opentable_bookable",
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** LLM-extracted attribute layer dimensions. */
export const ATTRIBUTE_DIMENSIONS = [
  "noise_level",
  "group_friendliness",
  "reservation_reality",
  "vibe",
  "price_honesty",
  "dietary_breadth",
  "outdoor_seating",
  "bar_while_waiting",
] as const;
export type AttributeDimension = (typeof ATTRIBUTE_DIMENSIONS)[number];

/** Venue types in scope for this phase. Free-text in the DB -- events/activities are a fast-follow, not a migration. */
export const VENUE_TYPES = ["restaurant", "bar"] as const;
export type VenueType = (typeof VENUE_TYPES)[number];

/** Bump whenever the extraction prompt/output shape changes meaningfully, so old rows can be identified for re-extraction. */
export const EXTRACTION_SCHEMA_VERSION = 1;

/**
 * Hand-tuned composite score weights (BRD decision: not fit against a
 * labeled set yet). Signals and attributes are weighted separately, then
 * blended; `firstPartyWeight` on the venue row (default 0) is reserved for
 * outcome data to progressively take over once there's enough volume.
 */
export const SIGNAL_WEIGHTS: Record<SignalSource, number> = {
  google_rating: 0.22,
  infatuation: 0.14,
  eater38: 0.14,
  michelin: 0.12,
  reddit_mentions: 0.08,
  resy_bookable: 0.15,
  opentable_bookable: 0.15,
};

export const ATTRIBUTE_WEIGHTS: Record<AttributeDimension, number> = {
  group_friendliness: 0.22,
  reservation_reality: 0.18,
  vibe: 0.16,
  price_honesty: 0.16,
  noise_level: 0.1,
  dietary_breadth: 0.1,
  outdoor_seating: 0.04,
  bar_while_waiting: 0.04,
};

/** Blend between the signal-graph score and the attribute-layer score inside the non-first-party portion of the composite. */
export const SIGNALS_VS_ATTRIBUTES_BLEND = 0.6; // 60% signals, 40% attributes

/** Composite score thresholds for tiering (0-100 scale). */
export const TIER1_SCORE_THRESHOLD = 70;
export const TIER2_SCORE_THRESHOLD = 45;

export const DEFAULT_REVALIDATION_CADENCE_DAYS: Record<string, number> = {
  restaurant: 30,
  bar: 30,
};
