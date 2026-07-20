/**
 * Lazy OpenAI client.
 *
 * The client is constructed on first call to `getOpenAI()`, not at import
 * time. This means importing this module never throws, so test suites that
 * don't use AI features can load without AI credentials set.
 *
 * Call sites that already use the `openai` named export continue to work —
 * the exported value is a Proxy that delegates to `getOpenAI()` on first
 * property access.
 */
import OpenAI from "openai";

let _client: OpenAI | undefined;

/**
 * Returns the singleton OpenAI client, constructing it on first call.
 * Throws with a clear message if AI credentials are not configured.
 */
export function getOpenAI(): OpenAI {
  if (!_client) {
    const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    if (!baseURL || !apiKey) {
      throw new Error(
        "AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY must be set to use AI features.\n" +
        "In dev/emulator mode without real credentials, AI calls are not available.",
      );
    }
    _client = new OpenAI({ baseURL, apiKey });
  }
  return _client;
}

/**
 * Lazy proxy — delegates every property access to the real client.
 * Import as `import { openai } from "...openaiClient"` as before.
 * Never access this at module load time (only inside function bodies).
 */
export const openai: OpenAI = new Proxy(Object.create(null) as OpenAI, {
  get(_target, prop, _receiver) {
    const client = getOpenAI();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop as string | symbol];
    return typeof value === "function" ? (value as Function).bind(client) : value;
  },
  has(_target, prop) {
    return prop in getOpenAI();
  },
});

/** The model all agent turns use. */
export const CHAT_MODEL = "gpt-5.4-mini";

/** Reset the cached client (useful in tests that swap credentials). */
export function _resetOpenAIClientForTesting(): void {
  _client = undefined;
}
