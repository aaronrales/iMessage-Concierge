import { db, venueAttributesTable, venueSignalsTable } from "@workspace/db";
import { EXTRACTION_SCHEMA_VERSION } from "./constants";
import type { VenueExtractionResult } from "./extraction";

/**
 * Shared write path for an extraction result -- used by both the population
 * job (first write, always at `pending_review`) and the revalidation job
 * (re-write against an already-tiered venue). Upserts one row per
 * source/dimension so re-running extraction refreshes rather than
 * duplicates.
 */
export async function upsertVenueSignalsAndAttributes(venueId: number, extraction: VenueExtractionResult): Promise<void> {
  for (const signal of extraction.signals) {
    await db
      .insert(venueSignalsTable)
      .values({
        venueId,
        source: signal.source,
        value: signal.value,
        confidence: String(signal.confidence),
        sourceUrls: signal.sourceUrls,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
      })
      .onConflictDoUpdate({
        target: [venueSignalsTable.venueId, venueSignalsTable.source],
        set: {
          value: signal.value,
          confidence: String(signal.confidence),
          sourceUrls: signal.sourceUrls,
          schemaVersion: EXTRACTION_SCHEMA_VERSION,
          extractedAt: new Date(),
        },
      });
  }

  for (const attribute of extraction.attributes) {
    await db
      .insert(venueAttributesTable)
      .values({
        venueId,
        dimension: attribute.dimension,
        value: attribute.value,
        confidence: String(attribute.confidence),
        sourceCount: attribute.sourceCount,
        sourceUrls: attribute.sourceUrls,
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
      })
      .onConflictDoUpdate({
        target: [venueAttributesTable.venueId, venueAttributesTable.dimension],
        set: {
          value: attribute.value,
          confidence: String(attribute.confidence),
          sourceCount: attribute.sourceCount,
          sourceUrls: attribute.sourceUrls,
          schemaVersion: EXTRACTION_SCHEMA_VERSION,
          extractedAt: new Date(),
        },
      });
  }
}
