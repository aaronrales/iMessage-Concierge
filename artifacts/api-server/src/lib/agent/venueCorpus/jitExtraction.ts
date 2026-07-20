/**
 * Just-in-time venue knowledge for non-NYC destinations.
 *
 * When a trip project locks a non-NYC destination, this module runs a single
 * web-search LLM call to pull a structured list of top venues/activities for
 * that city. Results are cached in `destination_venue_extractions` with a
 * 30-day TTL. This is breadth-first (not expert-curated like the NYC corpus)
 * and marked provisional in the prompt context accordingly.
 *
 * The extraction never runs for NYC/New York — the curated corpus covers that.
 */

import type OpenAI from "openai";
import { openai, CHAT_MODEL } from "../../openaiClient";
import { logger } from "../../logger";
import { logLlmCost } from "../costLogger";
import { db, destinationVenueExtractionsTable, pendingDeliverablesTable } from "@workspace/db";
import { and, desc, eq, gt } from "drizzle-orm";
import { sendToThread } from "../delivery";
import { EXTRACTION_SCHEMA_VERSION } from "./constants";

export { EXTRACTION_SCHEMA_VERSION };

// ── Types ────────────────────────────────────────────────────────────────────

export interface JITVenue {
  name: string;
  venueType: string;       // "restaurant" | "bar" | "activity" | etc.
  vibe: string;            // one-line honest vibe descriptor
  groupFriendliness: string; // "great for groups" / "better for smaller parties" / etc.
  roughPrice: string;      // "$" | "$$" | "$$$" etc. or free text
}

export interface JITExtractionResult {
  venues: JITVenue[];
  destinationNote: string; // LLM's framing sentence about the destination
}

// ── NYC guard ────────────────────────────────────────────────────────────────

const NYC_PATTERNS = [/\bnew\s*york\b/i, /\bnyc\b/i, /\bmanhattan\b/i, /\bbrooklyn\b/i, /\bqueens\b/i, /\bbronx\b/i];

/**
 * Returns true when the destination is NYC or a NYC borough — the curated
 * corpus already covers this market so JIT extraction is not needed.
 */
export function isNYCDestination(destination: string): boolean {
  return NYC_PATTERNS.some((re) => re.test(destination));
}

// ── JSON schema for the LLM response ─────────────────────────────────────────

const JIT_EXTRACTION_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    destination_note: {
      type: "string",
      description:
        "A single sentence framing why this destination works for groups (e.g. 'Nashville has a strong bar scene and plenty of group-friendly restaurants in the downtown core.').",
    },
    venues: {
      type: "array",
      minItems: 10,
      maxItems: 25,
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact venue name as it appears publicly." },
          venue_type: {
            type: "string",
            description: "Category: restaurant | bar | cocktail_bar | rooftop | activity | live_music | brunch | other",
          },
          vibe: {
            type: "string",
            description: "Honest one-line vibe (e.g. 'rowdy honky-tonk, great for a big group night out').",
          },
          group_friendliness: {
            type: "string",
            description: "How well it handles groups of 4–10 (e.g. 'large communal tables, easy walk-in for groups', 'better for 2–4').",
          },
          rough_price: {
            type: "string",
            description: "Price tier using $/$$/$$$/$$$$, or a brief descriptor like '~$30/person'.",
          },
        },
        required: ["name", "venue_type", "vibe", "group_friendliness", "rough_price"],
        additionalProperties: false,
      },
    },
  },
  required: ["destination_note", "venues"],
  additionalProperties: false,
};

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildJITPrompt(destination: string): string {
  return `You are building a venue guide for a small friend group visiting ${destination}. Use web search to find real, well-reviewed venues — do not invent names.

Find the top 15–25 restaurants, bars, cocktail bars, brunch spots, and group-friendly activities in ${destination}. Focus on places that are:
- Currently open and operating
- Well-suited for groups of 4–10 people
- Across a range of vibes (lively/fun, upscale, casual, outdoor, live music, etc.)
- Across a range of price points

For each venue, provide:
- Its exact public name
- The type (restaurant, bar, activity, etc.)
- An honest one-line vibe descriptor
- How well it handles groups
- A rough price indicator

Aim for variety — different neighborhoods, venue types, and price points. Prioritize places that appear frequently in local guides (Eater, Yelp, Google, local blogs) with strong reputations, not just the most tourist-obvious spots.`;
}

// ── Core extraction ───────────────────────────────────────────────────────────

/**
 * Runs a web-search LLM extraction for a destination and returns the
 * structured venue list, or null on failure. Does not write to the DB —
 * that is the caller's responsibility.
 */
export async function extractJITVenuesForDestination(
  destination: string,
): Promise<JITExtractionResult | null> {
  try {
    const response = await openai.responses.create({
      model: CHAT_MODEL,
      tools: [{ type: "web_search" }] as unknown as OpenAI.Responses.Tool[],
      input: buildJITPrompt(destination),
      text: {
        format: {
          type: "json_schema",
          name: "jit_venue_extraction",
          schema: JIT_EXTRACTION_JSON_SCHEMA,
          strict: true,
        },
      },
    });

    logLlmCost("jit_extraction", CHAT_MODEL, response.usage ? { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens } : null);
    const raw = response.output_text;
    if (!raw) {
      logger.warn({ destination }, "JIT extraction returned no output text");
      return null;
    }

    const parsed = JSON.parse(raw) as {
      destination_note?: unknown;
      venues?: {
        name?: unknown;
        venue_type?: unknown;
        vibe?: unknown;
        group_friendliness?: unknown;
        rough_price?: unknown;
      }[];
    };

    const venues: JITVenue[] = (parsed.venues ?? [])
      .filter(
        (v): v is { name: string; venue_type: string; vibe: string; group_friendliness: string; rough_price: string } =>
          typeof v.name === "string" &&
          typeof v.venue_type === "string" &&
          typeof v.vibe === "string" &&
          typeof v.group_friendliness === "string" &&
          typeof v.rough_price === "string",
      )
      .map((v) => ({
        name: v.name,
        venueType: v.venue_type,
        vibe: v.vibe,
        groupFriendliness: v.group_friendliness,
        roughPrice: v.rough_price,
      }));

    return {
      venues,
      destinationNote: typeof parsed.destination_note === "string" ? parsed.destination_note : "",
    };
  } catch (error) {
    logger.error({ error, destination }, "JIT venue extraction failed");
    return null;
  }
}

// ── Cache read ────────────────────────────────────────────────────────────────

const JIT_TTL_DAYS = 30;

/**
 * Returns the most recent non-expired `done` extraction for the destination,
 * or null if none exists yet (triggering the caller to enqueue one).
 * Matching is case-insensitive.
 */
export async function getJITVenuesForDestination(
  destination: string,
): Promise<{ venues: JITVenue[]; extractedAt: Date } | null> {
  const now = new Date();
  const rows = await db
    .select()
    .from(destinationVenueExtractionsTable)
    .where(
      and(
        eq(destinationVenueExtractionsTable.destination, destination.toLowerCase()),
        eq(destinationVenueExtractionsTable.status, "done"),
        gt(destinationVenueExtractionsTable.expiresAt, now),
      ),
    )
    .orderBy(desc(destinationVenueExtractionsTable.extractedAt))
    .limit(1);

  const row = rows[0];
  if (!row || !row.venueData || !row.extractedAt) return null;
  return { venues: row.venueData as JITVenue[], extractedAt: row.extractedAt };
}

// ── Cache write ───────────────────────────────────────────────────────────────

/**
 * Runs the extraction for a destination and persists the result.
 * Called by the pg-boss worker after a job is dequeued.
 */
export async function runAndPersistJITExtraction(destination: string): Promise<void> {
  const normalised = destination.toLowerCase();

  // Mark as pending (upsert — if a previous failed row exists, reset it)
  const [row] = await db
    .insert(destinationVenueExtractionsTable)
    .values({ destination: normalised, status: "pending" })
    .onConflictDoNothing()
    .returning();

  // If nothing was inserted (row already exists), just update the status
  if (!row) {
    await db
      .update(destinationVenueExtractionsTable)
      .set({ status: "pending", errorNote: null, extractedAt: null, expiresAt: null, venueData: [], venueCount: null })
      .where(eq(destinationVenueExtractionsTable.destination, normalised));
  }

  const result = await extractJITVenuesForDestination(destination);

  if (!result || result.venues.length < 3) {
    await db
      .update(destinationVenueExtractionsTable)
      .set({
        status: "failed",
        errorNote: result ? "Too few venues returned" : "Extraction call failed",
      })
      .where(eq(destinationVenueExtractionsTable.destination, normalised));
    logger.warn({ destination }, "JIT extraction failed or returned thin results");

    // Notify any waiting threads about the failure so no promise goes silent.
    await deliverPendingPromises(normalised, null);
    return;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + JIT_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db
    .update(destinationVenueExtractionsTable)
    .set({
      status: "done",
      venueData: result.venues,
      venueCount: result.venues.length,
      extractedAt: now,
      expiresAt,
      errorNote: null,
    })
    .where(eq(destinationVenueExtractionsTable.destination, normalised));

  logger.info({ destination, venueCount: result.venues.length }, "JIT venue extraction completed");

  // Deliver results to any threads that were waiting for this extraction.
  await deliverPendingPromises(normalised, result.venues);
}

/**
 * Finds pending_deliverables rows for this destination and either delivers
 * the venue results or sends an honest failure message. Called both on
 * success and on extraction failure so no promise ever goes permanently silent.
 */
async function deliverPendingPromises(destinationKey: string, venues: JITVenue[] | null): Promise<void> {
  const pending = await db
    .select()
    .from(pendingDeliverablesTable)
    .where(
      and(
        eq(pendingDeliverablesTable.destinationKey, destinationKey),
        eq(pendingDeliverablesTable.kind, "venue_options"),
        eq(pendingDeliverablesTable.status, "pending"),
      ),
    );

  if (pending.length === 0) return;

  const now = new Date();

  for (const row of pending) {
    try {
      if (venues && venues.length > 0) {
        const lines = venues
          .slice(0, 5)
          .map((v) => `• ${v.name} [${v.venueType}] — ${v.vibe} (${v.roughPrice})`);
        const msg =
          `Here are some places and activities to check out in ${destinationKey}:\n` +
          lines.join("\n") +
          `\n\nThese come from a web search rather than our usual hand-vetted list — good starting points to explore.`;
        await sendToThread(row.threadId, msg);
        await db
          .update(pendingDeliverablesTable)
          .set({ status: "delivered", deliveredAt: now, deliveryContent: venues })
          .where(eq(pendingDeliverablesTable.id, row.id));
      } else {
        await sendToThread(
          row.threadId,
          `I wasn't able to find great venue options for ${destinationKey} this time. Ask me directly and I'll look things up for you.`,
        );
        await db
          .update(pendingDeliverablesTable)
          .set({ status: "failed", deliveredAt: now })
          .where(eq(pendingDeliverablesTable.id, row.id));
      }
    } catch (err) {
      logger.warn({ err, deliverableId: row.id, destinationKey }, "Failed to deliver pending promise; continuing");
    }
  }
}

// ── Cache validity check (used before enqueuing) ──────────────────────────────

/**
 * Returns true when a valid (non-expired, done) cache entry already exists
 * for this destination so we don't re-enqueue unnecessarily.
 */
export async function hasValidJITCache(destination: string): Promise<boolean> {
  const existing = await getJITVenuesForDestination(destination);
  return existing !== null;
}

// ── Prompt context builder ────────────────────────────────────────────────────

/**
 * Builds the system-prompt block that injects JIT venue knowledge for a
 * non-NYC destination. Returns null when no cache is ready.
 * Marked "provisional / web-sourced, not staff-vetted" so the agent hedges.
 */
export async function buildJITVenuePromptSection(destination: string): Promise<string | null> {
  if (isNYCDestination(destination)) return null;

  const cache = await getJITVenuesForDestination(destination.toLowerCase());
  if (!cache || cache.venues.length === 0) return null;

  const lines = cache.venues.map((v) =>
    `- ${v.name} [${v.venueType}] — ${v.vibe} | groups: ${v.groupFriendliness} | price: ${v.roughPrice}`,
  );

  return (
    `\nWeb-sourced venue knowledge for ${destination} (provisional — not staff-vetted; hedge confidence when citing these):\n` +
    lines.join("\n")
  );
}
