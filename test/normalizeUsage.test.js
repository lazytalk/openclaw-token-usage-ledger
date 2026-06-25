import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsage } from "../src/normalizeUsage.js";

test("normalizes OpenAI-style usage", () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30
  }), {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  });
});

test("normalizes camelCase and cache/reasoning details", () => {
  assert.deepEqual(normalizeUsage({
    inputTokens: 11,
    outputTokens: 22,
    prompt_tokens_details: { cached_tokens: 5 },
    completion_tokens_details: { reasoning_tokens: 7 }
  }), {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    reasoningTokens: 7
  });
});

test("handles missing usage", () => {
  assert.deepEqual(normalizeUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  });
});
