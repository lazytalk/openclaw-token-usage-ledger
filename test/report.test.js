import assert from "node:assert/strict";
import test from "node:test";
import { formatMarkdownReport, parseSince, summarizeRows } from "../src/reportCore.js";

test("parses minute-based since windows", () => {
  const now = new Date("2026-06-26T00:10:00.000Z");
  const from = parseSince("10m", now);
  assert.equal(from, "2026-06-26T00:00:00.000Z");
});

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
  assert.match(report, /Input tokens: 0/);
  assert.match(report, /Output tokens: 0/);
  assert.match(report, /Cache tokens \(read\+write\): 0/);
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

test("formats token values with commas and shows group token categories", () => {
  const report = formatMarkdownReport(
    summarizeRows([
      {
        created_at: "2026-06-25T01:00:00Z",
        provider: "openai",
        model: "gpt-4.1",
        platform: "openclaw",
        call_source: "user_chat",
        input_tokens: 750000,
        output_tokens: 250000,
        cache_read_tokens: 100000,
        cache_write_tokens: 0,
        total_tokens: 1100000,
        status: "success"
      }
    ]),
    { from: "a", to: "b", timezone: "UTC" }
  );

  assert.match(report, /Total tokens: 1,100,000/);
  assert.match(report, /Input tokens: 750,000/);
  assert.match(report, /Output tokens: 250,000/);
  assert.match(report, /Cache tokens \(read\+write\): 100,000/);
  assert.match(report, /total 1,100,000 tokens \(input 750,000 \/ output 250,000 \/ cache 100,000\)/);
});

test("renders by session section with model drilldown", () => {
  const report = formatMarkdownReport(
    summarizeRows([
      {
        created_at: "2026-06-25T01:00:00Z",
        session_key: "session-a",
        provider: "openai",
        model: "gpt-4.1",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 0,
        total_tokens: 160,
        estimated_cost_usd: 0.001,
        status: "success"
      },
      {
        created_at: "2026-06-25T02:00:00Z",
        session_key: "session-a",
        provider: "anthropic",
        model: "claude-sonnet",
        input_tokens: 200,
        output_tokens: 100,
        cache_read_tokens: 40,
        cache_write_tokens: 0,
        total_tokens: 340,
        estimated_cost_usd: 0.002,
        status: "success"
      }
    ]),
    { from: "a", to: "b", timezone: "UTC" }
  );

  assert.match(report, /By session/);
  assert.match(report, /1\. session-a \/ total 500 tokens \(input 300 \/ output 150 \/ cache 50\)/);
  assert.match(report, /- anthropic:claude-sonnet: total 340 \(input 200 \/ output 100 \/ cache 40\)/);
  assert.match(report, /- openai:gpt-4.1: total 160 \(input 100 \/ output 50 \/ cache 10\)/);
});

test("renders per-call breakdown when call rows are provided", () => {
  const rows = [
    {
      created_at: "2026-06-25T01:00:00Z",
      provider: "openai",
      model: "gpt-4.1",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 0,
      total_tokens: 160,
      estimated_cost_usd: 0.001,
      status: "success"
    },
    {
      created_at: "2026-06-25T01:01:00Z",
      provider: "openai",
      model: "gpt-4.1",
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 20,
      cache_write_tokens: 0,
      total_tokens: 320,
      estimated_cost_usd: 0.002,
      status: "success"
    }
  ];

  const report = formatMarkdownReport(
    summarizeRows(rows),
    { from: "a", to: "b", timezone: "UTC", callRows: rows }
  );

  assert.match(report, /Session calls/);
  assert.match(report, /1\. 2026-06-25T01:00:00Z \/ openai:gpt-4.1 \/ total 160 \(input 100 \/ output 50 \/ cache 10\)/);
  assert.match(report, /2\. 2026-06-25T01:01:00Z \/ openai:gpt-4.1 \/ total 320 \(input 200 \/ output 100 \/ cache 20\)/);
});
