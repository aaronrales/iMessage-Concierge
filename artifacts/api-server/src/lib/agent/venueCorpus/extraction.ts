import type OpenAI from "openai";
import { openai, CHAT_MODEL } from "../../openaiClient";
import { logger } from "../../logger";
import {
  ATTRIBUTE_DIMENSIONS,
  EXTRACTION_SCHEMA_VERSION,
  SIGNAL_SOURCES,
  type AttributeDimension,
  type SignalSource,
} from "./constants";

/**
 * LLM web-search extraction pass: given a venue candidate (name +
 * neighborhood), searches the web for each signal source and each attribute
 * dimension and returns a best-effort structured value with a confidence
 * score, per the BRD's "no scraping/partner APIs" decision. Uses the
 * Responses API's built-in `web_search` tool (not chat completions) so the
 * model actually looks things up instead of guessing from parametric memory.
 */

export interface ExtractedSignal {
  source: SignalSource;
  value: Record<string, unknown>;
  confidence: number;
  sourceUrls: string[];
}

export interface ExtractedAttribute {
  dimension: AttributeDimension;
  value: Record<string, unknown>;
  confidence: number;
  sourceCount: number;
  sourceUrls: string[];
}

export interface VenueExtractionResult {
  signals: ExtractedSignal[];
  attributes: ExtractedAttribute[];
  /** True if the web search turned up strong evidence the venue is closed/no longer operating -- feeds the closure check on revalidation. */
  closureSuspected: boolean;
  closureNote: string | null;
}

const SIGNAL_DESCRIPTIONS: Record<SignalSource, string> = {
  google_rating: "Google Maps/Search star rating and review count, if findable.",
  infatuation: "Whether The Infatuation has reviewed/listed it, and their rough sentiment.",
  eater38: "Whether it appears on Eater's 'Eater 38' or similar Eater best-of lists for its area.",
  michelin: "Whether it holds a Michelin star, Bib Gourmand, or is Michelin-Guide-listed at all.",
  reddit_mentions: "How often and how positively/negatively it comes up in NYC-focused subreddits (r/FoodNYC, r/AskNYC, r/nyc, etc).",
  resy_bookable: "Whether it takes reservations via Resy, and how hard tables are to get.",
  opentable_bookable: "Whether it takes reservations via OpenTable, and how hard tables are to get.",
};

const ATTRIBUTE_DESCRIPTIONS: Record<AttributeDimension, string> = {
  noise_level: "How loud the room typically is (quiet / moderate / loud), from reviews.",
  group_friendliness: "How well it accommodates groups of 4-8 (large tables, group menus, willingness to seat groups).",
  reservation_reality: "How realistic it is to actually get a table -- walk-in only, easy same-week, or notoriously hard to book.",
  vibe: "A short honest vibe descriptor (e.g. 'date-night quiet', 'loud group hangout', 'casual neighborhood spot').",
  price_honesty: "Whether the $ signs/price tier match what reviewers actually report paying -- flags places that read cheap but aren't.",
  dietary_breadth: "How well it handles common dietary needs (vegetarian, vegan, gluten-free, allergies) per reviews.",
  outdoor_seating: "Whether it has real outdoor/patio/sidewalk seating.",
  bar_while_waiting: "Whether there's a bar area worth waiting at if a table isn't ready yet.",
};

const EXTRACTION_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", enum: [...SIGNAL_SOURCES] },
          value: { type: "string", description: "Best-effort free-text finding for this source, e.g. 'rated 4.5 with ~2k reviews' or 'listed on Eater 38 (2023), positive'." },
          confidence: { type: "number", description: "0-1 confidence in this finding, lower if search results were sparse/ambiguous." },
          sourceUrls: { type: "array", items: { type: "string" } },
        },
        required: ["source", "value", "confidence", "sourceUrls"],
        additionalProperties: false,
      },
    },
    attributes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string", enum: [...ATTRIBUTE_DIMENSIONS] },
          value: { type: "string", description: "Best-effort free-text finding for this attribute dimension." },
          confidence: { type: "number" },
          sourceCount: { type: "number", description: "How many distinct sources informed this attribute finding." },
          sourceUrls: { type: "array", items: { type: "string" } },
        },
        required: ["dimension", "value", "confidence", "sourceCount", "sourceUrls"],
        additionalProperties: false,
      },
    },
    closureSuspected: { type: "boolean", description: "True only if search results strongly suggest the venue is permanently closed or no longer operating." },
    closureNote: { type: ["string", "null"] },
  },
  required: ["signals", "attributes", "closureSuspected", "closureNote"],
  additionalProperties: false,
};

function buildPrompt(venueName: string, neighborhood: string, city: string): string {
  const signalLines = SIGNAL_SOURCES.map((source) => `- ${source}: ${SIGNAL_DESCRIPTIONS[source]}`).join("\n");
  const attributeLines = ATTRIBUTE_DIMENSIONS.map((dim) => `- ${dim}: ${ATTRIBUTE_DESCRIPTIONS[dim]}`).join("\n");

  return `You are researching a restaurant/bar for a curated venue database. Use web search to find real, current information -- do not invent details.

Venue: "${venueName}"
Location: ${neighborhood}, ${city}

For EACH of these signal sources, search the web and report a best-effort finding with a confidence score (lower confidence if results are sparse, ambiguous, or you're not sure it's the same venue):
${signalLines}

For EACH of these attribute dimensions, search the web (reviews, forum threads, guides) and report a best-effort finding with a confidence score and how many distinct sources informed it:
${attributeLines}

Also flag if your search turns up strong evidence the venue has permanently closed or is no longer operating (e.g. multiple recent reports, "permanently closed" on listings).

If you cannot find anything for a given source/dimension, still include it with a low confidence (e.g. 0.1) and a value like "no evidence found" rather than omitting it.`;
}

function clampConfidence(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, num));
}

/**
 * Runs one venue through the extraction pipeline. Returns `null` (rather
 * than throwing) on any failure, so a single bad candidate can't take down
 * a whole neighborhood batch -- callers should skip and continue.
 */
export async function extractVenueSignalsAndAttributes(
  venueName: string,
  neighborhood: string,
  city = "New York",
): Promise<VenueExtractionResult | null> {
  try {
    const response = await openai.responses.create({
      model: CHAT_MODEL,
      // The installed `openai` SDK's TS types only know about
      // "web_search_preview", but the AI Integrations proxy accepts (and
      // actually performs) "web_search" at runtime -- confirmed with a live
      // call. Cast to bypass the stale type union rather than downgrading
      // to the preview tool name.
      tools: [{ type: "web_search" }] as unknown as OpenAI.Responses.Tool[],
      input: buildPrompt(venueName, neighborhood, city),
      text: {
        format: {
          type: "json_schema",
          name: "venue_extraction",
          schema: EXTRACTION_JSON_SCHEMA,
          strict: true,
        },
      },
    });

    const raw = response.output_text;
    if (!raw) {
      logger.warn({ venueName, neighborhood }, "Venue extraction returned no output text");
      return null;
    }

    const parsed = JSON.parse(raw) as {
      signals?: { source?: unknown; value?: unknown; confidence?: unknown; sourceUrls?: unknown }[];
      attributes?: { dimension?: unknown; value?: unknown; confidence?: unknown; sourceCount?: unknown; sourceUrls?: unknown }[];
      closureSuspected?: unknown;
      closureNote?: unknown;
    };

    const signals: ExtractedSignal[] = (parsed.signals ?? [])
      .filter((s): s is { source: SignalSource; value: unknown; confidence: unknown; sourceUrls: unknown } =>
        typeof s.source === "string" && (SIGNAL_SOURCES as readonly string[]).includes(s.source),
      )
      .map((s) => ({
        source: s.source,
        value: { note: typeof s.value === "string" ? s.value : String(s.value ?? "") },
        confidence: clampConfidence(s.confidence),
        sourceUrls: Array.isArray(s.sourceUrls) ? s.sourceUrls.filter((u): u is string => typeof u === "string") : [],
      }));

    const attributes: ExtractedAttribute[] = (parsed.attributes ?? [])
      .filter((a): a is { dimension: AttributeDimension; value: unknown; confidence: unknown; sourceCount: unknown; sourceUrls: unknown } =>
        typeof a.dimension === "string" && (ATTRIBUTE_DIMENSIONS as readonly string[]).includes(a.dimension),
      )
      .map((a) => ({
        dimension: a.dimension,
        value: { note: typeof a.value === "string" ? a.value : String(a.value ?? "") },
        confidence: clampConfidence(a.confidence),
        sourceCount: typeof a.sourceCount === "number" && Number.isFinite(a.sourceCount) ? Math.max(0, Math.round(a.sourceCount)) : 0,
        sourceUrls: Array.isArray(a.sourceUrls) ? a.sourceUrls.filter((u): u is string => typeof u === "string") : [],
      }));

    return {
      signals,
      attributes,
      closureSuspected: parsed.closureSuspected === true,
      closureNote: typeof parsed.closureNote === "string" ? parsed.closureNote : null,
    };
  } catch (error) {
    logger.error({ error, venueName, neighborhood }, "Venue extraction pass failed");
    return null;
  }
}

export { EXTRACTION_SCHEMA_VERSION };
