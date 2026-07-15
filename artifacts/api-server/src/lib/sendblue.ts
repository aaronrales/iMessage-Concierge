import { logger } from "./logger";

const SENDBLUE_BASE_URL = "https://api.sendblue.com";

interface SendMessageOptions {
  to: string;
  content: string;
  /** URL of an already-uploaded attachment (see `uploadMediaToSendblue`). */
  mediaUrl?: string;
}

interface SendGroupMessageOptions {
  groupId: string;
  content: string;
  mediaUrl?: string;
}

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
export async function sendDirectMessage({ to, content, mediaUrl }: SendMessageOptions): Promise<string | null> {
  const credentials = getCredentials();
  const data = (await post("/api/send-message", {
    content,
    number: to,
    from_number: credentials?.fromNumber,
    ...(mediaUrl ? { media_url: mediaUrl } : {}),
  })) as { message_handle?: string } | null;

  return data?.message_handle ?? null;
}

/** Send a message into an existing Sendblue group thread. */
export async function sendGroupMessage({
  groupId,
  content,
  mediaUrl,
}: SendGroupMessageOptions): Promise<string | null> {
  const credentials = getCredentials();
  const data = (await post("/api/send-group-message", {
    content,
    group_id: groupId,
    from_number: credentials?.fromNumber,
    ...(mediaUrl ? { media_url: mediaUrl } : {}),
  })) as { message_handle?: string } | null;

  return data?.message_handle ?? null;
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
