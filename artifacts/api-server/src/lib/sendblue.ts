import { logger } from "./logger";

const SENDBLUE_BASE_URL = "https://api.sendblue.com";

interface SendMessageOptions {
  to: string;
  content: string;
  /** URL of an already-uploaded attachment (see `uploadMediaToSendblue`). */
  mediaUrl?: string;
  /**
   * iMessage bubble/screen effect. Only applies to iMessage recipients;
   * SMS fallbacks receive the same text content without error.
   * Values: celebration, shooting_star, fireworks, lasers, love, confetti,
   * balloons, spotlight, echo, invisible, gentle, loud, slam.
   */
  sendStyle?: string;
}

interface SendGroupMessageOptions {
  groupId: string;
  content: string;
  mediaUrl?: string;
  /** See `sendStyle` on `SendMessageOptions`. */
  sendStyle?: string;
}

/** Valid tapback reaction types accepted by Sendblue's `/api/send-reaction`. */
export type TapbackReaction = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

function getCredentials(): { keyId: string; secretKey: string; fromNumber: string } | null {
  const keyId = process.env["SENDBLUE_API_KEY_ID"];
  const secretKey = process.env["SENDBLUE_API_SECRET_KEY"];
  const fromNumber = process.env["SENDBLUE_FROM_NUMBER"];

  if (!keyId || !secretKey || !fromNumber) {
    return null;
  }

  return { keyId, secretKey, fromNumber };
}

/**
 * Whether outbound sends are actually configured. Callers use this to decide
 * whether to attempt a real send or just log + persist locally, since this
 * build may run before a Sendblue account/number is connected.
 */
export function isSendblueConfigured(): boolean {
  return getCredentials() !== null;
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const credentials = getCredentials();
  if (!credentials) {
    logger.warn(
      { path },
      "Sendblue credentials are not configured; skipping outbound send",
    );
    return null;
  }

  const response = await fetch(`${SENDBLUE_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "sb-api-key-id": credentials.keyId,
      "sb-api-secret-key": credentials.secretKey,
    },
    body: JSON.stringify(body),
  });

  const data: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    logger.error({ path, status: response.status, data }, "Sendblue API request failed");
    throw new Error(`Sendblue request to ${path} failed with status ${response.status}`);
  }

  return data;
}

/** Send a 1:1 iMessage/SMS. Returns the Sendblue message handle if available. */
export async function sendDirectMessage({ to, content, mediaUrl, sendStyle }: SendMessageOptions): Promise<string | null> {
  const credentials = getCredentials();
  const data = (await post("/api/send-message", {
    content,
    number: to,
    from_number: credentials?.fromNumber,
    ...(mediaUrl ? { media_url: mediaUrl } : {}),
    ...(sendStyle ? { send_style: sendStyle } : {}),
  })) as { message_handle?: string } | null;

  return data?.message_handle ?? null;
}

/** Send a message into an existing Sendblue group thread. */
export async function sendGroupMessage({
  groupId,
  content,
  mediaUrl,
  sendStyle,
}: SendGroupMessageOptions): Promise<string | null> {
  const credentials = getCredentials();
  const data = (await post("/api/send-group-message", {
    content,
    group_id: groupId,
    from_number: credentials?.fromNumber,
    ...(mediaUrl ? { media_url: mediaUrl } : {}),
    ...(sendStyle ? { send_style: sendStyle } : {}),
  })) as { message_handle?: string } | null;

  return data?.message_handle ?? null;
}

/**
 * Sends a tapback reaction (❤️ 👍 👎 😂 !! ?) to a specific inbound message.
 * Best-effort: logs failures but never throws, so a reaction hiccup never
 * blocks the main reply flow. iMessage only; a no-op on SMS threads.
 *
 * @param messageHandle  The Apple GUID from the inbound Sendblue webhook
 *                       (`message_handle` field on the event body).
 * @param reaction       One of: love, like, dislike, laugh, emphasize, question.
 */
export async function sendReaction(messageHandle: string, reaction: TapbackReaction): Promise<void> {
  const credentials = getCredentials();
  if (!credentials) {
    logger.warn({ messageHandle }, "Sendblue credentials not configured; skipping reaction");
    return;
  }
  try {
    await post("/api/send-reaction", {
      from_number: credentials.fromNumber,
      message_handle: messageHandle,
      reaction,
    });
  } catch (error) {
    // Best-effort: a failed reaction must never break the surrounding flow.
    logger.warn({ error, messageHandle, reaction }, "Failed to send Sendblue tapback reaction");
  }
}

/**
 * Attempts to create a new iMessage group by sending to an array of phone
 * numbers. Sendblue's `/api/send-group-message` endpoint accepts a `numbers`
 * array in place of `group_id` to bootstrap a new group thread.
 *
 * IMPORTANT: As of mid-2026, Sendblue's documented group-message endpoint
 * officially requires `group_id` for existing groups. The `numbers`-based
 * creation path is NOT publicly documented and may not be supported on all
 * Sendblue plans. If this call succeeds, the response should include a
 * `group_id` for the newly created group; if it fails (4xx) or returns no
 * `group_id`, group creation is not available and callers must fall back to
 * instructions for the user to create the group manually.
 */
export async function createGroupWithNumbers(numbers: string[], content: string): Promise<string | null> {
  const credentials = getCredentials();
  if (!credentials) {
    logger.warn("Sendblue credentials are not configured; cannot create group");
    return null;
  }

  try {
    const data = (await post("/api/send-group-message", {
      numbers: [...numbers, credentials.fromNumber],
      content,
      from_number: credentials.fromNumber,
    })) as { group_id?: string } | null;

    if (data?.group_id) {
      logger.info({ groupId: data.group_id, participantCount: numbers.length }, "Sendblue group created");
      return data.group_id;
    }
    logger.warn({ data }, "Sendblue group-create response missing group_id; group creation may not be supported");
    return null;
  } catch (error) {
    // Swallow -- callers fall back to user-facing instructions.
    logger.warn({ error }, "Sendblue group creation failed; falling back to manual-creation instructions");
    return null;
  }
}

interface SendCarouselOptions {
  /** 1:1 thread recipient phone number. Provide exactly one of `to` or `groupId`. */
  to?: string;
  /** Existing Sendblue group ID. Provide exactly one of `to` or `groupId`. */
  groupId?: string;
  /** Between 2 and 20 HTTPS image URLs (Sendblue CDN or public). */
  mediaUrls: string[];
}

/**
 * Sends a swipeable photo carousel via Sendblue's `POST /api/send-carousel`.
 * iMessage only — returns `null` on 4xx so callers can skip gracefully for
 * SMS threads or unsupported plans. Requires 2–20 images; single-image or
 * empty calls are skipped before hitting the API.
 */
export async function sendCarousel({ to, groupId, mediaUrls }: SendCarouselOptions): Promise<string | null> {
  const credentials = getCredentials();
  if (!credentials) {
    logger.warn("Sendblue credentials not configured; skipping carousel send");
    return null;
  }
  if (mediaUrls.length < 2) {
    logger.warn({ mediaCount: mediaUrls.length }, "Carousel requires at least 2 images; skipping");
    return null;
  }

  try {
    const body: Record<string, unknown> = {
      from_number: credentials.fromNumber,
      media_urls: mediaUrls.slice(0, 20), // API accepts 2–20
    };
    if (groupId) body["group_id"] = groupId;
    else if (to) body["number"] = to;

    const data = (await post("/api/send-carousel", body)) as { message_handle?: string } | null;
    return data?.message_handle ?? null;
  } catch (error) {
    // 4xx is expected for SMS threads and plans without carousel support.
    logger.warn({ error, hasGroupId: !!groupId, mediaCount: mediaUrls.length }, "Carousel send failed (SMS or plan limit); falling back to text-only");
    return null;
  }
}

/**
 * Sends an animated "..." typing indicator to a single recipient. Sendblue
 * does not support this for group chats, so callers should only invoke this
 * for 1:1 threads (see `delivery.ts`). Best-effort: failures are logged, not
 * thrown, so a typing-indicator hiccup never breaks the actual reply.
 */
export async function sendTypingIndicator(to: string): Promise<void> {
  const credentials = getCredentials();
  try {
    await post("/api/send-typing-indicator", {
      number: to,
      from_number: credentials?.fromNumber,
    });
  } catch (error) {
    logger.warn({ error, to }, "Failed to send Sendblue typing indicator");
  }
}

/**
 * Uploads a file (e.g. a generated plan card image) to Sendblue's CDN so it
 * can be attached to a message via `mediaUrl`. Returns `null` if upload
 * fails or credentials are missing, so callers can fall back to a text-only
 * send instead of throwing.
 */
export async function uploadMediaToSendblue(buffer: Buffer, filename: string, contentType: string): Promise<string | null> {
  const credentials = getCredentials();
  if (!credentials) {
    logger.warn("Sendblue credentials are not configured; skipping media upload");
    return null;
  }

  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), filename);

    const response = await fetch(`${SENDBLUE_BASE_URL}/api/upload-file`, {
      method: "POST",
      headers: {
        "sb-api-key-id": credentials.keyId,
        "sb-api-secret-key": credentials.secretKey,
      },
      body: form,
    });

    const data = (await response.json().catch(() => null)) as { media_url?: string; url?: string } | null;
    if (!response.ok) {
      logger.error({ status: response.status, data }, "Sendblue media upload failed");
      return null;
    }
    return data?.media_url ?? data?.url ?? null;
  } catch (error) {
    logger.error({ error }, "Sendblue media upload threw an error");
    return null;
  }
}
