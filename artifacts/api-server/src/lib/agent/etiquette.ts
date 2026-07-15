/**
 * Group-chat etiquette: deterministic gates the webhook checks before the
 * LLM ever runs, so the concierge doesn't talk over every message in a busy
 * group thread. None of this applies to 1:1 threads -- a direct message is
 * always "addressed".
 */

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

/** Keywords strongly correlated with "this message is about planning something", not idle chat. */
const PLANNING_INTENT_PATTERN =
  /\b(plan|dinner|lunch|brunch|reservation|book(ing)?|restaurant|when (should|are|can) we|what time|this weekend|next (week|weekend)|schedule|poll|vote|meet up|hang out|birthday|trip|calendar)\b/i;

export function isAddressedToAgent(content: string): boolean {
  return AGENT_HANDLE_PATTERN.test(content);
}

export function hasPlanningIntent(content: string): boolean {
  return PLANNING_INTENT_PATTERN.test(content);
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
