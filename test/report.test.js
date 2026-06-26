import assert from "node:assert/strict";
import test from "node:test";
import { formatMarkdownReport, summarizeRows } from "../src/reportCore.js";

test("summarizes totals and groups", () => {
  const summary = summarizeRows([
    {
      created_at: "2026-06-25T01:00:00Z",
      platform: "feishu",
      platform_user_id: "u1",
      platform_user_display_name: "Ada",
      provider: "openai",
      model: "gpt-4.1",
      call_source: "user_chat",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      estimated_cost_usd: 0.001,
      duration_ms: 1000,
      status: "success",
      session_key: "s1"
    },
    {
      created_at: "2026-06-25T02:00:00Z",
      platform: "feishu",
      platform_user_id: "u1",
      provider: "local",
      model: "qwen3",
      call_source: "cron_job",
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      status: "error",
      session_key: "s1"
    }
  ]);

  assert.equal(summary.totals.totalTokens, 180);
  assert.equal(summary.totals.failedCalls, 1);
  assert.equal(summary.groups.user[0].key, "Ada / u1 / feishu");
  assert.equal(summary.groups.source.length, 2);
});

test("renders markdown report", () => {
  const report = formatMarkdownReport(summarizeRows([]), { from: "a", to: "b", timezone: "UTC" });
  assert.match(report, /^# Daily Token Usage Report/);
  assert.match(report, /Total tokens: 0/);
});

test("renders highest output tokens using output_tokens", () => {
  const report = formatMarkdownReport(
    summarizeRows([
      {
        created_at: "2026-06-25T01:00:00Z",
        provider: "p1",
        model: "m1",
        input_tokens: 90,
        output_tokens: 10,
        total_tokens: 100,
        status: "success"
      },
      {
        created_at: "2026-06-25T02:00:00Z",
        provider: "p2",
        model: "m2",
        input_tokens: 100,
        output_tokens: 8,
        total_tokens: 108,
        status: "success"
      }
    ]),
    { from: "a", to: "b", timezone: "UTC" }
  );

  assert.match(report, /Highest output tokens: p1:m1 10/);
});
