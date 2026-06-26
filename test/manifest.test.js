import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package.json declares OpenClaw hooks and a semver floor", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.deepEqual(packageJson.openclaw.hooks, [
    "model_call_started",
    "model_call_ended",
    "llm_output"
  ]);
  assert.equal(packageJson.openclaw.install.minHostVersion, ">=2026.6.1");
});

test("openclaw.plugin.json declares required native manifest fields", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

  assert.equal(manifest.id, "token-usage-ledger");
  assert.deepEqual(manifest.configSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      dbPath: {
        type: "string",
        description: "Absolute path to the SQLite database file. Defaults to a file inside the plugin's data directory."
      }
    }
  });
});