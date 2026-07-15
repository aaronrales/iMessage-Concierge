import { eq } from "drizzle-orm";
import { db, profilesTable } from "@workspace/db";
import type { ThreadContext } from "./context";

/**
 * Group taste engine: aggregates every known member's constraints into one
 * anonymized summary the model can silently satisfy, without ever learning
 * (from this summary) which person contributed which constraint. This is
 * the prompt-level control; `scrubPrivateProfileLeaks` remains the
 * output-level safety net in case a leak slips through anyway.
 */
export function buildGroupConstraintSummary(context: ThreadContext): string | null {
  const budgets = new Set<string>();
  const dietaryNeeds = new Set<string>();
  const preferences = new Set<string>();

  for (const { profile } of context.participants) {
    if (!profile) continue;
    if (profile.budget) budgets.add(profile.budget);
    if (profile.dietaryNeeds) dietaryNeeds.add(profile.dietaryNeeds);
    for (const pref of profile.preferences) preferences.add(pref);
  }

  if (budgets.size === 0 && dietaryNeeds.size === 0 && preferences.size === 0) return null;

  const lines: string[] = [];
  if (budgets.size > 0) lines.push(`Budget ranges to satisfy across the group: ${[...budgets].join(", ")}`);
  if (dietaryNeeds.size > 0) lines.push(`Dietary needs to accommodate across the group: ${[...dietaryNeeds].join(", ")}`);
  if (preferences.size > 0) lines.push(`General preferences to consider across the group: ${[...preferences].join(", ")}`);

  return lines.join("\n");
}

/**
 * Structured group constraints extracted from participant profiles for use
 * in corpus filtering and boosting. Separate from the text summary injected
 * into the LLM prompt -- this is the machine-readable form that lets
 * `lookupCorpusVenues` do real filtering rather than hoping the LLM picks
 * the right venue from a text hint.
 */
export interface GroupConstraints {
  /** All dietary needs across group members, lowercased (e.g. ["vegan", "gluten-free"]). */
  dietaryNeeds: string[];
  /**
   * All budget tier strings expressed by members (e.g. ["$", "$$"]).
   * The cheapest tier is used as a ceiling when filtering.
   */
  budgetTiers: string[];
  /** All preference keywords across members, lowercased (e.g. ["outdoor seating", "quiet"]). */
  preferences: string[];
  /** Number of participants -- used to assess group-friendliness relevance. */
  partySize: number;
}

/** Budget tier → numeric level for ceiling comparisons (higher = more expensive). */
const BUDGET_TIER_LEVEL: Record<string, number> = {
  "$": 1,
  "$$": 2,
  "$$$": 3,
  "$$$$": 4,
};

/**
 * Returns the numeric price ceiling from the tightest budget in the group
 * (the smallest tier level present). Returns `Infinity` if no budgets are
 * known, meaning no ceiling is applied.
 */
export function groupBudgetCeiling(budgetTiers: string[]): number {
  if (budgetTiers.length === 0) return Infinity;
  const levels = budgetTiers.map((t) => BUDGET_TIER_LEVEL[t] ?? 2);
  return Math.min(...levels);
}

/**
 * Extracts structured group constraints directly from participant profiles
 * for passing into the corpus lookup layer. Returns `null` for 1:1 threads
 * or when no member has any known constraint -- no-op for lookup.
 */
export function extractGroupConstraints(context: ThreadContext): GroupConstraints | null {
  if (!context.thread.isGroup) return null;

  const dietaryNeeds = new Set<string>();
  const budgetTiers = new Set<string>();
  const preferences = new Set<string>();

  for (const { profile } of context.participants) {
    if (!profile) continue;
    if (profile.dietaryNeeds) {
      // Split on commas/semicolons in case multiple needs are in one field.
      for (const need of profile.dietaryNeeds.split(/[,;]\s*/)) {
        const normalized = need.trim().toLowerCase();
        if (normalized) dietaryNeeds.add(normalized);
      }
    }
    if (profile.budget) {
      budgetTiers.add(profile.budget.trim());
    }
    for (const pref of profile.preferences) {
      const normalized = pref.trim().toLowerCase();
      if (normalized) preferences.add(normalized);
    }
  }

  const partySize = context.participants.length;

  if (dietaryNeeds.size === 0 && budgetTiers.size === 0 && preferences.size === 0 && partySize < 2) {
    return null;
  }

  return {
    dietaryNeeds: [...dietaryNeeds],
    budgetTiers: [...budgetTiers],
    preferences: [...preferences],
    partySize,
  };
}

/**
 * Cross-thread memory: a one-line callout for a participant the concierge
 * already has real history with (from other threads), so a first turn in a
 * *new* group with them can use that context immediately instead of
 * starting cold. Keyed off the user row itself, which is shared across
 * every thread this phone number appears in.
 */
export function describeReturningMember(participant: ThreadContext["participants"][number]): string | null {
  const { user, profile } = participant;
  if (user.onboardingStatus !== "completed") return null;

  const bits = [
    profile?.preferences?.length ? `preferences: ${profile.preferences.join(", ")}` : null,
    profile?.pastChoices?.length ? `has previously gone to: ${profile.pastChoices.slice(-3).join(", ")}` : null,
  ].filter(Boolean);

  if (bits.length === 0) return null;
  return `${user.displayName ?? user.phoneNumber} is a returning person the concierge already knows from other threads (${bits.join("; ")}).`;
}

/**
 * Appends a venue to a user's choice history (capped to the most recent 20)
 * so future threads -- including brand new groups this person joins --
 * benefit from what they've actually done before, not just stated
 * preferences.
 */
export async function recordPastChoice(userId: number, venue: string): Promise<void> {
  const [existing] = await db.select().from(profilesTable).where(eq(profilesTable.userId, userId));
  const pastChoices = [...(existing?.pastChoices ?? []), venue].slice(-20);

  await db
    .insert(profilesTable)
    .values({ userId, pastChoices })
    .onConflictDoUpdate({ target: profilesTable.userId, set: { pastChoices } });
}
