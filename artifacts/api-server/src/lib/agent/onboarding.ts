/**
 * Structured first-interaction onboarding for new 1:1 users.
 *
 * Instead of leaving the LLM to opportunistically collect profile info,
 * this module drives a deterministic 3-step exchange the first time a
 * user contacts the concierge (or receives a group-referral DM):
 *
 *   Step 0  – not_started: send intro + ask for name
 *   Step 1  – in_progress, no displayName: extract name, ask for practical
 *   Step 2  – in_progress, has name, no practical: extract budget/dietary, ask for personality
 *   Step 3  – in_progress, has practical, no personality: extract signal, confirm + complete
 *
 * Step state is inferred from existing profile fields -- no extra DB column.
 */

import { openai, CHAT_MODEL } from "../openaiClient";
import { logger } from "../logger";
import { logLlmCost } from "./costLogger";

// ---------------------------------------------------------------------------
// Message templates
// Two variants: directDm (cold 1:1 intro) and groupDm (group-referral 1:1).
// ---------------------------------------------------------------------------

export const ONBOARDING = {
  directDm: {
    /** Sent on the user's very first inbound message. */
    intro: `Hi, I'm your AI concierge -- I help plan the stuff of everyday life: dinners, weekend plans, "where should we all go". What should I call you?`,
    /** Sent after name is learned. */
    askPractical: (name: string) =>
      `Nice to meet you, ${name}. Any dietary needs or a rough budget range I should keep in mind for suggestions?`,
    /** Sent after practical is learned. Prefix with confirmation of what was heard. */
    askPersonality: (confirmation: string) =>
      `${confirmation} -- one more thing: what's your go-to cuisine or vibe when you want a good night out?`,
    /** Sent after all three steps are complete. Prefix with confirmation. */
    complete: (confirmation: string) =>
      `${confirmation}. All set -- I'll factor that in whenever I'm planning something.`,
  },
  groupDm: {
    /**
     * Sent when a new group member gets the disclosure DM.
     * `privacyUrl` is appended when available so bystanders know their options
     * before answering any questions.
     */
    intro: (groupContext: string, privacyUrl?: string | null) => {
      const base = `Hi! I help coordinate plans for ${groupContext} -- dinners, hangouts, "where should we all go". You can text me "mute you" to stay quiet or "forget me" to delete your data${privacyUrl ? ` (full details: ${privacyUrl})` : ""}. What should I call you?`;
      return base;
    },
    /** Sent after name is learned. */
    askPractical: (name: string) =>
      `Nice to meet you, ${name}. Any dietary needs or budget range I should know about when I'm planning for the group?`,
    /** Sent after practical is learned. */
    askPersonality: (confirmation: string) =>
      `${confirmation} -- last thing: what's your go-to cuisine or vibe for a night out?`,
    /** Sent after completion. */
    complete: (confirmation: string) =>
      `${confirmation}. All set -- I'll make sure your picks are part of the plan.`,
  },
} as const;

// ---------------------------------------------------------------------------
// Step detection
// Inferred from existing profile fields -- no new DB column needed.
// ---------------------------------------------------------------------------

export type OnboardingStep = 0 | 1 | 2 | 3 | "complete";

/**
 * Returns which onboarding step the user is currently on, derived from
 * existing profile fields rather than a separate step counter.
 *
 *   0          – status is 'not_started': intro hasn't been sent yet
 *   1          – intro was sent, waiting for name (displayName still null)
 *   2          – have name, waiting for practical (no budget or dietaryNeeds)
 *   3          – have practical, waiting for personality signal (no preferences)
 *   "complete" – all collected (or already marked completed)
 */
export function getOnboardingStep(
  status: "not_started" | "in_progress" | "completed",
  displayName: string | null | undefined,
  profile: { budget?: string | null; dietaryNeeds?: string | null; preferences?: string[] | null } | null | undefined,
): OnboardingStep {
  if (status === "completed") return "complete";
  if (status === "not_started") return 0;
  // status === "in_progress"
  if (!displayName) return 1;
  if (!profile?.budget && !profile?.dietaryNeeds) return 2;
  if (!profile?.preferences?.length) return 3;
  // All fields present but status wasn't flipped yet -- treat as needing completion
  return "complete";
}

// ---------------------------------------------------------------------------
// Confirmation builders (deterministic -- no LLM needed)
// ---------------------------------------------------------------------------

/** Short confirmation to prefix the next question after step 2. */
export function buildPracticalConfirmation(budget: string | null, dietaryNeeds: string | null): string {
  const parts: string[] = [];
  if (budget) parts.push(budget);
  if (dietaryNeeds) parts.push(dietaryNeeds);
  return parts.length ? `Got it -- ${parts.join(", ")}` : "Got it";
}

/** Short confirmation to prefix the completion message after step 3. */
export function buildPersonalityConfirmation(preferences: string[]): string {
  return preferences.length ? `Love it -- ${preferences.slice(0, 2).join(" & ")}` : "Got it";
}

// ---------------------------------------------------------------------------
// Persona-aware reply generator
// ---------------------------------------------------------------------------

/**
 * Generates an onboarding reply in the bot's persona voice (lowercase-casual,
 * warm, conversational) using a short LLM completion.
 *
 * The generator:
 *  - Briefly acknowledges any off-script content in `incomingMessage` before
 *    confirming what was just learned and asking the next field question.
 *  - Keeps replies to 1-2 short sentences (~40 tokens).
 *  - Falls back to `fallback` (the existing template string) if the LLM call
 *    fails, so onboarding never silently breaks.
 */
export async function generateOnboardingReply(params: {
  step: 0 | 1 | 2 | 3;
  variant: "directDm" | "groupDm";
  incomingMessage: string;
  /** Populated after step 1 succeeds (name was extracted). */
  extractedName?: string | null;
  /** Populated after step 2 (practical extraction). */
  extractedBudget?: string | null;
  extractedDietaryNeeds?: string | null;
  /** Populated after step 3 (personality extraction). */
  extractedPreferences?: string[];
  /** Used by step 0 groupDm intro. */
  groupContext?: string;
  privacyUrl?: string | null;
  /** Template fallback sent verbatim if the LLM call fails. */
  fallback: string;
}): Promise<string> {
  const {
    step, variant, incomingMessage,
    extractedName, extractedBudget, extractedDietaryNeeds,
    extractedPreferences, groupContext, privacyUrl, fallback,
  } = params;

  try {
    const stepGuide = buildStepGuide(
      step, variant,
      { extractedName, extractedBudget, extractedDietaryNeeds, extractedPreferences, groupContext, privacyUrl },
    );

    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 50,
      messages: [
        {
          role: "system",
          content:
            `You are a warm, lowercase-casual AI concierge texting via iMessage. ` +
            `Write like a real person: sentence fragments ok, minimal punctuation, no emoji unless it genuinely fits. ` +
            `If the incoming message includes small talk, an off-topic remark, or anything beyond the expected answer, ` +
            `briefly acknowledge it in a natural, friendly way before the question. ` +
            `Keep your total reply to 1-2 short sentences.\n\n${stepGuide}`,
        },
        { role: "user", content: incomingMessage },
      ],
    });
    logLlmCost("onboarding_reply", CHAT_MODEL, res.usage);
    const reply = (res.choices[0]?.message?.content ?? "").trim();
    return reply || fallback;
  } catch (err) {
    logger.warn({ err, step }, "onboarding: reply generation LLM call failed; using template fallback");
    return fallback;
  }
}

/**
 * Returns a concise instruction block for the LLM describing what was just
 * extracted and what to ask / say next.
 */
function buildStepGuide(
  step: 0 | 1 | 2 | 3,
  variant: "directDm" | "groupDm",
  ctx: {
    extractedName?: string | null;
    extractedBudget?: string | null;
    extractedDietaryNeeds?: string | null;
    extractedPreferences?: string[];
    groupContext?: string;
    privacyUrl?: string | null;
  },
): string {
  switch (step) {
    case 0: {
      if (variant === "groupDm") {
        const gc = ctx.groupContext ?? "the group";
        const privacyNote = ctx.privacyUrl
          ? `They can also text "mute you" to go quiet or "forget me" to delete their data (details: ${ctx.privacyUrl}).`
          : `They can also text "mute you" to go quiet or "forget me" to delete their data.`;
        return (
          `Task: introduce yourself as an AI concierge that helps coordinate plans for ${gc} ` +
          `(dinners, hangouts, "where should we all go"). ${privacyNote} ` +
          `End by asking: what should I call you?`
        );
      }
      return (
        `Task: introduce yourself as a personal AI concierge that helps plan everyday life ` +
        `-- dinners, weekend plans, "where should we all go". ` +
        `End by asking: what should I call you?`
      );
    }
    case 1: {
      if (ctx.extractedName) {
        return (
          `Task: you just learned their name is ${ctx.extractedName}. ` +
          `Acknowledge it warmly (e.g. "nice, ${ctx.extractedName}"), then ask: ` +
          `any dietary needs or rough budget range I should keep in mind for suggestions?`
        );
      }
      // Name extraction failed — ask again.
      return (
        `Task: you couldn't catch their name from what they sent. ` +
        `Gently ask again: what should I call you? Keep it light and friendly.`
      );
    }
    case 2: {
      const parts: string[] = [];
      if (ctx.extractedBudget) parts.push(ctx.extractedBudget);
      if (ctx.extractedDietaryNeeds) parts.push(ctx.extractedDietaryNeeds);
      const learned = parts.length
        ? `you just heard: ${parts.join(", ")}.`
        : `they didn't share specific practical needs.`;
      return (
        `Task: ${learned} ` +
        `Briefly confirm what you heard (or note "got it" if nothing specific), then ask: ` +
        `what's your go-to cuisine or vibe when you want a good night out?`
      );
    }
    case 3: {
      const prefs = ctx.extractedPreferences ?? [];
      const learned = prefs.length
        ? `you just heard their vibe: ${prefs.join(", ")}.`
        : `they shared some personality/vibe info.`;
      return (
        `Task: ${learned} ` +
        `Briefly confirm what you heard, then tell them they're all set — ` +
        `you'll factor that in whenever you're planning something. Warm but concise.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// LLM field extraction (small, cheap completions)
// ---------------------------------------------------------------------------

/** Extract the name a user wants to be called from their reply to "what should I call you?". */
export async function extractName(content: string): Promise<string | null> {
  try {
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 15,
      messages: [
        {
          role: "system",
          content:
            'The user was asked what they should be called. Reply with ONLY the name or nickname they gave (1-2 words), or the word "null" if no clear name was provided.',
        },
        { role: "user", content },
      ],
    });
    logLlmCost("onboarding", CHAT_MODEL, res.usage);
    const raw = (res.choices[0]?.message?.content ?? "").trim();
    if (!raw || raw.toLowerCase() === "null") return null;
    // Basic sanity: treat suspiciously long responses as extraction failure
    if (raw.split(" ").length > 3) return null;
    return raw;
  } catch (err) {
    logger.warn({ err }, "onboarding: name extraction LLM call failed");
    return null;
  }
}

/** Extract budget range and/or dietary needs from a practical-constraint reply. */
export async function extractPractical(content: string): Promise<{ budget: string | null; dietaryNeeds: string | null }> {
  try {
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 60,
      messages: [
        {
          role: "system",
          content:
            "The user was asked about budget range and dietary needs. Extract what they said. Reply with ONLY a JSON object: {\"budget\": string|null, \"dietaryNeeds\": string|null}. Keep each value concise (under 6 words). Use null if they didn't mention it.",
        },
        { role: "user", content },
      ],
    });
    const raw = (res.choices[0]?.message?.content ?? "").trim();
    // Strip markdown code fences if the model wrapped it
    logLlmCost("onboarding", CHAT_MODEL, res.usage);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as { budget?: string | null; dietaryNeeds?: string | null };
    return {
      budget: typeof parsed.budget === "string" && parsed.budget ? parsed.budget : null,
      dietaryNeeds: typeof parsed.dietaryNeeds === "string" && parsed.dietaryNeeds ? parsed.dietaryNeeds : null,
    };
  } catch (err) {
    logger.warn({ err }, "onboarding: practical extraction LLM call failed");
    return { budget: null, dietaryNeeds: null };
  }
}

/** Extract cuisine/vibe preference tags from a personality-signal reply. */
export async function extractPersonality(content: string): Promise<string[]> {
  try {
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 50,
      messages: [
        {
          role: "system",
          content:
            'The user described their food/dining personality (go-to cuisine, vibe, favorite spot type). Extract 1-3 short preference tags. Reply with ONLY a JSON array of strings, e.g. ["Italian","low-key spots"]. Empty array if nothing useful.',
        },
        { role: "user", content },
      ],
    });
    logLlmCost("onboarding", CHAT_MODEL, res.usage);
    const raw = (res.choices[0]?.message?.content ?? "").trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 3);
    }
    return [];
  } catch (err) {
    logger.warn({ err }, "onboarding: personality extraction LLM call failed");
    return [];
  }
}
