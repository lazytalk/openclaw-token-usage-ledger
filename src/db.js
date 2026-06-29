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
  let enqueueMirrorStatement;
  let listPendingMirrorStatement;
  let markMirrorSyncedStatement;
  let markMirrorFailedStatement;

  function open() {
    if (db) return db;
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = require("better-sqlite3");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.function("eventRank", (status) => {
      if (status === "success") return 2;
      if (status === "error") return 1;
      if (status) return 1;
      return 0;
    });
    db.exec(createSchemaSql);
    ensureSchemaMigrations(db);
    insertStatement = db.prepare(buildUsageUpsertSql());
    enqueueMirrorStatement = db.prepare(`
      INSERT INTO mirror_outbox (
        id,
        payload_json,
        attempt_count,
        last_attempt_at,
        next_retry_at,
        last_error,
        synced_at,
        created_at,
        updated_at
      )
      VALUES (
        @id,
        @payload_json,
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        @now,
        @now
      )
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    listPendingMirrorStatement = db.prepare(`
      SELECT id, payload_json, attempt_count
      FROM mirror_outbox
      WHERE synced_at IS NULL
        AND (
          next_retry_at IS NULL
          OR next_retry_at <= @now
        )
      ORDER BY updated_at ASC
      LIMIT @limit
    `);
    markMirrorSyncedStatement = db.prepare(`
      UPDATE mirror_outbox
      SET
        synced_at = @now,
        last_error = NULL,
        updated_at = @now
      WHERE id = @id
    `);
    markMirrorFailedStatement = db.prepare(`
      UPDATE mirror_outbox
      SET
        attempt_count = attempt_count + 1,
        last_attempt_at = @now,
        next_retry_at = @next_retry_at,
        last_error = @last_error,
        updated_at = @now
      WHERE id = @id
    `);
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
    enqueueMirrorEvent(row) {
      open();
      const now = new Date().toISOString();
      const id = row?.id;
      if (!id) return;
      enqueueMirrorStatement.run({
        id,
        payload_json: JSON.stringify(row),
        now
      });
    },
    listPendingMirrorEvents(limit = 50) {
      open();
      const safeLimit = Number(limit) > 0 ? Math.min(Number(limit), 500) : 50;
      const now = new Date().toISOString();
      const rows = listPendingMirrorStatement.all({ now, limit: safeLimit });
      return rows.map((row) => {
        try {
          return {
            id: row.id,
            attemptCount: Number(row.attempt_count) || 0,
            payload: JSON.parse(row.payload_json)
          };
        } catch {
          return {
            id: row.id,
            attemptCount: Number(row.attempt_count) || 0,
            payload: null
          };
        }
      });
    },
    markMirrorEventSynced(id) {
      open();
      if (!id) return;
      const now = new Date().toISOString();
      markMirrorSyncedStatement.run({ id, now });
    },
    markMirrorEventFailed(id, nextRetryAt, errorMessage = null) {
      open();
      if (!id || !nextRetryAt) return;
      const now = new Date().toISOString();
      markMirrorFailedStatement.run({
        id,
        now,
        next_retry_at: nextRetryAt,
        last_error: errorMessage
      });
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
      enqueueMirrorStatement = null;
      listPendingMirrorStatement = null;
      markMirrorSyncedStatement = null;
      markMirrorFailedStatement = null;
    }
  };
}

function ensureSchemaMigrations(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(usage_events)").all().map((row) => row.name)
  );

  if (!columns.has("machine_identity")) {
    db.exec("ALTER TABLE usage_events ADD COLUMN machine_identity TEXT");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS mirror_outbox (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_retry_at TEXT,
      last_error TEXT,
      synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mirror_outbox_due
      ON mirror_outbox(synced_at, next_retry_at, updated_at);
  `);
}

export function buildUsageUpsertSql(columns = usageEventsColumns) {
  const columnList = columns.join(", ");
  const values = columns.map((column) => `@${column}`).join(", ");
  const updates = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");

  return `
      INSERT INTO usage_events (${columnList})
      VALUES (${values})
      ON CONFLICT(id) DO UPDATE SET
        ${updates}
      WHERE eventRank(excluded.status) >= eventRank(usage_events.status)
    `;
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
