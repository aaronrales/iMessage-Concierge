/**
 * Golden scenario: non-NYC trip tool coverage (Amsterdam)
 *
 * Verifies that `search_lodging` and `search_venues` both:
 *   (a) return non-empty results for a well-known non-NYC city
 *   (b) populate the carousel accumulator (venue photo cards are queued)
 *   (c) produce no duplicate venue entries within a single reply
 *
 * Google Places API calls are intercepted by a fetch mock so the test is
 * deterministic and does not depend on external API availability.
 */

import { vi, beforeAll, afterAll, expect } from "vitest";
import { scenario } from "../scenarioRunner";
import { seedUser, seedDirectThread, cleanupSeededData } from "../seed";
import { db, toolCallLogTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

// ─── Mock Google Places responses ────────────────────────────────────────────

const MOCK_AMSTERDAM_HOTELS = {
  places: [
    {
      id: "amsterdam_hotel_v_nesplein",
      displayName: { text: "Hotel V Nesplein" },
      formattedAddress: "Nes 49, 1012 KD Amsterdam, Netherlands",
      types: ["lodging", "point_of_interest"],
      priceLevel: "PRICE_LEVEL_MODERATE",
      googleMapsUri: "https://maps.google.com/?cid=hotel_v_nesplein",
    },
    {
      id: "amsterdam_pulitzer",
      displayName: { text: "Pulitzer Amsterdam" },
      formattedAddress: "Prinsengracht 315-331, 1016 GZ Amsterdam, Netherlands",
      types: ["lodging", "point_of_interest"],
      priceLevel: "PRICE_LEVEL_EXPENSIVE",
      googleMapsUri: "https://maps.google.com/?cid=pulitzer",
    },
    {
      id: "amsterdam_dylan",
      displayName: { text: "The Dylan Amsterdam" },
      formattedAddress: "Keizersgracht 384, 1016 GB Amsterdam, Netherlands",
      types: ["lodging", "point_of_interest"],
      priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE",
      googleMapsUri: "https://maps.google.com/?cid=dylan",
    },
  ],
};

const MOCK_AMSTERDAM_RESTAURANTS = {
  places: [
    {
      id: "amsterdam_sinne",
      displayName: { text: "Restaurant Sinne" },
      formattedAddress: "Ceintuurbaan 342, 1073 EM Amsterdam, Netherlands",
      types: ["restaurant", "food", "establishment"],
      priceLevel: "PRICE_LEVEL_EXPENSIVE",
      regularOpeningHours: { openNow: true },
      googleMapsUri: "https://maps.google.com/?cid=sinne",
    },
    {
      id: "amsterdam_de_kas",
      displayName: { text: "De Kas" },
      formattedAddress: "Kamerlingh Onneslaan 3, 1097 DE Amsterdam, Netherlands",
      types: ["restaurant", "food", "establishment"],
      priceLevel: "PRICE_LEVEL_EXPENSIVE",
      regularOpeningHours: { openNow: false },
      googleMapsUri: "https://maps.google.com/?cid=de_kas",
    },
    {
      id: "amsterdam_breda",
      displayName: { text: "Breda Amsterdam" },
      formattedAddress: "Singel 210, 1016 AB Amsterdam, Netherlands",
      types: ["restaurant", "food", "establishment"],
      priceLevel: "PRICE_LEVEL_MODERATE",
      regularOpeningHours: { openNow: true },
      googleMapsUri: "https://maps.google.com/?cid=breda",
    },
  ],
};

const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Capture the real fetch before any mock is installed so we can pass through
// non-Places calls (LLM completions, etc.).
const _realFetch = globalThis.fetch;

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;

      if (url === PLACES_TEXT_SEARCH_URL || url.startsWith(PLACES_TEXT_SEARCH_URL + "?")) {
        // Determine which mock to return based on the text query.
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        } catch {
          // ignore parse failures — fall through to real fetch
        }
        const textQuery = typeof body["textQuery"] === "string" ? body["textQuery"].toLowerCase() : "";
        const payload =
          textQuery.includes("hotel") || textQuery.includes("lodging")
            ? MOCK_AMSTERDAM_HOTELS
            : MOCK_AMSTERDAM_RESTAURANTS;

        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass all other calls through to the real fetch.
      return _realFetch(input, init);
    },
  );
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ─── Scenario ─────────────────────────────────────────────────────────────────

scenario({
  name: "amsterdam-non-nyc-trip",

  async seed() {
    const alice = await seedUser("Alice", "+15550009001");
    const bot = await seedUser("Concierge", "+15550009002");
    const t = await seedDirectThread(alice, bot);
    return {
      threadId: t.id,
      users: { alice, bot },
      cleanup: () =>
        cleanupSeededData({ userIds: [alice.id, bot.id], threadIds: [t.id] }),
    };
  },

  turns: [
    // Turn 1: establish the Amsterdam trip context.
    {
      from: "alice",
      text: "Hey! I'm planning a trip to Amsterdam for me and 3 friends in October.",
      expect: [
        { contains: "amsterdam" },
        { regex: /date|when|how long|budget|headcount|tell me more/i },
      ],
    },

    // Turn 2: ask for hotel recommendations.
    // Assertions: (a) search_lodging called with success outcome, (b)+(c) carousel
    // accumulator has hotel entries with unique names.
    {
      from: "alice",
      text: "What hotels do you recommend?",
      expect: [
        // Reply must surface lodging options (names from mock data).
        { regex: /hotel|stay|accommodation|pulitzer|dylan|nesplein/i },
        // Tool outcome logged as success in the DB.
        {
          dbExpect: async ({ threadId }) => {
            const rows = await db
              .select()
              .from(toolCallLogTable)
              .where(
                and(
                  eq(toolCallLogTable.toolName, "search_lodging"),
                  eq(toolCallLogTable.threadId, threadId),
                ),
              )
              .orderBy(desc(toolCallLogTable.createdAt))
              .limit(1);

            expect(rows.length, "search_lodging should have been called").toBe(1);
            expect(
              rows[0]!.outcome,
              "search_lodging should have returned non-empty results (outcome=success)",
            ).toBe("success");
          },
        },
        // Carousel accumulator must have at least one hotel entry.
        {
          carouselExpect: (entries) => {
            expect(
              entries.length,
              "carousel accumulator should have hotel entries after search_lodging",
            ).toBeGreaterThan(0);

            // (c) No venue name must appear more than once in the accumulator.
            const names = entries.map((e) => e.venueName.toLowerCase());
            const uniqueNames = new Set(names);
            expect(
              uniqueNames.size,
              "carousel accumulator must not contain duplicate venue names",
            ).toBe(names.length);
          },
        },
      ],
    },

    // Turn 3: ask for dinner options.
    // Assertions: (a) search_venues called with success outcome, (b)+(c) carousel
    // accumulator has restaurant entries with unique names.
    {
      from: "alice",
      text: "Give me some dinner options too.",
      expect: [
        // Reply must surface restaurant options (names from mock data).
        { regex: /restaurant|dinner|sinne|de kas|breda|eat|food/i },
        // Tool outcome logged as success in the DB.
        {
          dbExpect: async ({ threadId }) => {
            const rows = await db
              .select()
              .from(toolCallLogTable)
              .where(
                and(
                  eq(toolCallLogTable.toolName, "search_venues"),
                  eq(toolCallLogTable.threadId, threadId),
                ),
              )
              .orderBy(desc(toolCallLogTable.createdAt))
              .limit(1);

            expect(rows.length, "search_venues should have been called").toBe(1);
            expect(
              rows[0]!.outcome,
              "search_venues should have returned non-empty results (outcome=success)",
            ).toBe("success");
          },
        },
        // Carousel accumulator must have at least one restaurant entry after this turn.
        {
          carouselExpect: (entries) => {
            expect(
              entries.length,
              "carousel accumulator should have restaurant entries after search_venues",
            ).toBeGreaterThan(0);

            // (c) No venue name must appear more than once within this turn's accumulator.
            const names = entries.map((e) => e.venueName.toLowerCase());
            const uniqueNames = new Set(names);
            expect(
              uniqueNames.size,
              "carousel accumulator must not contain duplicate venue names within a single reply",
            ).toBe(names.length);
          },
        },
      ],
    },
  ],
});
