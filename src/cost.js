export function calculateCost({ provider, model, usage, pricing = {}, localModelsCostMode = "zero" }) {
  const key = `${provider ?? "unknown"}:${model ?? "unknown"}`;
  const entry = pricing[key] ?? pricing[model] ?? null;

  if (entry?.mode === "local_zero" || (!entry && provider === "local" && localModelsCostMode === "zero")) {
    return zeroCost("local_zero");
  }
  if (!entry) return zeroCost("unknown");

  const inputCost = millionRate(usage.inputTokens, entry.inputPerMillion);
  const outputCost = millionRate(usage.outputTokens, entry.outputPerMillion);
  const cacheCost =
    millionRate(usage.cacheReadTokens, entry.cacheReadPerMillion) +
    millionRate(usage.cacheWriteTokens, entry.cacheWritePerMillion);

  return {
    estimatedCostUsd: inputCost + outputCost + cacheCost,
    inputCostUsd: inputCost,
    outputCostUsd: outputCost,
    cacheCostUsd: cacheCost,
    costMode: entry.mode ?? "api_pricing"
  };
}

function millionRate(tokens, rate) {
  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate)) return 0;
  return (Number(tokens) || 0) * numericRate / 1_000_000;
}

function zeroCost(costMode) {
  return {
    estimatedCostUsd: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheCostUsd: 0,
    costMode
  };
}
