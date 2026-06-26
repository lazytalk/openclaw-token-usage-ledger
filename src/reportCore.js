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
    hour: new Map()
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
    addToGroup(groups.channel, row.channel_name ?? row.platform ?? "unknown", row);
    addToGroup(groups.hour, hourKey(row.created_at), row);

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
    if (row.status && row.status !== "success") anomalies.failedCalls.push(row);
  }

  for (const [sessionKey, calls] of sessions) {
    if (!anomalies.mostActiveSession || calls > anomalies.mostActiveSession.calls) {
      anomalies.mostActiveSession = { sessionKey, calls };
    }
  }

  return {
    totals,
    groups: Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, sortedGroup(value)])),
    anomalies
  };
}

export function formatTextReport(summary, { from, to, timezone = "UTC", top = 10 } = {}) {
  const lines = [
    "Daily Token Usage Report",
    `Period: ${from ?? "beginning"} to ${to ?? "now"} ${timezone}`,
    "",
    "Total",
    `- Total tokens: ${summary.totals.totalTokens}`,
    `- Input tokens: ${summary.totals.inputTokens}`,
    `- Output tokens: ${summary.totals.outputTokens}`,
    `- Cache read tokens: ${summary.totals.cacheReadTokens}`,
    `- Cache write tokens: ${summary.totals.cacheWriteTokens}`,
    `- Reasoning tokens: ${summary.totals.reasoningTokens}`,
    `- Estimated cost: $${summary.totals.estimatedCostUsd.toFixed(6)}`,
    `- Model calls: ${summary.totals.calls}`,
    `- Failed calls: ${summary.totals.failedCalls}`,
    `- Average latency: ${Math.round(summary.totals.averageLatencyMs)} ms`,
    ""
  ];

  appendGroup(lines, "By user", summary.groups.user, top);
  appendGroup(lines, "By model", summary.groups.model, top);
  appendGroup(lines, "By source", summary.groups.source, top);
  appendGroup(lines, "By channel", summary.groups.channel, top);
  appendAnomalies(lines, summary.anomalies);
  return lines.join("\n");
}

export function formatMarkdownReport(summary, options = {}) {
  return formatTextReport(summary, options).replace(/^Daily Token Usage Report$/m, "# Daily Token Usage Report");
}

function appendGroup(lines, title, rows, top) {
  lines.push(title);
  for (const [index, row] of rows.slice(0, top).entries()) {
    lines.push(`${index + 1}. ${row.key} / ${row.totalTokens} tokens / $${row.estimatedCostUsd.toFixed(6)} / ${row.calls} calls`);
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

function describeCall(row, metric = "total_tokens") {
  if (!row) return "none";
  return `${row.provider ?? "unknown"}:${row.model ?? "unknown"} ${numeric(row[metric])}`;
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
  if (row.status && row.status !== "success") totals.failedCalls += 1;
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

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
