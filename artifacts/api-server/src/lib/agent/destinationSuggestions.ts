/**
 * Destination shortlist and decision support for trip projects.
 *
 * When a trip project has no destination yet, the agent can request a
 * destination shortlist. This module:
 *   1. Runs a web-search LLM call to produce 3–5 destination candidates
 *      framed by the group's budget and date window (OpenAI Responses API,
 *      same pattern as venue extraction).
 *   2. Exposes helpers to persist the destination once the group decides.
 *   3. Provides `isDestinationPoll` / `getProjectByDestinationPollId` so the
 *      poll-close path in the webhook can detect and lock a destination.
 *
 * Cost context in the suggestions is rough framing only — no flight or hotel
 * APIs are called. The agent explicitly tells the group this is an estimate.
 */

import type OpenAI from "openai";
import { openai, CHAT_MODEL } from "../openaiClient";
import { logger } from "../logger";
import { logLlmCost } from "./costLogger";
import { db, projectsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { PROJECT_ACTIVE_STATUSES, type Project } from "@workspace/db";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DestinationCandidate {
  /** City or region name that will become a poll option. */
  label: string;
  /** One-line vibe note shown alongside the option. */
  vibeNote: string;
  /** Rough per-person cost context as free text (e.g. "~$650/person"). */
  roughCostContext: string;
}

export interface DestinationShortlist {
  candidates: DestinationCandidate[];
  /** Introductory sentence the agent uses to frame the shortlist. */
  intro: string;
}

// ── JSON schema for the LLM response ────────────────────────────────────────

const SHORTLIST_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    intro: {
      type: "string",
      description:
        "A single friendly sentence the concierge will use to introduce the shortlist in the group chat (e.g. 'Here are a few destinations that fit your budget and March dates:').",
    },
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "City or region name only (e.g. 'Nashville', 'Austin', 'Scottsdale'). No country or state unless needed for disambiguation.",
          },
          vibe_note: {
            type: "string",
            description:
              "One honest sentence about the vibe — what makes it a good fit for this group (e.g. 'Great for a long weekend, easy direct flights from NYC, strong bar scene').",
          },
          rough_cost_context: {
            type: "string",
            description:
              "Rough per-person cost framing as free text (e.g. '~$650/person all-in for a 3-night stay'). Flag clearly that this is an estimate, not a quote.",
          },
        },
        required: ["label", "vibe_note", "rough_cost_context"],
        additionalProperties: false,
      },
    },
  },
  required: ["intro", "candidates"],
  additionalProperties: false,
};

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildSuggestionPrompt(
  budget: string | null,
  dateWindow: string | null,
  originCity: string | null,
  groupSize: number,
): string {
  const budgetLine = budget ? `Budget context: ${budget}` : "Budget context: not specified";
  const dateLine = dateWindow ? `Date window: ${dateWindow}` : "Date window: not specified";
  const originLine = originCity ? `Group's home city / likely departure point: ${originCity}` : "Home city: unknown";
  const sizeLine = `Group size: ~${groupSize} people`;

  return (
    `You are helping a small friend group pick a trip destination. Use web search to find real, current options — do not invent destinations.\n\n` +
    `${budgetLine}\n${dateLine}\n${originLine}\n${sizeLine}\n\n` +
    `Search for 3–5 destination candidates that are genuinely well-suited for a friend group trip given the constraints above. ` +
    `Focus on domestic US destinations unless the budget strongly implies international. ` +
    `For each candidate, look up rough accommodation and flight costs to form a realistic per-person estimate. ` +
    `Be honest: flag if a destination is more expensive or cheaper than the stated budget. ` +
    `Do NOT suggest destinations that would be way out of budget without a strong reason. ` +
    `Do NOT suggest flights, hotels, or Airbnbs specifically — just rough all-in cost framing. ` +
    `Keep vibe notes short, honest, and useful for a group deciding in a text thread.`
  );
}

// ── Main suggestion function ─────────────────────────────────────────────────

/**
 * Runs a web-search LLM call to generate 3–5 destination candidates for a
 * trip project. Returns null (rather than throwing) on any failure so a
 * single bad call can't block the conversation.
 *
 * @param budget       - Free-text budget from the thread profile (e.g. "$800/person")
 * @param dateWindow   - Free-text date window from project date range
 * @param originCity   - Thread's home city / departure point
 * @param groupSize    - Number of participants in the group thread
 */
export async function suggestDestinations(
  budget: string | null,
  dateWindow: string | null,
  originCity: string | null,
  groupSize: number,
): Promise<DestinationShortlist | null> {
  try {
    const response = await openai.responses.create({
      model: CHAT_MODEL,
      // Same pattern as venueCorpus/extraction.ts — cast to bypass stale SDK types.
      tools: [{ type: "web_search" }] as unknown as OpenAI.Responses.Tool[],
      input: buildSuggestionPrompt(budget, dateWindow, originCity, groupSize),
      text: {
        format: {
          type: "json_schema",
          name: "destination_shortlist",
          schema: SHORTLIST_JSON_SCHEMA,
          strict: true,
        },
      },
    });

    logLlmCost("destination_suggestions", CHAT_MODEL, response.usage ? { prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens } : null);
    const raw = response.output_text;
    if (!raw) {
      logger.warn("Destination suggestion returned no output text");
      return null;
    }

    const parsed = JSON.parse(raw) as {
      intro?: string;
      candidates?: { label?: string; vibe_note?: string; rough_cost_context?: string }[];
    };

    const candidates: DestinationCandidate[] = (parsed.candidates ?? [])
      .filter(
        (c): c is { label: string; vibe_note: string; rough_cost_context: string } =>
          typeof c.label === "string" &&
          c.label.trim().length > 0 &&
          typeof c.vibe_note === "string" &&
          typeof c.rough_cost_context === "string",
      )
      .map((c) => ({
        label: c.label.trim(),
        vibeNote: c.vibe_note.trim(),
        roughCostContext: c.rough_cost_context.trim(),
      }));

    if (candidates.length < 2) {
      logger.warn({ count: candidates.length }, "Destination suggestion returned too few candidates");
      return null;
    }

    return {
      intro: typeof parsed.intro === "string" && parsed.intro.trim() ? parsed.intro.trim() : "Here are some destinations that could work:",
      candidates,
    };
  } catch (error) {
    logger.error({ error }, "Destination suggestion call failed");
    return null;
  }
}

// ── Persistence helpers ──────────────────────────────────────────────────────

/**
 * Stamps the project's destination once the group decides.
 * Also clears `destinationPollId` since the poll is now closed.
 */
export async function setProjectDestination(projectId: number, destination: string): Promise<void> {
  await db
    .update(projectsTable)
    .set({ destination: destination.trim(), destinationPollId: null })
    .where(eq(projectsTable.id, projectId));
  logger.info({ projectId, destination }, "Project destination set");
}

/**
 * Records which open poll is this project's destination decision poll.
 * Called right after creating the destination choice poll.
 */
export async function setProjectDestinationPoll(projectId: number, pollId: number): Promise<void> {
  await db
    .update(projectsTable)
    .set({ destinationPollId: pollId })
    .where(eq(projectsTable.id, projectId));
}

/**
 * Returns the active project that has `destinationPollId` matching the given
 * poll. Used by the poll-close path to detect destination polls and lock in
 * the winning city.
 *
 * Returns null when the poll is not a destination poll or no matching project
 * exists (e.g. if the project was already resolved or the field was cleared).
 */
export async function getProjectByDestinationPollId(pollId: number): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.destinationPollId, pollId),
        inArray(projectsTable.status, [...PROJECT_ACTIVE_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Convenience predicate: true when this poll is an active project's
 * destination decision poll.
 */
export async function isDestinationPoll(pollId: number): Promise<boolean> {
  const project = await getProjectByDestinationPollId(pollId);
  return project !== null;
}

// ── Date window formatter ────────────────────────────────────────────────────

/**
 * Formats a project's date range as a human-readable window for the prompt,
 * e.g. "March 14–16, 2026" or "early March 2026".
 */
export function formatDateWindow(start: Date | null, end: Date | null): string | null {
  if (!start && !end) return null;
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (start && end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return `around ${fmt(start)}`;
  return `around ${fmt(end!)}`;
}
