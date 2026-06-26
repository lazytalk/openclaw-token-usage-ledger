import { normalizeChannelName } from "./normalizeChannel.js";

export function parseSince(value, now = new Date()) {
  if (!value) return null;
  const match = /^(\d+)([mhdw])$/.exec(value);
  if (!match) throw new Error(`Unsupported --since value: ${value}`);
  const amount = Number(match[1]);
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  return new Date(now.getTime() - amount * unitMs).toISOString();
}

export function summarizeRows(rows) {
  const totals = emptyTotals();
  const groups = {
    user: new Map(),
    model: new Map(),
    source: new Map(),
    channel: new Map(),
    hour: new Map(),
    session: new Map()
  };
  const anomalies = {
    highestSingleCall: null,
    mostExpensiveCall: null,
    highestOutputTokens: null,
    slowestSuccessfulCall: null,
    mostActiveSession: null,
    failedCalls: []
  };
  const sessions = new Map();

  for (const row of rows) {
    addTotals(totals, row);
    addToGroup(groups.user, userKey(row), row);
    addToGroup(groups.model, `${row.provider ?? "unknown"}:${row.model ?? "unknown"}`, row);
    addToGroup(groups.source, row.call_source ?? "unknown", row);
    const normalizedChannel = normalizeChannelName(row.channel_name) ?? row.channel_name;
    addToGroup(groups.channel, normalizedChannel ?? row.platform ?? "unknown", row);
    addToGroup(groups.hour, hourKey(row.created_at), row);
    addToSessionGroup(groups.session, row);

    if (row.session_key) sessions.set(row.session_key, (sessions.get(row.session_key) ?? 0) + 1);
    if (!anomalies.highestSingleCall || numeric(row.total_tokens) > numeric(anomalies.highestSingleCall.total_tokens)) {
      anomalies.highestSingleCall = row;
    }
    if (!anomalies.mostExpensiveCall || numeric(row.estimated_cost_usd) > numeric(anomalies.mostExpensiveCall.estimated_cost_usd)) {
      anomalies.mostExpensiveCall = row;
    }
    if (!anomalies.highestOutputTokens || numeric(row.output_tokens) > numeric(anomalies.highestOutputTokens.output_tokens)) {
      anomalies.highestOutputTokens = row;
    }
    if (row.status === "success" && (!anomalies.slowestSuccessfulCall || numeric(row.duration_ms) > numeric(anomalies.slowestSuccessfulCall.duration_ms))) {
      anomalies.slowestSuccessfulCall = row;
    }
    if (row.status && row.status !== "success" && row.status !== "no-usage") anomalies.failedCalls.push(row);
  }

  for (const [sessionKey, calls] of sessions) {
    if (!anomalies.mostActiveSession || calls > anomalies.mostActiveSession.calls) {
      anomalies.mostActiveSession = { sessionKey, calls };
    }
  }

  return {
    totals,
    groups: {
      user: sortedGroup(groups.user),
      model: sortedGroup(groups.model),
      source: sortedGroup(groups.source),
      channel: sortedGroup(groups.channel),
      hour: sortedGroup(groups.hour),
      session: sortedSessionGroup(groups.session)
    },
    anomalies
  };
}

export function formatTextReport(summary, { from, to, timezone = "UTC", top = 10, callRows = [] } = {}) {
  const lines = [
    "Daily Token Usage Report",
    `Period: ${from ?? "beginning"} to ${to ?? "now"} ${timezone}`,
    "",
    "Total",
    `- Total tokens: ${formatToken(summary.totals.totalTokens)}`,
    `- Input tokens: ${formatToken(summary.totals.inputTokens)}`,
    `- Output tokens: ${formatToken(summary.totals.outputTokens)}`,
    `- Cache tokens (read+write): ${formatToken(summary.totals.cacheReadTokens + summary.totals.cacheWriteTokens)}`,
    `- Cache read tokens: ${formatToken(summary.totals.cacheReadTokens)}`,
    `- Cache write tokens: ${formatToken(summary.totals.cacheWriteTokens)}`,
    `- Reasoning tokens: ${formatToken(summary.totals.reasoningTokens)}`,
    `- Estimated cost: $${summary.totals.estimatedCostUsd.toFixed(6)}`,
    `- Model calls: ${formatNumber(summary.totals.calls)}`,
    `- Failed calls: ${formatNumber(summary.totals.failedCalls)}`,
    `- Average latency: ${formatNumber(Math.round(summary.totals.averageLatencyMs))} ms`,
    ""
  ];

  appendGroup(lines, "By user", summary.groups.user, top);
  appendGroup(lines, "By model", summary.groups.model, top);
  appendGroup(lines, "By source", summary.groups.source, top);
  appendGroup(lines, "By channel", summary.groups.channel, top);
  appendSessionGroup(lines, "By session", summary.groups.session, top);
  appendCallBreakdown(lines, "Session calls", callRows);
  appendAnomalies(lines, summary.anomalies);
  return lines.join("\n");
}

export function formatMarkdownReport(summary, options = {}) {
  return formatTextReport(summary, options).replace(/^Daily Token Usage Report$/m, "# Daily Token Usage Report");
}

function appendGroup(lines, title, rows, top) {
  lines.push(title);
  for (const [index, row] of rows.slice(0, top).entries()) {
    lines.push(
      `${index + 1}. ${row.key} / total ${formatToken(row.totalTokens)} tokens (input ${formatToken(row.inputTokens)} / output ${formatToken(row.outputTokens)} / cache ${formatToken(row.cacheTokens)}) / $${row.estimatedCostUsd.toFixed(6)} / ${formatNumber(row.calls)} calls`
    );
  }
  if (!rows.length) lines.push("- none");
  lines.push("");
}

function appendAnomalies(lines, anomalies) {
  lines.push("Anomalies");
  lines.push(`- Highest single call: ${describeCall(anomalies.highestSingleCall)}`);
  lines.push(`- Most expensive call: ${describeCall(anomalies.mostExpensiveCall)}`);
  lines.push(`- Highest output tokens: ${describeCall(anomalies.highestOutputTokens, "output_tokens")}`);
  lines.push(`- Slowest successful call: ${describeCall(anomalies.slowestSuccessfulCall, "duration_ms")}`);
  lines.push(`- Most active session: ${anomalies.mostActiveSession ? `${anomalies.mostActiveSession.sessionKey} (${anomalies.mostActiveSession.calls} calls)` : "none"}`);
  lines.push(`- Failed calls: ${anomalies.failedCalls.length}`);
}

function appendSessionGroup(lines, title, rows, top) {
  lines.push(title);
  for (const [index, row] of rows.slice(0, top).entries()) {
    lines.push(
      `${index + 1}. ${row.key} / total ${formatToken(row.totalTokens)} tokens (input ${formatToken(row.inputTokens)} / output ${formatToken(row.outputTokens)} / cache ${formatToken(row.cacheTokens)}) / $${row.estimatedCostUsd.toFixed(6)} / ${formatNumber(row.calls)} calls`
    );
    for (const model of row.models.slice(0, top)) {
      lines.push(
        `   - ${model.key}: total ${formatToken(model.totalTokens)} (input ${formatToken(model.inputTokens)} / output ${formatToken(model.outputTokens)} / cache ${formatToken(model.cacheTokens)}) / $${model.estimatedCostUsd.toFixed(6)} / ${formatNumber(model.calls)} calls`
      );
    }
  }
  if (!rows.length) lines.push("- none");
  lines.push("");
}

function appendCallBreakdown(lines, title, rows) {
  if (!rows.length) return;
  lines.push(title);
  for (const [index, row] of rows.entries()) {
    const modelKey = `${row.provider ?? "unknown"}:${row.model ?? "unknown"}`;
    const cacheTokens = numeric(row.cache_read_tokens) + numeric(row.cache_write_tokens);
    const tools = describeTools(row);
    lines.push(
      `${index + 1}. ${row.created_at ?? "unknown"} / ${modelKey} / total ${formatToken(row.total_tokens)} (input ${formatToken(row.input_tokens)} / output ${formatToken(row.output_tokens)} / cache ${formatToken(cacheTokens)}) / $${numeric(row.estimated_cost_usd).toFixed(6)} / ${row.status ?? "unknown"} / tools: ${tools}`
    );
  }
  lines.push("");
}

function describeTools(row) {
  const names = parseToolNames(row.tool_names_json);
  if (names.length) return names.join(", ");
  const count = numeric(row.tool_call_count);
  if (count > 0) return `${formatNumber(count)} call(s)`;
  return "none";
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

function describeCall(row, metric = "total_tokens") {
  if (!row) return "none";
  return `${row.provider ?? "unknown"}:${row.model ?? "unknown"} ${formatMetric(metric, numeric(row[metric]))}`;
}

function emptyTotals() {
  return {
    calls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    latencyTotalMs: 0,
    latencyCount: 0,
    averageLatencyMs: 0
  };
}

function addTotals(totals, row) {
  totals.calls += 1;
  if (row.status && row.status !== "success" && row.status !== "no-usage") totals.failedCalls += 1;
  totals.inputTokens += numeric(row.input_tokens);
  totals.outputTokens += numeric(row.output_tokens);
  totals.totalTokens += numeric(row.total_tokens);
  totals.cacheReadTokens += numeric(row.cache_read_tokens);
  totals.cacheWriteTokens += numeric(row.cache_write_tokens);
  totals.reasoningTokens += numeric(row.reasoning_tokens);
  totals.estimatedCostUsd += numeric(row.estimated_cost_usd);
  if (row.duration_ms != null) {
    totals.latencyTotalMs += numeric(row.duration_ms);
    totals.latencyCount += 1;
    totals.averageLatencyMs = totals.latencyTotalMs / totals.latencyCount;
  }
}

function addToGroup(map, key, row) {
  const current = map.get(key) ?? {
    key,
    calls: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    estimatedCostUsd: 0
  };
  current.calls += 1;
  current.totalTokens += numeric(row.total_tokens);
  current.inputTokens += numeric(row.input_tokens);
  current.outputTokens += numeric(row.output_tokens);
  current.cacheTokens += numeric(row.cache_read_tokens) + numeric(row.cache_write_tokens);
  current.estimatedCostUsd += numeric(row.estimated_cost_usd);
  map.set(key, current);
}

function sortedGroup(map) {
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);
}

function sortedSessionGroup(map) {
  return [...map.values()]
    .map((session) => ({
      ...session,
      models: sortedGroup(session.models)
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);
}

function addToSessionGroup(map, row) {
  const key = sessionKey(row);
  const current = map.get(key) ?? {
    key,
    calls: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    estimatedCostUsd: 0,
    models: new Map()
  };

  current.calls += 1;
  current.totalTokens += numeric(row.total_tokens);
  current.inputTokens += numeric(row.input_tokens);
  current.outputTokens += numeric(row.output_tokens);
  current.cacheTokens += numeric(row.cache_read_tokens) + numeric(row.cache_write_tokens);
  current.estimatedCostUsd += numeric(row.estimated_cost_usd);

  addToGroup(current.models, `${row.provider ?? "unknown"}:${row.model ?? "unknown"}`, row);
  map.set(key, current);
}

function userKey(row) {
  return [
    row.platform_user_display_name,
    row.platform_user_id,
    row.platform
  ].filter(Boolean).join(" / ") || "unknown";
}

function hourKey(value) {
  if (!value) return "unknown";
  return String(value).slice(0, 13) + ":00";
}

function sessionKey(row) {
  return row.session_key ?? row.session_id ?? "unknown";
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatToken(value) {
  return formatNumber(Math.round(numeric(value)));
}

function formatMetric(metric, value) {
  if (metric === "duration_ms") return `${formatNumber(Math.round(value))} ms`;
  return formatToken(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}
