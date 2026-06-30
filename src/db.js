import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import initSqlJs from "sql.js";
import { createSchemaSql, usageEventsColumns } from "./schema.js";

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({
  locateFile(file) {
    return require.resolve(`sql.js/dist/${file}`);
  }
});

export function defaultDbPath() {
  return resolve(homedir(), ".openclaw", "plugins", "token-usage-ledger", "usage.sqlite");
}

export function expandPath(path = defaultDbPath()) {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

export function createUsageDb(path) {
  const dbPath = expandPath(path ?? defaultDbPath());
  let db;

  function toSqlJsNamedParams(params = {}) {
    const mapped = {};
    for (const [key, value] of Object.entries(params)) {
      mapped[key] = value;
      mapped[`@${key}`] = value;
      mapped[`:${key}`] = value;
      mapped[`$${key}`] = value;
    }
    return mapped;
  }

  function sqlRun(sql, params = {}) {
    const statement = db.prepare(sql);
    try {
      statement.run(toSqlJsNamedParams(params));
    } finally {
      statement.free();
    }
  }

  function sqlAll(sql, params = {}) {
    const statement = db.prepare(sql);
    try {
      statement.bind(toSqlJsNamedParams(params));
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  function persist() {
    const tempPath = `${dbPath}.tmp`;
    const bytes = db.export();
    writeFileSync(tempPath, Buffer.from(bytes));
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
    renameSync(tempPath, dbPath);
  }

  function open() {
    if (db) return db;
    mkdirSync(dirname(dbPath), { recursive: true });
    const bytes = existsSync(dbPath) ? readFileSync(dbPath) : null;
    db = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
    db.exec(createSchemaSql);
    const migrated = ensureSchemaMigrations(db, sqlAll);
    if (migrated || !bytes || !bytes.length) {
      persist();
    }
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
      sqlRun(buildUsageUpsertSql(), normalized);
      persist();
    },
    enqueueMirrorEvent(row) {
      open();
      const now = new Date().toISOString();
      const id = row?.id;
      if (!id) return;
      sqlRun(`
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
      `, {
        id,
        payload_json: JSON.stringify(row),
        now
      });
      persist();
    },
    listPendingMirrorEvents(limit = 50) {
      open();
      const safeLimit = Number(limit) > 0 ? Math.min(Number(limit), 500) : 50;
      const now = new Date().toISOString();
      const rows = sqlAll(`
        SELECT id, payload_json, attempt_count
        FROM mirror_outbox
        WHERE synced_at IS NULL
          AND (
            next_retry_at IS NULL
            OR next_retry_at <= @now
          )
        ORDER BY updated_at ASC
        LIMIT @limit
      `, { now, limit: safeLimit });
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
      sqlRun(`
        UPDATE mirror_outbox
        SET
          synced_at = @now,
          last_error = NULL,
          updated_at = @now
        WHERE id = @id
      `, { id, now });
      persist();
    },
    markMirrorEventFailed(id, nextRetryAt, errorMessage = null) {
      open();
      if (!id || !nextRetryAt) return;
      const now = new Date().toISOString();
      sqlRun(`
        UPDATE mirror_outbox
        SET
          attempt_count = attempt_count + 1,
          last_attempt_at = @now,
          next_retry_at = @next_retry_at,
          last_error = @last_error,
          updated_at = @now
        WHERE id = @id
      `, {
        id,
        now,
        next_retry_at: nextRetryAt,
        last_error: errorMessage
      });
      persist();
    },
    query(sql, params = {}) {
      open();
      return sqlAll(sql, params);
    },
    get(sql, params = {}) {
      const rows = this.query(sql, params);
      return rows[0] ?? null;
    },
    close() {
      if (db) db.close();
      db = null;
    }
  };
}

function ensureSchemaMigrations(db, sqlAll) {
  let changed = false;
  const columns = new Set(sqlAll("PRAGMA table_info(usage_events)").map((row) => row.name));

  if (!columns.has("machine_identity")) {
    db.exec("ALTER TABLE usage_events ADD COLUMN machine_identity TEXT");
    changed = true;
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
  return changed;
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
      WHERE
        CASE
          WHEN excluded.status = 'success' THEN 2
          WHEN excluded.status = 'error' THEN 1
          WHEN excluded.status IS NOT NULL AND excluded.status <> '' THEN 1
          ELSE 0
        END
        >=
        CASE
          WHEN usage_events.status = 'success' THEN 2
          WHEN usage_events.status = 'error' THEN 1
          WHEN usage_events.status IS NOT NULL AND usage_events.status <> '' THEN 1
          ELSE 0
        END
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
