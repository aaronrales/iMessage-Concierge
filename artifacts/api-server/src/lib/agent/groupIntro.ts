import { openai, CHAT_MODEL } from "../openaiClient";
import { db, messagesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../logger";
import { privacyPolicyUrl } from "../publicUrl";
import { logLlmCost } from "./costLogger";

/**
 * Builds the static fallback intro, optionally appending the privacy URL.
 * Called at runtime so the URL is resolved from the current environment.
 */
function buildStaticIntro(): string {
  const privacyUrl = privacyPolicyUrl();
  const base =
    `Hi all -- I'm this group's AI concierge. I help plan things here (polls, bookings, reminders). ` +
    `Say "what do you know about me?" any time, "mute you" to have me stay quiet, or "forget me" to delete your data.`;
  return privacyUrl ? `${base} Privacy info: ${privacyUrl}` : base;
}

/**
 * Generates a context-aware intro for a newly-joined group thread.
 *
 * If the thread already has messages (i.e. the concierge was added to an
 * existing conversation mid-flight), we pass the last 10 messages to the LLM
 * and ask it to open with a line that shows it read the room — e.g. "Sounds
 * like Saturday dinner is in the works — want three options that work for
 * everyone?" rather than the generic boilerplate.
 *
 * Falls back to the static string if:
 *  - There are no prior messages (fresh group)
 *  - The LLM call fails for any reason
 *  - The model returns "STATIC"
 */
export async function generateGroupIntroMessage(threadId: number): Promise<string> {
  try {
    const recentMessages = await db
      .select({ role: messagesTable.role, content: messagesTable.content })
      .from(messagesTable)
      .where(eq(messagesTable.threadId, threadId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(10);

    if (recentMessages.length === 0) {
      return buildStaticIntro();
    }

    // Reverse so oldest → newest for the model.
    const transcript = recentMessages
      .reverse()
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 120,
      messages: [
        {
          role: "system",
          content: [
            "You are an AI concierge that has just been added to an existing group iMessage thread.",
            "Read the recent conversation below.",
            "If planning is already in progress (dinner, trip, event, meetup, or similar), open with ONE sentence that shows you read the room -- e.g. 'Sounds like Saturday dinner is in the works -- want me to find options that work for everyone?'",
            "If there is no planning in progress, respond with just the word STATIC.",
            "Rules: one sentence only, no emojis, no bullet points. Do NOT add the generic concierge pitch — that is handled separately.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Recent messages:\n${transcript}`,
        },
      ],
    });

    logLlmCost("group_intro", CHAT_MODEL, completion.usage);
    const text = completion.choices[0]?.message?.content?.trim() ?? "";

    if (!text || text.toUpperCase() === "STATIC" || text.length < 15) {
      return buildStaticIntro();
    }

    // Append the standard capabilities line so people know how to interact.
    const privacyUrl = privacyPolicyUrl();
    const capabilities =
      ` Say "what do you know about me?" any time, "mute you" to stay quiet, or "forget me" to delete your data.` +
      (privacyUrl ? ` Privacy info: ${privacyUrl}` : "");
    return text.endsWith("?") ? text + capabilities : text + "." + capabilities;
  } catch (error) {
    logger.warn({ error, threadId }, "Contextual group intro LLM call failed; falling back to static intro");
    return buildStaticIntro();
  }
}
