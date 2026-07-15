/**
 * Group-chat etiquette: deterministic gates the webhook checks before the
 * LLM ever runs, so the concierge doesn't talk over every message in a busy
 * group thread. None of this applies to 1:1 threads -- a direct message is
 * always "addressed".
 */

import { openai, CHAT_MODEL } from "../openaiClient";
import { logger } from "../logger";

const MUTE_PATTERN = /\b(mute (you|yourself|the bot|concierge)|be quiet|stop responding|pause( yourself)?)\b/i;
const UNMUTE_PATTERN = /\b(unmute (you|yourself|the bot|concierge)|start responding again|you can talk again)\b/i;

export type MuteCommand = "mute" | "unmute" | null;

export function detectMuteCommand(content: string): MuteCommand {
  const normalized = content.trim();
  if (UNMUTE_PATTERN.test(normalized)) return "unmute";
  if (MUTE_PATTERN.test(normalized)) return "mute";
  return null;
}

/** Names/handles the agent recognizes as being addressed directly. */
const AGENT_HANDLE_PATTERN = /\b(concierge|@concierge|hey (bot|assistant)|ok assistant)\b/i;

/**
 * Keywords strongly correlated with "this message is about planning something",
 * not idle chat. Deliberately wide -- common short-form triggers like "drinks?"
 * are intentionally excluded here and handled by the LLM fallback below.
 */
const PLANNING_INTENT_PATTERN =
  /\b(plan|dinner|lunch|brunch|reservation|book(ing)?|restaurant|when (should|are|can) we|what time|this weekend|next (week|weekend)|schedule|poll|vote|meet up|hang out|birthday|trip|calendar|drinks?|coffee|who's? (around|free|up)|anyone (around|free|up)|what('?s)? (everyone|the plan)|are we|should we)\b/i;

export function isAddressedToAgent(content: string): boolean {
  return AGENT_HANDLE_PATTERN.test(content);
}

export function hasPlanningIntent(content: string): boolean {
  return PLANNING_INTENT_PATTERN.test(content);
}

/**
 * LLM fallback for borderline/ambiguous group messages that don't trigger the
 * regex but might still be planning intent (e.g. "who's around sat?", "drinks?").
 *
 * Only called from `shouldRespondInGroup` when the deterministic gate says no,
 * so it adds latency only for the ambiguous case -- not for every message.
 * A cached active-plan check should happen in the caller before invoking this,
 * so the cost is near-zero on threads already mid-plan.
 */
export async function checkPlanningIntentWithLLM(content: string): Promise<boolean> {
  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_completion_tokens: 5,
      messages: [
        {
          role: "system",
          content:
            'Reply with exactly "yes" or "no". Is this message expressing intent to plan or coordinate a social outing -- dinner, drinks, coffee, meeting up, going out, or a similar shared activity?',
        },
        { role: "user", content },
      ],
    });
    const answer = (completion.choices[0]?.message?.content ?? "").trim().toLowerCase();
    return answer.startsWith("yes");
  } catch (err) {
    // Fail toward responding, not silence. An unnecessary reply in a group is
    // far less bad than the concierge going dark because the LLM API had a
    // momentary hiccup. The full etiquette gate (mute check + regex) already
    // filtered out obvious non-planning chatter before reaching this point.
    logger.warn({ err }, "checkPlanningIntentWithLLM failed; defaulting to respond");
    return true;
  }
}

/**
 * Whether the agent should run a full conversational turn for this group
 * message. Callers should only reach this check after ruling out the
 * higher-priority deterministic branches (poll votes, booking approvals,
 * mute/knowledge commands, first-ever message) which are always "addressed"
 * by definition.
 */
export function shouldRespondInGroup(content: string): boolean {
  return isAddressedToAgent(content) || hasPlanningIntent(content);
}
