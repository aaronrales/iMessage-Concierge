/**
 * Central configuration module.
 *
 * All environment-variable access goes through here. This separates required-
 * at-boot vars (missing = hard crash with a clear message) from optional-with-
 * warning vars (missing = feature degraded, boot still succeeds).
 *
 * Import `config` wherever you need an env value; never read process.env
 * directly in application code.
 */
import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────────────────────

/** Required at boot — missing any of these crashes the server immediately. */
const RequiredEnv = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(1, "SESSION_SECRET is required"),
});

/** Required for AI features — missing these does NOT prevent boot but any AI
 * call will throw at first use with a clear message. */
const AIEnv = z.object({
  AI_INTEGRATIONS_OPENAI_BASE_URL: z.string().url().optional(),
  AI_INTEGRATIONS_OPENAI_API_KEY: z.string().min(1).optional(),
});

/**
 * Required for outbound messaging — missing these makes the server run in
 * "emulator/dev mode" where sendToThread is a silent no-op. Useful for local
 * development without real Sendblue credentials.
 */
const MessagingEnv = z.object({
  SENDBLUE_API_KEY_ID: z.string().min(1).optional(),
  SENDBLUE_API_SECRET_KEY: z.string().min(1).optional(),
  SENDBLUE_FROM_NUMBER: z.string().min(1).optional(),
  SENDBLUE_WEBHOOK_SECRET: z.string().min(1).optional(),
});

/** Optional — reasonable defaults apply when absent. */
const OptionalEnv = z.object({
  CONCIERGE_TIMEZONE: z.string().default("America/New_York"),
  GOOGLE_PLACES_API_KEY: z.string().min(1).optional(),
  PUBLIC_API_URL: z.string().url().optional(),
  CONCIERGE_PHONE_NUMBER: z.string().optional(),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  // Quiet-hours window for proactive sends (local time in CONCIERGE_TIMEZONE).
  QUIET_HOURS_START: z.coerce.number().int().min(0).max(23).default(21), // 9pm
  QUIET_HOURS_END: z.coerce.number().int().min(0).max(23).default(9),   // 9am
});

const EnvSchema = RequiredEnv.merge(AIEnv).merge(MessagingEnv).merge(OptionalEnv);

export type Config = z.infer<typeof EnvSchema>;

// ── Validation + boot-time warnings ──────────────────────────────────────────

function loadConfig(): Config {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    // Surface the first required-var failure as a hard error.
    const missingRequired = result.error.issues
      .filter((i) => RequiredEnv.shape[i.path[0] as keyof typeof RequiredEnv.shape] !== undefined)
      .map((i) => String(i.path[0]));

    if (missingRequired.length > 0) {
      throw new Error(
        `Missing required environment variable(s): ${missingRequired.join(", ")}.\n` +
        "See .env.example for documentation on every supported variable.",
      );
    }

    // Non-required issues become non-fatal — fall through to defaults.
  }

  // Use parse (not safeParse) a second time so defaults are applied even if
  // optional vars had issues; required vars already passed above.
  const cfg = EnvSchema.parse(process.env);

  // Emit start-up warnings for degraded-mode scenarios.
  if (!cfg.AI_INTEGRATIONS_OPENAI_BASE_URL || !cfg.AI_INTEGRATIONS_OPENAI_API_KEY) {
    console.warn(
      "[config] AI_INTEGRATIONS_OPENAI_* not set — AI features will throw on first use.",
    );
  }

  const sendblueVars = [
    cfg.SENDBLUE_API_KEY_ID,
    cfg.SENDBLUE_API_SECRET_KEY,
    cfg.SENDBLUE_FROM_NUMBER,
  ];
  if (sendblueVars.some((v) => !v)) {
    console.warn(
      "[config] Sendblue credentials not fully set — outbound messages are no-ops (emulator/dev mode).",
    );
  }

  if (!cfg.GOOGLE_PLACES_API_KEY) {
    console.warn(
      "[config] GOOGLE_PLACES_API_KEY not set — venue and lodging search will return empty results.",
    );
  }

  return cfg;
}

export const config = loadConfig();

// ── Derived helpers ───────────────────────────────────────────────────────────

/** True when all Sendblue credentials are present and the server can send
 * real iMessages. False → emulator/dev mode (no-op sends). */
export const messagingEnabled: boolean =
  Boolean(config.SENDBLUE_API_KEY_ID) &&
  Boolean(config.SENDBLUE_API_SECRET_KEY) &&
  Boolean(config.SENDBLUE_FROM_NUMBER);
