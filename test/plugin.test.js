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
    "message_received",
    "model_call_started",
    "model_call_ended",
    "llm_output"
  ]);
});

test("records a TUI model call with agent and source metadata", async () => {
  const handlers = {};
  const recordedRows = [];
  const plugin = createTokenUsageLedgerPlugin({
    createDb() {
      return {
        query() { return []; },
        insertUsageEvent(row) {
          recordedRows.push(row);
        }
      };
    }
  });

  plugin.register({
    pluginConfig: { dbPath: ":memory:" },
    registerHook(name, handler) {
      handlers[name] = handler;
    },
    logger: { warn() {} }
  });

  const context = {
    sessionKey: "agent:main:tui-123",
    agentId: "main",
    runtimeId: "tui-123",
    provider: "bailian-token-plan",
    model: "deepseek-v4-flash"
  };

  handlers.model_call_started({ callId: "call-1", ...context }, context);
  await handlers.llm_output(
    {
      callId: "call-1",
      ...context,
      usage: { input: 41, output: 2, total: 43 }
    },
    context
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];

  assert.equal(row.agent_id, "main");
  assert.equal(row.platform, "openclaw");
  assert.equal(row.channel_name, "tui");
  assert.equal(row.call_source, "tui");
  assert.equal(row.input_tokens, 41);
  assert.equal(row.output_tokens, 2);
  assert.equal(row.total_tokens, 43);
  assert.equal(row.provider, "bailian-token-plan");
  assert.equal(row.model, "deepseek-v4-flash");
  assert.equal(row.session_key, "agent:main:tui-123");
  assert.equal(row.raw_usage_json, JSON.stringify({ input: 41, output: 2, total: 43 }));
});

test("canonicalizes channel aliases like openclaw-weixin to wechat", async () => {  const handlers = {};
  const recordedRows = [];
  const plugin = createTokenUsageLedgerPlugin({
    createDb() {
      return {
        query() { return []; },
        insertUsageEvent(row) {
          recordedRows.push(row);
        }
      };
    }
  });

  plugin.register({
    pluginConfig: { dbPath: ":memory:" },
    registerHook(name, handler) {
      handlers[name] = handler;
    },
    logger: { warn() {} }
  });

  const context = {
    sessionKey: "agent:main:wx-123",
    messageProvider: "openclaw-weixin",
    provider: "kwevllm",
    model: "qwen"
  };

  await handlers.llm_output(
    {
      callId: "call-2",
      usage: { input: 10, output: 2, total: 12 }
    },
    context
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.channel_name, "wechat");
  const metadata = JSON.parse(row.metadata_json);
  assert.equal(metadata.rawChannelName, "openclaw-weixin");
  assert.equal(metadata.normalizedChannelName, "wechat");
});

test("resolves display name from message_received metadata senderName", async () => {
  const handlers = {};
  const recordedRows = [];
  const plugin = createTokenUsageLedgerPlugin({
    createDb() {
      return {
        query() { return []; },
        insertUsageEvent(row) { recordedRows.push(row); }
      };
    }
  });

  plugin.register({
    pluginConfig: { dbPath: ":memory:" },
    registerHook(name, handler) { handlers[name] = handler; },
    logger: { warn() {} }
  });

  await handlers.message_received(
    {
      sessionKey: "agent:main:wx-123",
      metadata: {
        senderName: "Henry Wang",
        senderId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU"
      }
    },
    {
      sessionKey: "agent:main:wx-123"
    }
  );

  await handlers.llm_output(
    { usage: { input: 5, output: 2, total: 7 } },
    {
      sessionKey: "agent:main:wx-123",
      channelId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat",
      provider: "openai",
      model: "gpt-4.1"
    }
  );

  assert.equal(recordedRows.length, 1);
  assert.equal(recordedRows[0].platform_user_id, "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU");
  assert.equal(recordedRows[0].platform_user_display_name, "Henry Wang");
});
