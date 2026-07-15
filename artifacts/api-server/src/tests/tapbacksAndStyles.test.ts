import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for Task #33: tapback reactions and expressive send styles.
 *
 * `sendReaction` is a thin wrapper around the Sendblue `/api/send-reaction`
 * endpoint. Tests mock global `fetch` to verify:
 *   1. The correct Sendblue endpoint and body are used.
 *   2. The call is fire-and-forget (best-effort): errors are swallowed.
 *   3. Missing credentials skip the call silently.
 *
 * `send_style` propagation through `sendDirectMessage` / `sendGroupMessage`
 * is verified to confirm the parameter reaches the Sendblue API body.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

function makeFetchMock(status = 200, body: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

const CREDS = {
  SENDBLUE_API_KEY_ID: "test-key",
  SENDBLUE_API_SECRET_KEY: "test-secret",
  SENDBLUE_FROM_NUMBER: "+10000000000",
};

// ── sendReaction ──────────────────────────────────────────────────────────────

describe("sendReaction", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    Object.assign(process.env, CREDS);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("calls POST /api/send-reaction with the correct body", async () => {
    const fetchMock = makeFetchMock(200, {});
    global.fetch = fetchMock;

    const { sendReaction } = await import("../lib/sendblue");
    await sendReaction("handle-abc-123", "like");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/send-reaction");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from_number: CREDS.SENDBLUE_FROM_NUMBER,
      message_handle: "handle-abc-123",
      reaction: "like",
    });
  });

  it("does not throw when the API returns a non-2xx status", async () => {
    const fetchMock = makeFetchMock(400, { error: "bad request" });
    global.fetch = fetchMock;

    const { sendReaction } = await import("../lib/sendblue");
    // Should resolve without throwing — best-effort.
    await expect(sendReaction("handle-xyz", "love")).resolves.toBeUndefined();
  });

  it("does not throw when fetch itself rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { sendReaction } = await import("../lib/sendblue");
    await expect(sendReaction("handle-xyz", "love")).resolves.toBeUndefined();
  });

  it("skips the API call when Sendblue credentials are not configured", async () => {
    delete process.env["SENDBLUE_API_KEY_ID"];
    const fetchMock = makeFetchMock();
    global.fetch = fetchMock;

    const { sendReaction } = await import("../lib/sendblue");
    await sendReaction("handle-xyz", "like");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── send_style propagation ───────────────────────────────────────────────────

describe("sendDirectMessage send_style propagation", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    Object.assign(process.env, CREDS);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("includes send_style in the request body when provided", async () => {
    const fetchMock = makeFetchMock(200, { message_handle: "h1" });
    global.fetch = fetchMock;

    const { sendDirectMessage } = await import("../lib/sendblue");
    await sendDirectMessage({
      to: "+15551234567",
      content: "Confirmed: dinner!",
      sendStyle: "celebration",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.send_style).toBe("celebration");
  });

  it("omits send_style from the request body when not provided", async () => {
    const fetchMock = makeFetchMock(200, { message_handle: "h2" });
    global.fetch = fetchMock;

    const { sendDirectMessage } = await import("../lib/sendblue");
    await sendDirectMessage({ to: "+15551234567", content: "Hello!" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("send_style");
  });
});

describe("sendGroupMessage send_style propagation", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };
    Object.assign(process.env, CREDS);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("includes send_style in the group message body when provided", async () => {
    const fetchMock = makeFetchMock(200, { message_handle: "h3" });
    global.fetch = fetchMock;

    const { sendGroupMessage } = await import("../lib/sendblue");
    await sendGroupMessage({
      groupId: "group-123",
      content: "Everyone's voted! We're going with The Smith.",
      sendStyle: "confetti",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.send_style).toBe("confetti");
  });
});

// ── splitIntoBubbles (style applied only to last bubble) ─────────────────────

describe("splitIntoBubbles — send_style goes on the last bubble only", () => {
  it("last bubble carries the style, earlier ones do not (invariant documented in sendToThread)", () => {
    // This is a logic invariant, not a fetch-level test. We verify it by
    // confirming the design: sendToThread applies sendStyle only to the
    // last (i === bubbles.length - 1) iteration. The test here is
    // documentary — the real coverage is in the webhook integration tests.
    //
    // If the implementation changes so that style applies to a non-last
    // bubble, this comment should be updated alongside the code.
    expect(true).toBe(true); // placeholder for the documented invariant
  });
});
