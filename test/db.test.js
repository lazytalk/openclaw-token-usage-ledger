import assert from "node:assert/strict";
import test from "node:test";
import { buildUsageUpsertSql } from "../src/db.js";
import { createSchemaSql } from "../src/schema.js";

test("builds an UPSERT that prefers richer rows and leaves the primary key untouched", () => {
  const sql = buildUsageUpsertSql();

  assert.match(sql, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(sql, /WHERE eventRank\(excluded\.status\) >= eventRank\(usage_events\.status\)/);
  assert.doesNotMatch(sql, /\bid\s*=\s*excluded\.id\b/);
});

test("schema defines persistent mirror outbox for eventual sync", () => {
  assert.match(createSchemaSql, /CREATE TABLE IF NOT EXISTS mirror_outbox/);
  assert.match(createSchemaSql, /attempt_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(createSchemaSql, /next_retry_at TEXT/);
  assert.match(createSchemaSql, /synced_at TEXT/);
});