import { logger } from "../logger";

/**
 * How long to wait after a message before running the agent turn, so a burst
 * of rapid-fire messages in the same thread collapses into a single turn
 * instead of one LLM call per message.
 */
const DEBOUNCE_WINDOW_MS = 3000;

/**
 * Short acknowledgements/reactions that don't need to wait out the debounce
 * window -- they're cheap enough to just answer immediately, and holding them
 * for the full window would make the concierge feel slow for the common case
 * of a single one-off text.
 */
const CHITCHAT_PATTERN =
  /^(ok(ay)?|k+|thanks?( you)?|thx|ty|lol|lmao|haha+|yep|yup|yes|no|nope|nice|cool|great|sounds good|sure|got it|👍|😂|❤️|🙏)[.!?]*$/i;

export function isChitchat(content: string): boolean {
  return CHITCHAT_PATTERN.test(content.trim());
}

interface PendingTurn {
  timer: NodeJS.Timeout;
}

// In-memory per-thread debounce state. The API server runs as a single
// long-lived process, so this is sufficient -- it does not need to survive a
// restart, since a restart mid-debounce just means the last message in the
// burst gets its own (still correct) turn instead of being batched.
const pendingTurnsByThread = new Map<number, PendingTurn>();

/**
 * Schedules one agent turn for a thread, debouncing rapid-fire messages into
 * a single call. Each new message for the same thread resets the timer; when
 * it finally fires, `runTurn` is invoked once for the whole batch. Because
 * the triggering message is already persisted to the DB before this is
 * called, the batched turn picks up every message in the burst via its
 * normal transcript load -- no separate buffering of message content needed.
 */
export function scheduleAgentTurn(
  threadId: number,
  latestSenderUserId: number,
  latestMessageContent: string,
  runTurn: (threadId: number, latestSenderUserId: number) => Promise<void>,
): void {
  const existing = pendingTurnsByThread.get(threadId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  // Only take the fast path when this message starts a fresh batch -- if a
  // turn is already pending for this thread, stay on the debounce timer so
  // the batch keeps collecting.
  const delayMs = !existing && isChitchat(latestMessageContent) ? 0 : DEBOUNCE_WINDOW_MS;

  const timer = setTimeout(() => {
    pendingTurnsByThread.delete(threadId);
    runTurn(threadId, latestSenderUserId).catch((error) => {
      logger.error({ error, threadId }, "Debounced agent turn failed");
    });
  }, delayMs);

  pendingTurnsByThread.set(threadId, { timer });
}
