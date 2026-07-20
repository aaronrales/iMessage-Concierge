export const MODEL_COST_RATES: Record<string, { promptPer1k: number; completionPer1k: number }> = {
  "gpt-5.4-mini": { promptPer1k: 0.015, completionPer1k: 0.06 },
  "gpt-4o": { promptPer1k: 0.25, completionPer1k: 1.0 },
  "gpt-4o-mini": { promptPer1k: 0.015, completionPer1k: 0.06 },
  "default": { promptPer1k: 0.1, completionPer1k: 0.3 },
};
export function estimateCostCents(model: string, promptTokens: number, completionTokens: number): number {
  const rates = MODEL_COST_RATES[model] ?? MODEL_COST_RATES["default"]!;
  return Math.round((promptTokens / 1000) * rates.promptPer1k + (completionTokens / 1000) * rates.completionPer1k);
}
