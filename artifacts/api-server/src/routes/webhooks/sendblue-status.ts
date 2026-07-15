import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, messageDeliveryLogTable, threadParticipantsTable, usersTable } from "@workspace/db";
import { setParticipantMuted } from "../../lib/agent/context";
import { logger } from "../../lib/logger";

/**
 * Webhook handler for Sendblue delivery-status and compliance events.
 *
 * Two event categories are handled here:
 *
 * 1. **Outbound delivery status** (`outbound` events from Sendblue's account
 *    webhook or `status_callback` per-send URL):
 *    - ERROR / FAILED → insert a `messageDeliveryLog` row and log a warning.
 *    - DELIVERED / SENT → optionally insert a log row for audit.
 *
 * 2. **Line blocked** (`line_blocked` events): Sendblue fires this when a
 *    recipient explicitly blocks the concierge number. On receipt we:
 *    - Mute the user in every thread they participate in.
 *    - Insert a BLOCKED row in `messageDeliveryLog` for operator visibility.
 *
 * Auth is the same shared-secret-in-URL scheme used by the inbound webhook.
 * Callers receive a 200 ACK as quickly as possible; side-effects are awaited
 * inline (this handler is not on the hot path, unlike the inbound webhook).
 */

const router: IRouter = Router();

router.post("/webhooks/sendblue-status/:secret", async (req, res): Promise<void> => {
  const expectedSecret = process.env["SENDBLUE_WEBHOOK_SECRET"];

  if (!expectedSecret) {
    logger.error("SENDBLUE_WEBHOOK_SECRET is not configured; rejecting status webhook");
    res.status(503).json({ error: "Webhook not configured" });
    return;
  }

  if (req.params["secret"] !== expectedSecret) {
    logger.warn("Rejected Sendblue status webhook with invalid secret");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // ACK immediately — Sendblue retries on non-2xx, and our DB writes are fast
  // enough that we can await them inline without risking a timeout.
  res.status(200).json({ received: true });

  const body = req.body as Record<string, unknown>;

  try {
    // ── line_blocked event ─────────────────────────────────────────────────
    // Sendblue fires this when a recipient blocks the concierge number.
    // The payload has a `type: "line_blocked"` field and a `phone_number`.
    if (body["type"] === "line_blocked") {
      await handleLineBlocked(body);
      return;
    }

    // ── outbound delivery status event ─────────────────────────────────────
    // These come from the account-level `outbound` webhook or `status_callback`
    // per-send parameter. `is_outbound: true` is the discriminator.
    if (body["is_outbound"] === true) {
      await handleOutboundStatus(body);
      return;
    }

    // Unknown event type — log and ignore.
    logger.debug({ body }, "Sendblue status webhook: unrecognized event shape; ignoring");
  } catch (error) {
    // Never surface errors upward — we already ACK'd. Just log for debugging.
    logger.error({ error, body }, "Sendblue status webhook handler threw an unexpected error");
  }
});

// ── Outbound delivery status ────────────────────────────────────────────────

async function handleOutboundStatus(payload: Record<string, unknown>): Promise<void> {
  const messageHandle = typeof payload["message_handle"] === "string" ? payload["message_handle"] : null;
  const recipientPhone = typeof payload["number"] === "string" ? payload["number"] : null;
  const status = typeof payload["status"] === "string" ? payload["status"].toUpperCase() : "UNKNOWN";
  const errorCode = typeof payload["error_code"] === "string" ? payload["error_code"] : null;

  const isFailure = status === "ERROR" || status === "FAILED";

  // Log failures at warn level so they appear in alerting tools.
  if (isFailure) {
    logger.warn(
      { messageHandle, recipientPhone, status, errorCode },
      "Sendblue outbound message delivery failure",
    );
  } else {
    logger.debug({ messageHandle, recipientPhone, status }, "Sendblue outbound delivery status");
  }

  // Persist failures (and optionally DELIVERED) to the delivery log.
  if (isFailure || status === "DELIVERED") {
    await db.insert(messageDeliveryLogTable).values({
      messageHandle,
      recipientPhone,
      status,
      errorCode,
      rawPayload: payload,
    });
  }
}

// ── Line blocked ────────────────────────────────────────────────────────────

async function handleLineBlocked(payload: Record<string, unknown>): Promise<void> {
  const phoneNumber =
    typeof payload["phone_number"] === "string"
      ? payload["phone_number"]
      : typeof payload["number"] === "string"
        ? payload["number"]
        : null;

  if (!phoneNumber) {
    logger.warn({ payload }, "line_blocked event missing phone_number; ignoring");
    return;
  }

  logger.warn({ phoneNumber }, "Sendblue line_blocked event: muting user in all threads");

  // Insert compliance record first so even a partial failure is visible.
  await db.insert(messageDeliveryLogTable).values({
    messageHandle: null,
    recipientPhone: phoneNumber,
    status: "BLOCKED",
    errorCode: null,
    rawPayload: payload,
  });

  // Look up the user by phone number. If they're not in the DB, there's
  // nothing to mute — the block may have arrived before any inbound message.
  const [user] = await db.select().from(usersTable).where(eq(usersTable.phoneNumber, phoneNumber));
  if (!user) {
    logger.info({ phoneNumber }, "line_blocked: no user found for this phone; nothing to mute");
    return;
  }

  // Mute the user in every thread they participate in.
  const participations = await db
    .select({ threadId: threadParticipantsTable.threadId })
    .from(threadParticipantsTable)
    .where(eq(threadParticipantsTable.userId, user.id));

  await Promise.all(
    participations.map(({ threadId }) => setParticipantMuted(threadId, user.id, true)),
  );

  logger.info(
    { phoneNumber, userId: user.id, threadCount: participations.length },
    "line_blocked: user muted in all threads",
  );
}

export default router;
