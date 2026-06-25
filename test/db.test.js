import assert from "node:assert/strict";
import test from "node:test";
import { buildUsageUpsertSql } from "../src/db.js";

test("builds an UPSERT that prefers richer rows and leaves the primary key untouched", () => {
  const sql = buildUsageUpsertSql();

  assert.match(sql, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(sql, /WHERE eventRank\(excluded\.status\) >= eventRank\(usage_events\.status\)/);
  assert.doesNotMatch(sql, /\bid\s*=\s*excluded\.id\b/);
});