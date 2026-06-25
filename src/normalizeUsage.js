function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

export function normalizeUsage(raw = {}) {
  const inputTokens = numberOrZero(
    raw.input_tokens ??
      raw.inputTokens ??
      raw.prompt_tokens ??
      raw.promptTokens
  );
  const outputTokens = numberOrZero(
    raw.output_tokens ??
      raw.outputTokens ??
      raw.completion_tokens ??
      raw.completionTokens
  );
  const totalTokens = numberOrZero(
    raw.total_tokens ??
      raw.totalTokens ??
      inputTokens + outputTokens
  );
  const cacheReadTokens = numberOrZero(
    raw.cache_read_tokens ??
      raw.cacheReadTokens ??
      raw.cached_tokens ??
      raw.cachedTokens ??
      raw.cache_read_input_tokens ??
      raw.cached_input_tokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      raw.input_tokens_details?.cached_tokens
  );
  const cacheWriteTokens = numberOrZero(
    raw.cache_write_tokens ??
      raw.cacheWriteTokens
  );
  const reasoningTokens = numberOrZero(
    raw.reasoning_tokens ??
      raw.reasoningTokens ??
      raw.completion_tokens_details?.reasoning_tokens ??
      raw.output_tokens_details?.reasoning_tokens
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens
  };
}
