import { logger } from "./logger";

const SENDBLUE_BASE_URL = "https://api.sendblue.com";

interface SendMessageOptions {
  to: string;
  content: string;
}

interface SendGroupMessageOptions {
  groupId: string;
  content: string;
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
export async function sendDirectMessage({ to, content }: SendMessageOptions): Promise<string | null> {
  const credentials = getCredentials();
  const data = (await post("/api/send-message", {
    content,
    number: to,
    from_number: credentials?.fromNumber,
  })) as { message_handle?: string } | null;

  return data?.message_handle ?? null;
}

/** Send a message into an existing Sendblue group thread. */
export async function sendGroupMessage({
  groupId,
  content,
}: SendGroupMessageOptions): Promise<string | null> {
  const credentials = getCredentials();
  const data = (await post("/api/send-group-message", {
    content,
    group_id: groupId,
    from_number: credentials?.fromNumber,
  })) as { message_handle?: string } | null;

  return data?.message_handle ?? null;
}
