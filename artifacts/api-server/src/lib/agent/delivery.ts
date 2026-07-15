import { eq } from "drizzle-orm";
import { db, threadsTable } from "@workspace/db";
import { logger } from "../logger";
import { sendDirectMessage, sendGroupMessage } from "../sendblue";
import { recordMessage } from "./context";

/**
 * Sends a message into a thread. The transport (group vs direct, and which
 * phone/group id to use) is always looked up from the target thread's own DB
 * record, never taken from the caller. Shared by the webhook handler and the
 * proactive scheduler (`scheduler.ts`) so both go through one delivery path.
 */
export async function sendToThread(threadId: number, content: string): Promise<void> {
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));

  try {
    if (thread?.isGroup && thread.sendblueGroupId) {
      await sendGroupMessage({ groupId: thread.sendblueGroupId, content });
    } else if (thread?.primaryPhoneNumber) {
      await sendDirectMessage({ to: thread.primaryPhoneNumber, content });
    } else {
      logger.warn({ threadId }, "Cannot send outbound message: thread has no known transport");
    }
  } catch (error) {
    logger.error({ error, threadId }, "Failed to send outbound Sendblue message");
  }

  await recordMessage({ threadId, userId: null, direction: "outbound", role: "assistant", content });
}
