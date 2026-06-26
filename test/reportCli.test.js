import assert from "node:assert/strict";
import test from "node:test";
import { buildWhere, parseArgs } from "../src/report.js";

test("parses --session argument", () => {
  const args = parseArgs(["--session", "session-a", "--from", "2026-06-25T00:00:00.000Z", "--to", "2026-06-26T00:00:00.000Z"]);
  assert.equal(args.session, "session-a");
});

test("buildWhere includes session key/id filter", () => {
  const { where, params } = buildWhere({
    from: "2026-06-25T00:00:00.000Z",
    to: "2026-06-26T00:00:00.000Z",
    session: "session-a"
  });

  assert.match(where, /created_at >= @from/);
  assert.match(where, /created_at <= @to/);
  assert.match(where, /\(session_key = @session OR session_id = @session\)/);
  assert.equal(params.session, "session-a");
});
