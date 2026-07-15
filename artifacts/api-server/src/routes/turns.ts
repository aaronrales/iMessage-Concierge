import { Router, type IRouter } from "express";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, messagesTable, turnRatingsTable } from "@workspace/db";

/**
 * Turn-quality review endpoints consumed by the ops dashboard Turns page.
 *
 * GET  /turn-ratings/recent  — 50 most recent agent turns with their triggering
 *                             user message and any existing rating.
 * POST /turn-ratings/:messageId — upsert a rating for an agent turn (idempotent).
 */

const router: IRouter = Router();

const UpsertRatingBody = z.object({
  threadId: z.number().int(),
  rating: z.enum(["thumbs_up", "thumbs_down"]),
  failureTag: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const MessageIdParam = z.object({
  messageId: z.coerce.number().int(),
});

/**
 * Returns the 50 most recent assistant messages with:
 * - The preceding inbound user message in the same thread (for context)
 * - Any existing admin rating
 *
 * Used by the Turns dashboard page to show a reviewable feed of agent replies.
 */
router.get("/turn-ratings/recent", async (_req, res): Promise<void> => {
  // Fetch the 50 most recent assistant/outbound messages.
  const agentMessages = await db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.direction, "outbound"), eq(messagesTable.role, "assistant")))
    .orderBy(desc(messagesTable.createdAt))
    .limit(50);

  if (agentMessages.length === 0) {
    res.json({ turns: [] });
    return;
  }

  // For each agent message, find the most recent inbound user message that
  // came just before it in the same thread (the triggering message).
  // We batch this into one query using a lateral-style approach: for each
  // agent message id, get the max inbound message id that is less than it.
  const precedingRows = await Promise.all(
    agentMessages.map(async (msg) => {
      const [preceding] = await db
        .select({ id: messagesTable.id, content: messagesTable.content, userId: messagesTable.userId })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.threadId, msg.threadId),
            eq(messagesTable.direction, "inbound"),
            lt(messagesTable.id, msg.id),
          ),
        )
        .orderBy(desc(messagesTable.id))
        .limit(1);
      return { agentMessageId: msg.id, preceding: preceding ?? null };
    }),
  );

  // Fetch all existing ratings for these message ids in one query.
  const messageIds = agentMessages.map((m) => m.id);
  const ratings =
    messageIds.length > 0
      ? await db
          .select()
          .from(turnRatingsTable)
          .where(sql`${turnRatingsTable.messageId} = ANY(${sql.raw(`ARRAY[${messageIds.join(",")}]`)})`)
      : [];

  const ratingByMessageId = new Map(ratings.map((r) => [r.messageId, r]));
  const precedingByAgentId = new Map(precedingRows.map((r) => [r.agentMessageId, r.preceding]));

  const turns = agentMessages.map((msg) => {
    const rating = ratingByMessageId.get(msg.id);
    const preceding = precedingByAgentId.get(msg.id);
    return {
      messageId: msg.id,
      threadId: msg.threadId,
      agentContent: msg.content,
      agentCreatedAt: msg.createdAt,
      precedingUserContent: preceding?.content ?? null,
      rating: rating?.rating ?? null,
      failureTag: rating?.failureTag ?? null,
      notes: rating?.notes ?? null,
      ratedAt: rating?.ratedAt ?? null,
    };
  });

  res.json({ turns });
});

/**
 * Upserts a rating for an agent message. If the message has already been
 * rated, replaces the existing row (the admin changed their mind).
 */
router.post("/turn-ratings/:messageId", async (req, res): Promise<void> => {
  const params = MessageIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid messageId" });
    return;
  }

  const body = UpsertRatingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(eq(messagesTable.id, params.data.messageId));

  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  await db
    .insert(turnRatingsTable)
    .values({
      messageId: params.data.messageId,
      threadId: body.data.threadId,
      rating: body.data.rating,
      failureTag: body.data.failureTag ?? null,
      notes: body.data.notes ?? null,
    })
    .onConflictDoUpdate({
      target: turnRatingsTable.messageId,
      set: {
        rating: body.data.rating,
        failureTag: body.data.failureTag ?? null,
        notes: body.data.notes ?? null,
        ratedAt: new Date(),
      },
    });

  res.json({ ok: true });
});

export default router;
