import { db, toolCallLogTable } from "@workspace/db";
import { logger } from "../logger";

export type ToolOutcome = "success" | "empty" | "api_error" | "not_configured";

/**
 * Logs a single tool call outcome to `tool_call_log`. Fire-and-forget —
 * mirrors the pattern of `logLlmCost` so a write failure never disrupts
 * the agent turn.
 */
export function logToolOutcome(
  toolName: string,
  outcome: ToolOutcome,
  durationMs: number,
  threadId?: number,
): void {
  db.insert(toolCallLogTable)
    .values({ toolName, outcome, durationMs, threadId })
    .catch((err: unknown) =>
      logger.warn({ err, toolName, outcome }, "Tool outcome log insert failed"),
    );
}

/**
 * Inspects a tool's return value and classifies it as one of the four
 * outcome tags. Rules:
 *   - `{ error: ... }` → api_error
 *   - `{ results: [] }` (empty array) → empty
 *   - anything else with content → success
 * Used by the logging wrapper in `executeAgentTool`.
 */
export function classifyOutcome(result: unknown): ToolOutcome {
  if (result === null || result === undefined) return "empty";
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    if ("error" in r) return "api_error";
    if (Array.isArray(r["results"]) && (r["results"] as unknown[]).length === 0) return "empty";
  }
  return "success";
}
