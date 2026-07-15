import { openai, CHAT_MODEL } from "../openaiClient";
import { db, profilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { ThreadContext } from "./context";
import { logger } from "../logger";
import { AGENT_TOOLS, executeAgentTool } from "./tools";
import type OpenAI from "openai";

/** Safety valve against a runaway tool-call loop; one turn should need at most a couple of round trips. */
const MAX_TOOL_ITERATIONS = 3;

export interface AgentTurnResult {
  reply: string;
  displayName: string | null;
  profileUpdates: {
    budget?: string;
    dietaryNeeds?: string;
    preferences?: string[];
    notes?: string;
  } | null;
  onboardingComplete: boolean | null;
  poll: { question: string; options: string[] } | null;
  bookingDraft: {
    title: string;
    approverPhoneNumber: string | null;
    details: Record<string, unknown>;
  } | null;
}

const SYSTEM_PROMPT = `You are a personal AI concierge that lives inside iMessage. You help one person or a small group plan the stuff of everyday life -- dinners, weekend trips, birthdays, "where should we all meet". You are warm, concise, and text like a helpful friend, not a corporate assistant. Keep replies short enough for a text message (usually under 3 sentences) and never use emojis.

You have these capabilities, which you can trigger by filling in the matching field in your JSON response:
- Updating what you know about a person (their budget, dietary needs, general preferences, or freeform notes) as you learn it naturally through conversation.
- Marking a person's onboarding complete once you've learned their name and at least one or two real preferences. Onboarding does not need to be exhaustive -- a couple of natural questions is enough.
- Starting a group poll when a group needs to choose between a few concrete options (e.g. restaurant choices, dates). Only do this in group threads, and only when there are genuinely multiple options to choose between.
- Drafting a booking when a concrete plan has been decided (e.g. "let's book Sushi Place for 7pm Saturday, party of 4") and it needs a human to confirm before it's considered real. Always require a human approval step for bookings -- never claim a booking is confirmed yourself. If you don't know who should approve, default to the person who is currently talking to you.

You can also call the search_venues tool whenever you're about to suggest a specific place, so you never invent a venue that doesn't exist.

Always respond with ONLY a JSON object matching this shape, no prose outside the JSON:
{
  "reply": string,
  "display_name": string | null,
  "profile_updates": { "budget"?: string, "dietary_needs"?: string, "preferences"?: string[], "notes"?: string } | null,
  "onboarding_complete": boolean | null,
  "poll": { "question": string, "options": string[] } | null,
  "booking_draft": { "title": string, "approver_phone_number": string | null, "details": object } | null
}
Set "display_name" whenever the person tells you their name and it isn't already known -- otherwise leave it null.`;

interface RawAgentResponse {
  reply?: unknown;
  display_name?: unknown;
  profile_updates?: {
    budget?: unknown;
    dietary_needs?: unknown;
    preferences?: unknown;
    notes?: unknown;
  } | null;
  onboarding_complete?: unknown;
  poll?: { question?: unknown; options?: unknown } | null;
  booking_draft?: {
    title?: unknown;
    approver_phone_number?: unknown;
    details?: unknown;
  } | null;
}

function buildTranscript(context: ThreadContext, currentUserId: number): { role: "user" | "assistant"; content: string }[] {
  return context.recentMessages.map((message) => {
    if (message.role === "assistant") {
      return { role: "assistant" as const, content: message.content };
    }
    const speaker = context.participants.find((p) => p.user.id === message.userId)?.user;
    const label = speaker && speaker.id !== currentUserId ? `${speaker.displayName ?? speaker.phoneNumber}: ` : "";
    return { role: "user" as const, content: `${label}${message.content}` };
  });
}

function buildProfileSummary(context: ThreadContext): string {
  return context.participants
    .map(({ user, profile }) => {
      const bits = [
        profile?.budget ? `budget: ${profile.budget}` : null,
        profile?.dietaryNeeds ? `dietary needs: ${profile.dietaryNeeds}` : null,
        profile?.preferences?.length ? `preferences: ${profile.preferences.join(", ")}` : null,
        profile?.notes ? `notes: ${profile.notes}` : null,
      ].filter(Boolean);
      return `- ${user.displayName ?? user.phoneNumber} (onboarding: ${user.onboardingStatus})${
        bits.length ? `: ${bits.join("; ")}` : ""
      }`;
    })
    .join("\n");
}

/**
 * Runs the completion loop, executing any tool calls the model makes along
 * the way, until it returns a final (non-tool-call) message. This is the
 * Phase 0 "agent turn may include tool calls" architecture -- the fast
 * single-call path for chitchat still lands here too, it just resolves after
 * one iteration since the model has no reason to call a tool.
 */
async function runTurnWithTools(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): Promise<string> {
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 1024,
      response_format: { type: "json_object" },
      tools: AGENT_TOOLS,
      messages,
    });

    const message = completion.choices[0]?.message;
    if (!message) {
      return "{}";
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const result = await executeAgentTool(toolCall.function.name, toolCall.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    return message.content ?? "{}";
  }

  logger.warn("Agent turn exceeded max tool-call iterations without a final response");
  return "{}";
}

export async function runAgentTurn(context: ThreadContext, currentUserId: number): Promise<AgentTurnResult> {
  const currentUser = context.participants.find((p) => p.user.id === currentUserId)?.user;
  const isGroup = context.thread.isGroup;

  const situational = [
    `This is a ${isGroup ? "group" : "1:1"} thread.`,
    `You are currently responding to: ${currentUser?.displayName ?? currentUser?.phoneNumber ?? "unknown"} (phone: ${
      currentUser?.phoneNumber
    }).`,
    `Known people in this thread:\n${buildProfileSummary(context)}`,
  ].join("\n\n");

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: situational },
    ...buildTranscript(context, currentUserId),
  ];

  const raw = await runTurnWithTools(messages);

  let parsed: RawAgentResponse;
  try {
    parsed = JSON.parse(raw) as RawAgentResponse;
  } catch (error) {
    logger.error({ error, raw }, "Failed to parse agent response as JSON");
    parsed = { reply: "Sorry, I got a little tangled up there -- can you say that again?" };
  }

  const preferences = Array.isArray(parsed.profile_updates?.preferences)
    ? (parsed.profile_updates?.preferences as unknown[]).filter((p): p is string => typeof p === "string")
    : undefined;

  const profileUpdates =
    parsed.profile_updates && typeof parsed.profile_updates === "object"
      ? {
          ...(typeof parsed.profile_updates.budget === "string" ? { budget: parsed.profile_updates.budget } : {}),
          ...(typeof parsed.profile_updates.dietary_needs === "string"
            ? { dietaryNeeds: parsed.profile_updates.dietary_needs }
            : {}),
          ...(preferences ? { preferences } : {}),
          ...(typeof parsed.profile_updates.notes === "string" ? { notes: parsed.profile_updates.notes } : {}),
        }
      : null;

  const poll =
    parsed.poll &&
    typeof parsed.poll.question === "string" &&
    Array.isArray(parsed.poll.options) &&
    parsed.poll.options.length >= 2
      ? {
          question: parsed.poll.question,
          options: (parsed.poll.options as unknown[]).filter((o): o is string => typeof o === "string"),
        }
      : null;

  const bookingDraft =
    parsed.booking_draft && typeof parsed.booking_draft.title === "string"
      ? {
          title: parsed.booking_draft.title,
          approverPhoneNumber:
            typeof parsed.booking_draft.approver_phone_number === "string"
              ? parsed.booking_draft.approver_phone_number
              : null,
          details:
            typeof parsed.booking_draft.details === "object" && parsed.booking_draft.details !== null
              ? (parsed.booking_draft.details as Record<string, unknown>)
              : {},
        }
      : null;

  return {
    reply: typeof parsed.reply === "string" ? parsed.reply : "Got it.",
    displayName: typeof parsed.display_name === "string" && parsed.display_name.trim() ? parsed.display_name.trim() : null,
    profileUpdates: profileUpdates && Object.keys(profileUpdates).length > 0 ? profileUpdates : null,
    onboardingComplete: typeof parsed.onboarding_complete === "boolean" ? parsed.onboarding_complete : null,
    poll,
    bookingDraft,
  };
}

export async function applyProfileUpdates(
  userId: number,
  updates: NonNullable<AgentTurnResult["profileUpdates"]>,
): Promise<void> {
  const [existing] = await db.select().from(profilesTable).where(eq(profilesTable.userId, userId));

  const mergedPreferences = updates.preferences
    ? Array.from(new Set([...(existing?.preferences ?? []), ...updates.preferences]))
    : undefined;

  await db
    .insert(profilesTable)
    .values({
      userId,
      budget: updates.budget,
      dietaryNeeds: updates.dietaryNeeds,
      preferences: mergedPreferences ?? [],
      notes: updates.notes,
    })
    .onConflictDoUpdate({
      target: profilesTable.userId,
      set: {
        ...(updates.budget !== undefined ? { budget: updates.budget } : {}),
        ...(updates.dietaryNeeds !== undefined ? { dietaryNeeds: updates.dietaryNeeds } : {}),
        ...(mergedPreferences ? { preferences: mergedPreferences } : {}),
        ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
      },
    });
}
