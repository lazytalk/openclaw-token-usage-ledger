import assert from "node:assert/strict";
import test from "node:test";
import { createTokenUsageLedgerPlugin } from "../src/plugin.js";

test("registers OpenClaw 2026.6.1 hooks through registerHook", () => {
  const registered = [];
  const plugin = createTokenUsageLedgerPlugin();

  plugin.register({
    pluginConfig: { dbPath: ":memory:" },
    registerHook(name, handler) {
      registered.push({ name, handler });
    },
    logger: { warn() {} }
  });

  assert.deepEqual(registered.map((entry) => entry.name), [
    "model_call_started",
    "model_call_ended",
    "llm_output"
  ]);
});
