import { eq } from "drizzle-orm";
import { db, venueAttributesTable, venueSignalsTable, venuesTable, type Venue } from "@workspace/db";
import {
  ATTRIBUTE_WEIGHTS,
  SIGNAL_WEIGHTS,
  SIGNALS_VS_ATTRIBUTES_BLEND,
  TIER1_SCORE_THRESHOLD,
  TIER2_SCORE_THRESHOLD,
  type AttributeDimension,
  type SignalSource,
} from "./constants";

/**
 * Composite scoring & tiering (BRD decision: hand-tuned weights for now, no
 * fitting against a labeled set). Every signal/attribute confidence acts as
 * a per-row weight multiplier, so a low-confidence finding barely moves the
 * score instead of swinging it as hard as a well-evidenced one.
 *
 * `firstPartyWeight` on the venue row is reserved for blending in outcome
 * data later; it defaults to 0 so today's score is 100% signals+attributes.
 */

function weightedAverage(weights: Record<string, number>, rows: { key: string; score: number; confidence: number }[]): number | null {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const row of rows) {
    const baseWeight = weights[row.key] ?? 0;
    if (baseWeight <= 0) continue;
    const effectiveWeight = baseWeight * Math.max(row.confidence, 0.05); // never fully zero out a signal we do have, but confidence still matters a lot
    weightedSum += effectiveWeight * row.score;
    weightTotal += effectiveWeight;
  }
  if (weightTotal === 0) return null;
  return weightedSum / weightTotal;
}

/** Very rough free-text -> 0-100 sentiment scorer for signal/attribute `value.note` strings, since extraction returns prose, not pre-scored numbers. */
function scoreFreeText(note: string): number {
  const text = note.toLowerCase();
  if (/no evidence found|not found|unclear|ambiguous/.test(text)) return 40;

  const ratingMatch = text.match(/(\d(?:\.\d)?)\s*(?:\/\s*5|stars?)/);
  if (ratingMatch) {
    const rating = Number.parseFloat(ratingMatch[1] as string);
    if (Number.isFinite(rating)) return Math.max(0, Math.min(100, (rating / 5) * 100));
  }

  // "loud", "quiet", "busy", "lively", "intimate" are atmosphere descriptors whose
  // valence is context-dependent (a loud room is great for a rowdy birthday, bad for a
  // business dinner). Scoring them as universal quality signals produced systematic
  // misranking -- they are deliberately treated as neutral here. Only genuine quality
  // problems (rudeness, overcrowding, pricing complaints) count as negative.
  const negativeHits = (text.match(/\b(bad|poor|closed|negative|rude|overpriced|avoid|cramped|hard to get|notoriously hard|no evidence)\b/g) ?? []).length;
  const positiveHits = (text.match(/\b(great|good|excellent|positive|friendly|honest|easy|spacious|walk-?in|patio|outdoor|reservation|bookable|present|listed|starred|recommended)\b/g) ?? [])
    .length;

  const net = positiveHits - negativeHits;
  return Math.max(0, Math.min(100, 55 + net * 8));
}

export interface CompositeScoreResult {
  compositeScore: number | null;
  suggestedTier: "tier1" | "tier2" | "untiered";
}

export function computeCompositeScore(
  signals: { source: string; value: Record<string, unknown>; confidence: number }[],
  attributes: { dimension: string; value: Record<string, unknown>; confidence: number }[],
  firstPartyWeight = 0,
  firstPartyScore = 0,
): CompositeScoreResult {
  const signalScore = weightedAverage(
    SIGNAL_WEIGHTS,
    signals.map((s) => ({
      key: s.source,
      score: scoreFreeText(typeof s.value?.["note"] === "string" ? (s.value["note"] as string) : ""),
      confidence: s.confidence,
    })),
  );
  const attributeScore = weightedAverage(
    ATTRIBUTE_WEIGHTS,
    attributes.map((a) => ({
      key: a.dimension,
      score: scoreFreeText(typeof a.value?.["note"] === "string" ? (a.value["note"] as string) : ""),
      confidence: a.confidence,
    })),
  );

  let baseScore: number | null;
  if (signalScore === null && attributeScore === null) {
    baseScore = null;
  } else if (signalScore === null) {
    baseScore = attributeScore;
  } else if (attributeScore === null) {
    baseScore = signalScore;
  } else {
    baseScore = signalScore * SIGNALS_VS_ATTRIBUTES_BLEND + attributeScore * (1 - SIGNALS_VS_ATTRIBUTES_BLEND);
  }

  if (baseScore === null) {
    return { compositeScore: null, suggestedTier: "untiered" };
  }

  const clampedFirstPartyWeight = Math.max(0, Math.min(1, firstPartyWeight));
  const compositeScore = baseScore * (1 - clampedFirstPartyWeight) + firstPartyScore * clampedFirstPartyWeight;

  const suggestedTier: CompositeScoreResult["suggestedTier"] =
    compositeScore >= TIER1_SCORE_THRESHOLD ? "tier1" : compositeScore >= TIER2_SCORE_THRESHOLD ? "tier2" : "untiered";

  return { compositeScore: Math.round(compositeScore * 1000) / 1000, suggestedTier };
}

/**
 * Recomputes and persists a venue's composite score from its current
 * signals/attributes rows. Does NOT change the venue's `tier` -- that stays
 * a human (or closure-suppression) decision; this just refreshes the score
 * so reviewers see an up-to-date suggestion.
 */
export async function recomputeVenueScore(venueId: number): Promise<CompositeScoreResult> {
  const [venue] = await db.select().from(venuesTable).where(eq(venuesTable.id, venueId));
  if (!venue) throw new Error(`Venue ${venueId} not found`);

  const signalRows = await db.select().from(venueSignalsTable).where(eq(venueSignalsTable.venueId, venueId));
  const attributeRows = await db.select().from(venueAttributesTable).where(eq(venueAttributesTable.venueId, venueId));

  const result = computeCompositeScore(
    signalRows.map((r) => ({ source: r.source, value: r.value, confidence: Number(r.confidence) })),
    attributeRows.map((r) => ({ dimension: r.dimension, value: r.value, confidence: Number(r.confidence) })),
    Number(venue.firstPartyWeight),
    0, // no first-party outcome scoring model yet -- firstPartyWeight defaults to 0 so this is inert today
  );

  await db
    .update(venuesTable)
    .set({ compositeScore: result.compositeScore === null ? null : String(result.compositeScore), lastValidatedAt: new Date() })
    .where(eq(venuesTable.id, venueId));

  return result;
}

export type { SignalSource, AttributeDimension };
export type { Venue };
