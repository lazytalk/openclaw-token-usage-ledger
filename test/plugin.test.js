import assert from "node:assert/strict";
import test from "node:test";
import { createTokenUsageLedgerPlugin } from "../src/plugin.js";

test("registers OpenClaw 2026.6.1 hooks through registerHook", () => {
  const registered = [];
  const plugin = createTokenUsageLedgerPlugin({
    createDb() {
      return {
        query() { return []; },
        insertUsageEvent() {}
      };
    }
  });

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
    "after_tool_call",
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
    machineIdentity: "machine-01",
    gatewayProfile: "dev-gateway",
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
  assert.equal(row.platform, null);
  assert.equal(row.channel_name, null);
  assert.equal(row.call_source, "tui");
  assert.equal(row.input_tokens, 41);
  assert.equal(row.output_tokens, 2);
  assert.equal(row.total_tokens, 43);
  assert.equal(row.provider, "bailian-token-plan");
  assert.equal(row.model, "deepseek-v4-flash");
  assert.equal(row.agent_name, "main");
  assert.equal(row.runtime_id, "tui-123");
  assert.equal(row.gateway_profile, "dev-gateway");
  assert.equal(row.machine_identity, "machine-01");
  assert.equal(row.session_key, "agent:main:tui-123");
  assert.equal(row.request_id, "call-1");
  assert.equal(row.raw_usage_json, JSON.stringify({ input: 41, output: 2, total: 43 }));
});

test("derives agent_name from sessionKey when hook payload omits agent fields", async () => {
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

  await handlers.llm_output(
    {
      callId: "call-fallback-1",
      usage: { input: 8, output: 2, total: 10 },
      provider: "openai",
      model: "gpt-4.1"
    },
    {
      sessionKey: "agent:planner:tui-456"
    }
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.agent_id, "planner");
  assert.equal(row.agent_name, "planner");
  assert.equal(row.request_id, "call-fallback-1");
});

test("canonicalizes explicit event channelName aliases like openclaw-weixin to wechat", async () => {  const handlers = {};
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
    provider: "kwevllm",
    model: "qwen"
  };

  await handlers.llm_output(
    {
      callId: "call-2",
      channelName: "openclaw-weixin",
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
    {
      sessionKey: "agent:main:wx-123",
      channelId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat",
      usage: { input: 5, output: 2, total: 7 }
    },
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

test("caches message_received display name from context sessionKey", async () => {
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
      metadata: {
        senderName: "Context Henry",
        senderId: "ou_5483d4c149c7b1ef00ea7297d41256da"
      }
    },
    {
      sessionKey: "agent:main:feishu-context-123"
    }
  );

  await handlers.llm_output(
    {
      usage: { input: 5, output: 2, total: 7 }
    },
    {
      sessionKey: "agent:main:feishu-context-123",
      channelId: "ou_5483d4c149c7b1ef00ea7297d41256da",
      provider: "openai",
      model: "gpt-4.1"
    }
  );

  assert.equal(recordedRows.length, 1);
  assert.equal(recordedRows[0].platform_user_id, "ou_5483d4c149c7b1ef00ea7297d41256da");
  assert.equal(recordedRows[0].platform_user_display_name, "Context Henry");
});

test("caches message_received sender by runId when llm_output context is empty", async () => {
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
      sessionKey: "agent:main:feishu:direct:ou_5483d4c149c7b1ef00ea7297d41256da",
      runId: "run-feishu-1",
      senderId: "ou_5483d4c149c7b1ef00ea7297d41256da",
      metadata: {
        senderName: "Ning Ba",
        senderId: "ou_5483d4c149c7b1ef00ea7297d41256da"
      }
    },
    {}
  );

  await handlers.llm_output(
    {
      runId: "run-feishu-1",
      sessionId: "session-feishu-1",
      provider: "bailian-token-plan",
      model: "deepseek-v4-pro",
      usage: { input: 5, output: 2, total: 7 }
    },
    {}
  );

  assert.equal(recordedRows.length, 1);
  assert.equal(recordedRows[0].run_id, "run-feishu-1");
  assert.equal(recordedRows[0].session_id, "session-feishu-1");
  assert.equal(recordedRows[0].session_key, "agent:main:feishu:direct:ou_5483d4c149c7b1ef00ea7297d41256da");
  assert.equal(recordedRows[0].agent_id, "main");
  assert.equal(recordedRows[0].platform, "feishu");
  assert.equal(recordedRows[0].channel_name, "feishu");
  assert.equal(recordedRows[0].call_source, "user_chat");
  assert.equal(recordedRows[0].platform_user_id, "ou_5483d4c149c7b1ef00ea7297d41256da");
  assert.equal(recordedRows[0].platform_user_display_name, "Ning Ba");
});

test("claims pending message_received sender from following tool runId", async () => {
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
      sessionKey: "agent:main:feishu:direct:ou_5483d4c149c7b1ef00ea7297d41256da",
      runId: null,
      senderId: "ou_5483d4c149c7b1ef00ea7297d41256da",
      metadata: {
        senderName: "Ning Ba",
        senderId: "ou_5483d4c149c7b1ef00ea7297d41256da"
      }
    },
    {}
  );

  handlers.after_tool_call(
    {
      runId: "run-feishu-2",
      toolName: "read",
      toolCallId: "tool-call-1"
    },
    {}
  );

  await handlers.llm_output(
    {
      runId: "run-feishu-2",
      sessionId: "session-feishu-2",
      provider: "kwevllm",
      model: "/models/qwen3.6-35b-a3b-fp8",
      usage: { input: 5, output: 2, total: 7 }
    },
    {}
  );

  assert.equal(recordedRows.length, 1);
  assert.equal(recordedRows[0].run_id, "run-feishu-2");
  assert.equal(recordedRows[0].session_id, "session-feishu-2");
  assert.equal(recordedRows[0].session_key, "agent:main:feishu:direct:ou_5483d4c149c7b1ef00ea7297d41256da");
  assert.equal(recordedRows[0].agent_id, "main");
  assert.equal(recordedRows[0].platform, "feishu");
  assert.equal(recordedRows[0].channel_name, "feishu");
  assert.equal(recordedRows[0].call_source, "user_chat");
  assert.equal(recordedRows[0].platform_user_id, "ou_5483d4c149c7b1ef00ea7297d41256da");
  assert.equal(recordedRows[0].platform_user_display_name, "Ning Ba");
});

test("derives WeChat channel attribution from cached message_received sessionKey", async () => {
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
      sessionKey: "agent:main:openclaw-weixin:direct:o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat",
      runId: "run-wechat-1",
      metadata: {
        senderName: "Henry Wang",
        senderId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU"
      }
    },
    {}
  );

  await handlers.llm_output(
    {
      runId: "run-wechat-1",
      provider: "kwevllm",
      model: "qwen",
      usage: { input: 5, output: 2, total: 7 }
    },
    {}
  );

  assert.equal(recordedRows.length, 1);
  assert.equal(recordedRows[0].session_key, "agent:main:openclaw-weixin:direct:o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat");
  assert.equal(recordedRows[0].agent_id, "main");
  assert.equal(recordedRows[0].platform, "wechat");
  assert.equal(recordedRows[0].channel_name, "wechat");
  assert.equal(recordedRows[0].call_source, "user_chat");
  assert.equal(recordedRows[0].platform_user_id, "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU");
  assert.equal(recordedRows[0].platform_user_display_name, "Henry Wang");
});

test("derives tool names/count from strict OpenClaw lastAssistant tool blocks", async () => {
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

  await handlers.llm_output(
    {
      usage: { input: 15, output: 5, total: 20 },
      lastAssistant: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect the file." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
          { type: "tool_call", id: "call-2", toolName: "grep", arguments: { query: "TODO" } }
        ]
      }
    },
    {
      sessionKey: "agent:main:tui-tool-1",
      provider: "openai",
      model: "gpt-5.4"
    }
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.had_tool_calls, 1);
  assert.equal(row.tool_call_count, 2);
  assert.equal(row.tool_names_json, JSON.stringify(["read", "grep"]));
});

test("persists ordered tool list with duplicates from lastAssistant blocks", async () => {
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

  await handlers.llm_output(
    {
      usage: { input: 18, output: 6, total: 24 },
      lastAssistant: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "command1", arguments: {} },
          { type: "toolCall", id: "call-2", name: "command1", arguments: {} },
          { type: "tool_call", id: "call-3", toolName: "command2", arguments: {} }
        ]
      }
    },
    {
      sessionKey: "agent:main:tui-tool-ordered-1",
      provider: "openai",
      model: "gpt-5.4"
    }
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.had_tool_calls, 1);
  assert.equal(row.tool_call_count, 3);
  assert.equal(row.tool_names_json, JSON.stringify(["command1", "command1", "command2"]));
});

test("records tool calls via api.on single-argument dispatch (new SDK contract)", async () => {
  // New SDK: api.on calls handler(event) with context embedded at event.context.
  // registerHook must wrap the handler so ctx = event.context, not {}.
  const onHandlers = {};
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
    on(name, handler) {
      onHandlers[name] = handler;
    },
    logger: { warn() {} }
  });

  const runCtx = { runId: "run-on-1", sessionKey: "agent:main:tui-on-1" };

  // New SDK passes a single merged object; context is at event.context.
  onHandlers.after_tool_call({ toolName: "search", context: runCtx });
  onHandlers.after_tool_call({ toolName: "read_file", context: runCtx });

  await onHandlers.llm_output({
    usage: { input: 20, output: 5, total: 25 },
    provider: "openai",
    model: "gpt-5",
    context: runCtx
  });

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.had_tool_calls, 1);
  assert.equal(row.tool_call_count, 2);
  assert.equal(row.tool_names_json, JSON.stringify(["search", "read_file"]));
  assert.equal(row.run_id, "run-on-1");
});

test("merges after_tool_call events into llm_output record for the same run", async () => {
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

  handlers.after_tool_call(
    {
      runId: "run-merge-1",
      toolName: "read"
    },
    { runId: "run-merge-1" }
  );

  handlers.after_tool_call(
    {
      runId: "run-merge-1",
      toolName: "grep"
    },
    { runId: "run-merge-1" }
  );

  handlers.after_tool_call(
    {
      runId: "run-merge-1",
      toolName: "read_file"
    },
    { runId: "run-merge-1" }
  );

  await handlers.llm_output(
    {
      runId: "run-merge-1",
      usage: { input: 10, output: 3, total: 13 },
      provider: "openai",
      model: "gpt-5.4"
    },
    {
      runId: "run-merge-1",
      sessionKey: "agent:main:tui-tool-3"
    }
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.had_tool_calls, 1);
  assert.equal(row.tool_call_count, 3);
  assert.equal(row.tool_names_json, JSON.stringify(["read", "grep", "read_file"]));
});

test("extracts toolName from lastAssistant tool blocks", async () => {
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

  await handlers.llm_output(
    {
      usage: { input: 12, output: 4, total: 16 },
      lastAssistant: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", toolName: "search_web" }
        ]
      }
    },
    {
      sessionKey: "agent:main:tui-tool-4",
      provider: "openai",
      model: "gpt-5.4"
    }
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.had_tool_calls, 1);
  assert.equal(row.tool_call_count, 1);
  assert.equal(row.tool_names_json, JSON.stringify(["search_web"]));
});

test("ignores tool metadata outside event.lastAssistant for deterministic extraction", async () => {
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

  await handlers.llm_output(
    {
      usage: { input: 7, output: 3, total: 10 }
    },
    {
      sessionKey: "agent:main:tui-tool-2",
      provider: "openai",
      model: "gpt-5.4",
      toolMetas: [{ toolName: "read" }]
    }
  );

  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0];
  assert.equal(row.had_tool_calls, 0);
  assert.equal(row.tool_call_count, 0);
  assert.equal(row.tool_names_json, null);
});

test("mirrors recorded rows to central HTTP ingest when configured", async () => {
  const handlers = {};
  const recordedRows = [];
  const mirroredRequests = [];
  const plugin = createTokenUsageLedgerPlugin({
    createDb() {
      return {
        query() { return []; },
        insertUsageEvent(row) { recordedRows.push(row); }
      };
    },
    fetchImpl: async (url, options = {}) => {
      mirroredRequests.push({ url, options });
      return { ok: true, status: 200 };
    }
  });

  plugin.register({
    pluginConfig: {
      dbPath: ":memory:",
      mirror: {
        enabled: true,
        url: "http://usage-hub.local/api/v1/usage-events",
        apiKey: "hub-token",
        timeoutMs: 1000
      }
    },
    registerHook(name, handler) { handlers[name] = handler; },
    logger: { warn() {} }
  });

  await handlers.llm_output(
    {
      callId: "call-3",
      gatewayProfile: "central-gateway",
      machineIdentity: "host-a",
      usage: { input: 12, output: 4, total: 16 },
      provider: "openai",
      model: "gpt-4.1"
    },
    {
      sessionKey: "agent:main:tui-222",
      runtimeId: "tui-222",
      gatewayProfile: "central-gateway",
      machineIdentity: "host-a"
    }
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(recordedRows.length, 1);
  assert.equal(mirroredRequests.length, 1);
  assert.equal(mirroredRequests[0].url, "http://usage-hub.local/api/v1/usage-events");
  assert.equal(mirroredRequests[0].options.method, "POST");
  assert.equal(mirroredRequests[0].options.headers.authorization, "Bearer hub-token");

  const mirroredBody = JSON.parse(mirroredRequests[0].options.body);
  assert.equal(mirroredBody.gateway_profile, "central-gateway");
  assert.equal(mirroredBody.machine_identity, "host-a");
  assert.equal(mirroredBody.runtime_id, "tui-222");
  assert.equal(mirroredBody.total_tokens, 16);
});

test("retries mirror delivery from local outbox until success", async () => {
  const handlers = {};
  const recordedRows = [];
  const mirroredRequests = [];
  const queue = new Map();
  let attempt = 0;

  const plugin = createTokenUsageLedgerPlugin({
    createDb() {
      return {
        query() { return []; },
        insertUsageEvent(row) { recordedRows.push(row); },
        enqueueMirrorEvent(row) {
          queue.set(row.id, {
            id: row.id,
            payload: row,
            attemptCount: queue.get(row.id)?.attemptCount ?? 0,
            synced: false,
            nextRetryAt: null
          });
        },
        listPendingMirrorEvents(limit = 50) {
          const now = Date.now();
          return [...queue.values()]
            .filter((item) => !item.synced && (!item.nextRetryAt || item.nextRetryAt <= now))
            .slice(0, limit)
            .map((item) => ({
              id: item.id,
              payload: item.payload,
              attemptCount: item.attemptCount
            }));
        },
        markMirrorEventSynced(id) {
          const entry = queue.get(id);
          if (!entry) return;
          entry.synced = true;
          queue.set(id, entry);
        },
        markMirrorEventFailed(id, nextRetryAt) {
          const entry = queue.get(id);
          if (!entry) return;
          entry.attemptCount += 1;
          entry.nextRetryAt = Math.min(new Date(nextRetryAt).getTime(), Date.now() - 1);
          queue.set(id, entry);
        }
      };
    },
    fetchImpl: async (url, options = {}) => {
      mirroredRequests.push({ url, options });
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    }
  });

  plugin.register({
    pluginConfig: {
      dbPath: ":memory:",
      mirror: {
        enabled: true,
        url: "http://usage-hub.local/api/v1/usage-events",
        apiKey: "hub-token",
        timeoutMs: 1000,
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 1,
        retryIntervalMs: 1,
        maxBatchSize: 10
      }
    },
    registerHook(name, handler) { handlers[name] = handler; },
    logger: { warn() {} }
  });

  await handlers.llm_output(
    {
      callId: "call-retry-1",
      usage: { input: 9, output: 1, total: 10 },
      provider: "openai",
      model: "gpt-4.1"
    },
    {
      sessionKey: "agent:main:tui-retry-1",
      runtimeId: "tui-retry-1",
      gatewayProfile: "central-gateway",
      machineIdentity: "host-retry"
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 10));

  await handlers.llm_output(
    {
      callId: "call-retry-2",
      usage: { input: 4, output: 1, total: 5 },
      provider: "openai",
      model: "gpt-4.1"
    },
    {
      sessionKey: "agent:main:tui-retry-2",
      runtimeId: "tui-retry-2",
      gatewayProfile: "central-gateway",
      machineIdentity: "host-retry"
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 80));

  const firstEntry = queue.get(recordedRows[0].id);
  assert.equal(recordedRows.length, 2);
  assert.ok(firstEntry?.synced);
  assert.equal(mirroredRequests.length >= 2, true);
});
