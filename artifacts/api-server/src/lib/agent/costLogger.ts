import { db, llmCostLogTable } from "@workspace/db";
import { estimateCostCents } from "./costRates";
import { logger } from "../logger";
export function logLlmCost(module: string, model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined, threadId?: number): void {
  if (!usage) return;
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const estimatedCostCents = estimateCostCents(model, promptTokens, completionTokens);
  db.insert(llmCostLogTable).values({ threadId, module, model, promptTokens, completionTokens, estimatedCostCents })
    .catch((err: unknown) => logger.warn({ err, module }, "Cost log insert failed"));
}
