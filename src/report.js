#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createUsageDb, defaultDbPath, expandPath } from "./db.js";
import { formatMarkdownReport, formatTextReport, parseSince, summarizeRows } from "./reportCore.js";

export function parseArgs(argv) {
  const args = {
    db: defaultDbPath(),
    since: "24h",
    from: null,
    to: new Date().toISOString(),
    session: null,
    timezone: "UTC",
    format: "text",
    top: 10,
    includeAnomalies: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--include-anomalies") {
      args.includeAnomalies = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    index += 1;
    if (key === "db") args.db = value;
    else if (key === "since") args.since = value;
    else if (key === "from") args.from = value;
    else if (key === "to") args.to = value;
    else if (key === "session") args.session = value;
    else if (key === "timezone") args.timezone = value;
    else if (key === "format") args.format = value;
    else if (key === "top") args.top = Number(value) || 10;
  }

  if (!args.from && args.since) args.from = parseSince(args.since);
  return args;
}

export function buildWhere(args) {
  const clauses = [];
  const params = {};
  if (args.from) {
    clauses.push("created_at >= @from");
    params.from = args.from;
  }
  if (args.to) {
    clauses.push("created_at <= @to");
    params.to = args.to;
  }
  if (args.session) {
    clauses.push("(session_key = @session OR session_id = @session)");
    params.session = args.session;
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

export async function runReport(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const db = createUsageDb(expandPath(args.db));
  const { where, params } = buildWhere(args);
  const rows = await db.query(`SELECT * FROM usage_events ${where} ORDER BY created_at ASC`, params);
  await db.close();
  const summary = summarizeRows(rows);
  const callRows = args.session ? rows : [];

  if (args.format === "json") {
    return JSON.stringify({
      period: { from: args.from, to: args.to, timezone: args.timezone },
      ...summary,
      ...(args.session ? { calls: callRows.map(toCallSummary) } : {})
    }, null, 2);
  }
  if (args.format === "markdown") {
    return formatMarkdownReport(summary, { ...args, callRows });
  }
  return formatTextReport(summary, { ...args, callRows });
}

function toCallSummary(row) {
  const toolNames = parseToolNames(row.tool_names_json);
  return {
    id: row.id ?? null,
    createdAt: row.created_at ?? null,
    provider: row.provider ?? "unknown",
    model: row.model ?? "unknown",
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    cacheReadTokens: Number(row.cache_read_tokens) || 0,
    cacheWriteTokens: Number(row.cache_write_tokens) || 0,
    totalTokens: Number(row.total_tokens) || 0,
    estimatedCostUsd: Number(row.estimated_cost_usd) || 0,
    toolCallCount: Number(row.tool_call_count) || 0,
    toolNames,
    status: row.status ?? null
  };
}

function parseToolNames(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  } catch {
    return [];
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runReport()
    .then((output) => {
      console.log(output);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
