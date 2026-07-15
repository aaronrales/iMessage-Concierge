import { eq } from "drizzle-orm";
import { db, threadsTable } from "@workspace/db";
import { logger } from "../logger";
import { sendDirectMessage, sendGroupMessage, sendTypingIndicator } from "../sendblue";
import { recordMessage } from "./context";

const MAX_BUBBLE_CHARS = 220;
const MAX_BUBBLES = 3;

/**
 * Splits a long reply into a handful of natural-length texts instead of one
 * wall of text, mirroring how people actually text. Prefers explicit
 * paragraph breaks; falls back to splitting on sentence boundaries once a
 * chunk gets too long. Capped at `MAX_BUBBLES` so a runaway reply still
 * lands as a *few* texts, not a flood.
 */
export function splitIntoBubbles(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const source = paragraphs.length > 1 ? paragraphs : [trimmed];

  const bubbles: string[] = [];
  for (const paragraph of source) {
    if (paragraph.length <= MAX_BUBBLE_CHARS) {
      bubbles.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let current = "";
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence}` : sentence;
      if (candidate.length > MAX_BUBBLE_CHARS && current) {
        bubbles.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
    }
    if (current) bubbles.push(current);
  }

  if (bubbles.length <= MAX_BUBBLES) return bubbles;

  // Too many pieces -- collapse the tail back into the last bubble rather
  // than sending an unreasonable number of texts.
  const head = bubbles.slice(0, MAX_BUBBLES - 1);
  const tail = bubbles.slice(MAX_BUBBLES - 1).join(" ");
  return [...head, tail];
}

/**
 * Sends a message into a thread. The transport (group vs direct, and which
 * phone/group id to use) is always looked up from the target thread's own DB
 * record, never taken from the caller. Shared by the webhook handler and the
 * proactive scheduler (`scheduler.ts`) so both go through one delivery path.
 *
 * Long replies are split into multiple natural-length bubbles. `mediaUrl`,
 * when given, is attached to the *last* bubble only (e.g. a plan card image
 * follows the text, the way a person would send it).
 */
export async function sendToThread(threadId: number, content: string, mediaUrl?: string): Promise<void> {
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
  const bubbles = splitIntoBubbles(content);
  if (bubbles.length === 0 && !mediaUrl) return;
  if (bubbles.length === 0) bubbles.push("");

  for (let i = 0; i < bubbles.length; i++) {
    const bubbleContent = bubbles[i] as string;
    const bubbleMediaUrl = i === bubbles.length - 1 ? mediaUrl : undefined;

    try {
      if (thread?.isGroup && thread.sendblueGroupId) {
        await sendGroupMessage({ groupId: thread.sendblueGroupId, content: bubbleContent, mediaUrl: bubbleMediaUrl });
      } else if (thread?.primaryPhoneNumber) {
        await sendDirectMessage({ to: thread.primaryPhoneNumber, content: bubbleContent, mediaUrl: bubbleMediaUrl });
      } else {
        logger.warn({ threadId }, "Cannot send outbound message: thread has no known transport");
      }
    } catch (error) {
      logger.error({ error, threadId }, "Failed to send outbound Sendblue message");
    }

    await recordMessage({ threadId, userId: null, direction: "outbound", role: "assistant", content: bubbleContent });
  }
}

/**
 * Fires a typing indicator for a thread while a tool call (venue lookup,
 * etc.) is in flight. Sendblue doesn't support this for group chats, so
 * group threads are a silent no-op here rather than an error.
 */
export async function showTypingIndicator(threadId: number): Promise<void> {
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
  if (!thread || thread.isGroup || !thread.primaryPhoneNumber) return;
  await sendTypingIndicator(thread.primaryPhoneNumber);
}
