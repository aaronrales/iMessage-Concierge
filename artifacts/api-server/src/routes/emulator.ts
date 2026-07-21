import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  ListEmulatorThreadsResponse,
  SendEmulatorMessageBody,
  SendEmulatorMessageResponse,
} from "@workspace/api-zod";
import { db, threadParticipantsTable, threadsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runEmulatorTurn } from "../lib/agent/runEmulatorTurn";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// The generated body schema carries the spec's field types; keep the stricter
// runtime constraints (positive int id, non-empty strings) layered on top.
const SendMessageBody = SendEmulatorMessageBody.extend({
  threadId: z.number().int().positive(),
  senderPhone: z.string().min(1),
  content: z.string().min(1),
});

/**
 * POST /emulator/message
 *
 * Injects a message into a thread and runs the agent synchronously,
 * capturing all outbound sends (to this thread and any others) without
 * calling Sendblue. The budget governor is bypassed so emulator calls
 * never consume daily proactive-send limits.
 *
 * Returns the full list of captured outbound messages so the UI can
 * display the agent's reply and any side-effect sends (e.g. payment-request
 * DMs to other threads) in a single response.
 */
router.post("/emulator/message", async (req, res) => {
  const parseResult = SendMessageBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body", details: parseResult.error.flatten() });
    return;
  }

  const { threadId, senderPhone, content } = parseResult.data;

  // Verify the target thread exists.
  const [thread] = await db.select().from(threadsTable).where(eq(threadsTable.id, threadId));
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  try {
    const result = await runEmulatorTurn(threadId, senderPhone, content);
    res.json(SendEmulatorMessageResponse.parse({ messages: result.messages }));
  } catch (error) {
    logger.error({ error, threadId }, "Emulator turn failed");
    res.status(500).json({ error: "Emulator turn failed" });
  }
});

/**
 * GET /emulator/threads
 *
 * Returns a lightweight list of all threads with their participants so the
 * emulator UI can populate the thread selector dropdown.
 */
router.get("/emulator/threads", async (_req, res) => {
  try {
    const threads = await db
      .select({
        id: threadsTable.id,
        isGroup: threadsTable.isGroup,
        title: threadsTable.title,
        primaryPhoneNumber: threadsTable.primaryPhoneNumber,
      })
      .from(threadsTable)
      .orderBy(threadsTable.id);

    // Fetch participants for each thread.
    const participants = await db
      .select({
        threadId: threadParticipantsTable.threadId,
        userId: usersTable.id,
        phoneNumber: usersTable.phoneNumber,
        displayName: usersTable.displayName,
      })
      .from(threadParticipantsTable)
      .innerJoin(usersTable, eq(threadParticipantsTable.userId, usersTable.id));

    const participantsByThread = new Map<number, typeof participants>();
    for (const p of participants) {
      const arr = participantsByThread.get(p.threadId) ?? [];
      arr.push(p);
      participantsByThread.set(p.threadId, arr);
    }

    const result = threads.map((t) => ({
      ...t,
      participants: participantsByThread.get(t.id) ?? [],
    }));

    res.json(ListEmulatorThreadsResponse.parse(result));
  } catch (error) {
    logger.error({ error }, "Failed to list threads for emulator");
    res.status(500).json({ error: "Failed to list threads" });
  }
});

export default router;
