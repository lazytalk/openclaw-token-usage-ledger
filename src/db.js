import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { createSchemaSql, usageEventsColumns } from "./schema.js";

const require = createRequire(import.meta.url);

export function defaultDbPath() {
  return resolve(homedir(), ".openclaw-ops", "plugins", "token-usage-ledger", "usage.sqlite");
}

export function expandPath(path = defaultDbPath()) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function createUsageDb(path) {
  const dbPath = expandPath(path ?? defaultDbPath());
  let db;
  let insertStatement;

  function open() {
    if (db) return db;
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = require("better-sqlite3");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.exec(createSchemaSql);
    const columns = usageEventsColumns.join(", ");
    const values = usageEventsColumns.map((column) => `@${column}`).join(", ");
    insertStatement = db.prepare(`INSERT OR IGNORE INTO usage_events (${columns}) VALUES (${values})`);
    return db;
  }

  return {
    path: dbPath,
    insertUsageEvent(row) {
      open();
      const normalized = {};
      for (const column of usageEventsColumns) normalized[column] = row[column] ?? null;
      normalized.created_at ||= new Date().toISOString();
      normalized.input_tokens ??= 0;
      normalized.output_tokens ??= 0;
      normalized.total_tokens ??= 0;
      normalized.cache_read_tokens ??= 0;
      normalized.cache_write_tokens ??= 0;
      normalized.reasoning_tokens ??= 0;
      normalized.estimated_cost_usd ??= 0;
      normalized.input_cost_usd ??= 0;
      normalized.output_cost_usd ??= 0;
      normalized.cache_cost_usd ??= 0;
      normalized.had_tool_calls = normalized.had_tool_calls ? 1 : 0;
      normalized.tool_call_count ??= 0;
      normalized.retry_count ??= 0;
      insertStatement.run(normalized);
    },
    query(sql, params = {}) {
      return open().prepare(sql).all(params);
    },
    get(sql, params = {}) {
      return open().prepare(sql).get(params);
    },
    close() {
      if (db) db.close();
      db = null;
      insertStatement = null;
    }
  };
}

export function buildEventId(event = {}, ctx = {}) {
  const explicit = event.id ?? event.usageEventId;
  if (explicit) return String(explicit);
  const stableParts = [
    event.providerRequestId,
    event.upstreamRequestIdHash,
    event.callId,
    ctx.sessionKey ?? event.sessionKey,
    ctx.runId ?? event.runId,
    ctx.turnId ?? event.turnId,
    event.provider ?? ctx.provider,
    event.model ?? ctx.model,
    event.requestIdHash ?? event.requestId,
    event.startedAt ?? ctx.startedAt
  ];
  return createHash("sha256")
    .update(stableParts.map((part) => part ?? "").join("|"))
    .digest("hex")
    .slice(0, 32);
}
