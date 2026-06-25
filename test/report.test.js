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
