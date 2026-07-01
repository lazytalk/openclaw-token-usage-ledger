import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { buildEventId, createUsageDb, defaultDbPath } from "./db.js";
import { normalizeUsage } from "./normalizeUsage.js";
import { extractIdentity } from "./identity.js";
import { classifyCallSource } from "./classifySource.js";
import { calculateCost } from "./cost.js";
import { normalizeChannelName } from "./normalizeChannel.js";
import { createMirrorManager } from "./mirror.js";
import { extractToolSummary, extractToolSummaryFromAfterToolCall, mergeToolSummaries } from "./tools.js";

// Always write debug log to the plugin data dir; override with LEDGER_DEBUG_LOG env var.
const _defaultDebugLog = resolve(homedir(), ".openclaw", "plugins", "token-usage-ledger", "debug.jsonl");
const DEBUG_LOG = process.env.LEDGER_DEBUG_LOG ?? _defaultDebugLog;
function debugLog(obj) {
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true });
    appendFileSync(DEBUG_LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
}

const defaultConfig = {
  storeContent: false,
  storePreview: false,
  previewMaxChars: 120,
  hashContent: true,
  reportTimezone: "UTC",
  defaultCurrency: "USD",
  localModelsCostMode: "zero",
  debugRawUsage: true,
  pricing: {},
  mirror: {
    enabled: false,
    url: null,
    apiKey: null,
    timeoutMs: 5000,
    retryIntervalMs: 15000,
    retryBaseDelayMs: 2000,
    retryMaxDelayMs: 300000,
    maxBatchSize: 50
  }
};

export function createTokenUsageLedgerPlugin(options = {}) {
  const createDb = options.createDb ?? createUsageDb;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    id: "token-usage-ledger",
    name: "Token Usage Ledger",
    description: "Durable SQLite token accounting for OpenClaw model calls.",
    register(api = {}) {
      const config = { ...defaultConfig, ...(api.pluginConfig ?? api.config ?? {}) };
      const db = createDb(config.dbPath);
      const dbReady = Promise.resolve()
        .then(() => db.query("SELECT 1 AS ok"))
        .catch((error) => {
        const hint = sqliteBindingTroubleshootingMessage(error);
        api.logger?.error?.(hint);
        throw new Error(hint);
      });
      const modelCallStarted = new Map();
      const toolCallsByRun = new Map();
      // Cache sender names from message_received metadata.
      // Keyed by sessionKey → { senderId, senderName }
      const senderCache = new Map();
      debugLog({ event: "register", dbPath: config.dbPath });

      // Capture senderName from OpenClaw metadata.
      registerHook(api, "message_received", async (event = {}, ctx = {}) => {
        const sessionKey = event.sessionKey ?? null;
        const senderName = event.metadata?.senderName;
        const senderId = event.metadata?.senderId;
        try {
          const logPath = resolve(homedir(), ".openclaw", "plugins", "token-usage-ledger", "message-received.log");
          mkdirSync(dirname(logPath), { recursive: true });
          appendFileSync(logPath, JSON.stringify({
            ts: new Date().toISOString(),
            sessionKey,
            senderName,
            senderId,
            eventKeys: Object.keys(event),
            metadataKeys: event.metadata ? Object.keys(event.metadata) : null,
            metadataSenderName: event.metadata?.senderName
          }) + "\n");
        } catch(e) { /* silent */ }
        if (sessionKey && (senderName || senderId)) {
          const existing = senderCache.get(sessionKey) ?? {};
          senderCache.set(sessionKey, {
            senderId: senderId ?? existing.senderId ?? null,
            senderName: senderName ?? existing.senderName ?? null
          });
          debugLog({ event: "message_received_cache", sessionKey, senderId, senderName });
        }
      });

      function resolveDisplayName(sessionKey) {
        if (sessionKey && senderCache.has(sessionKey)) {
          const cached = senderCache.get(sessionKey);
          if (cached?.senderName) return cached.senderName;
        }
        return null;
      }

      const { enqueueMirror } = createMirrorManager({
        mirrorConfig: config.mirror,
        db,
        fetchImpl,
        dbReady,
        debugLog
      });

      registerHook(api, "model_call_started", (event = {}, ctx = {}) => {
        const key = buildCallKey(event, ctx);
        modelCallStarted.set(key, new Date().toISOString());
      });

      registerHook(api, "after_tool_call", (event = {}, ctx = {}) => {
        const runKey = buildRunKey(event, ctx);
        const summary = extractToolSummaryFromAfterToolCall(event, ctx);
        debugLog({
          event: "after_tool_call",
          runKey,
          toolName: event.toolName ?? null,
          toolCallCount: summary.toolCallCount,
          eventKeys: Object.keys(event),
          contextKeys: Object.keys(ctx)
        });
        if (!runKey || summary.toolCallCount <= 0) return;

        const existing = toolCallsByRun.get(runKey) ?? { toolCallCount: 0, toolNames: [] };
        toolCallsByRun.set(runKey, mergeToolSummaries(existing, summary));
      });

      registerHook(api, "model_call_ended", async (event = {}, ctx = {}) => {
        const key = buildCallKey(event, ctx);
        const startedAt = modelCallStarted.get(key);
        const runtimeMeta = extractRuntimeMetadata(event, ctx);
        const callMeta = {
          startedAt: typeof startedAt === "string" ? startedAt : startedAt?.startedAt,
          endedAt: new Date().toISOString(),
          durationMs: event.durationMs ?? null,
          upstreamRequestIdHash: event.upstreamRequestIdHash ?? null,
          outcome: event.outcome ?? null,
          errorCode: event.errorCategory ?? event.failureKind ?? null
        };
        modelCallStarted.set(key, callMeta);
        if (event.outcome === "error") {
          await dbReady;
          const runKey = buildRunKey(event, ctx);
          if (runKey) toolCallsByRun.delete(runKey);
          try {
            const actor = extractIdentity(event, ctx);
            const callSource = classifyCallSource(event, ctx);
            const rawChannelName = actor.channelName ?? null;
            const channelName = normalizeChannelName(rawChannelName) ?? rawChannelName;
            const resolvedDisplayName = resolveDisplayName(ctx.sessionKey ?? null);
            const row = {
              id: buildEventId(event, ctx),
              created_at: new Date().toISOString(),
              started_at: callMeta.startedAt ?? null,
              ended_at: callMeta.endedAt,
              duration_ms: callMeta.durationMs,
              gateway_profile: runtimeMeta.gatewayProfile,
              agent_id: runtimeMeta.agentId,
              agent_name: runtimeMeta.agentName,
              runtime_id: runtimeMeta.runtimeId,
              machine_identity: runtimeMeta.machineIdentity,
              platform: actor.platform ?? null,
              channel_name: channelName,
              platform_user_id: actor.platformUserId,
              platform_user_display_name: resolvedDisplayName,
              platform_tenant_id: actor.platformTenantId,
              platform_conversation_id: actor.platformConversationId,
              platform_message_id: actor.platformMessageId,
              thread_id: actor.threadId,
              session_key: runtimeMeta.sessionKey,
              session_id: runtimeMeta.sessionId,
              run_id: runtimeMeta.runId,
              turn_id: null,
              request_id: runtimeMeta.requestId,
              provider_request_id: event.upstreamRequestIdHash ?? null,
              call_source: callSource,
              provider: event.provider ?? null,
              model: event.model ?? null,
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: 0,
              estimated_cost_usd: 0,
              input_cost_usd: 0,
              output_cost_usd: 0,
              cache_cost_usd: 0,
              cost_mode: "unknown",
              context_window: event.contextWindow ?? event.contextTokenBudget ?? null,
              status: "error",
              error_code: callMeta.errorCode,
              error_message: event.errorMessage ?? null,
              retry_count: 0,
              raw_usage_json: null,
              metadata_json: buildMetadataJson(event, ctx, {
                rawChannelName,
                normalizedChannelName: channelName
              })
            };
            await db.insertUsageEvent(row);
            await enqueueMirror(row);
          } catch (error) {
            api.logger?.warn?.("token-usage-ledger failed to record failed model call", error);
          }
        }
      });

      registerHook(api, "llm_output", async (event = {}, ctx = {}) => {
        try {
          await dbReady;
          const runtimeMeta = extractRuntimeMetadata(event, ctx);
          const rawUsage = event.usage;
          if (!rawUsage) {
            debugLog({
              event: "llm_output_no_usage",
              usageValue: event.usage,
              provider: event.provider ?? null,
              model: event.model ?? null,
              channelId: ctx.channelId ?? event.channelId ?? null,
              eventKeys: Object.keys(event ?? {}),
              contextKeys: Object.keys(ctx ?? {})
            });
          }

          const usage = rawUsage ? normalizeUsage(rawUsage) : {
            inputTokens: 0, outputTokens: 0, totalTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0
          };
          const actor = extractIdentity(event, ctx);
          const callSource = classifyCallSource(event, ctx);
          const rawChannelName = actor.channelName ?? null;
          const channelName = normalizeChannelName(rawChannelName) ?? rawChannelName;
          const resolvedDisplayName = resolveDisplayName(ctx.sessionKey ?? null);
          const provider = event.provider ?? null;
          const model = event.model ?? null;
          const callMeta = modelCallStarted.get(buildCallKey(event, ctx));
          const runKey = buildRunKey(event, ctx);
          const cost = rawUsage ? calculateCost({
            provider,
            model,
            usage,
            pricing: config.pricing,
            localModelsCostMode: config.localModelsCostMode
          }) : { estimatedCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0, cacheCostUsd: 0, costMode: "unknown" };
          const assistantToolSummary = extractToolSummary(event);
          const runToolSummary = runKey ? (toolCallsByRun.get(runKey) ?? { toolNames: [], toolCallCount: 0 }) : { toolNames: [], toolCallCount: 0 };
          const toolSummary = mergeToolSummaries(assistantToolSummary, runToolSummary);
          debugLog({
            event: "llm_output_tools",
            runKey,
            assistantToolCount: assistantToolSummary.toolCallCount,
            runToolCount: runToolSummary.toolCallCount,
            mergedToolCount: toolSummary.toolCallCount,
            hasLastAssistant: !!event.lastAssistant,
            lastAssistantContentType: Array.isArray(event.lastAssistant?.content) ? "array" : typeof event.lastAssistant?.content,
            eventCtxRunId: ctx.runId ?? null,
            eventRunId: event.runId ?? null,
            eventKeys: Object.keys(event),
            contextKeys: Object.keys(ctx)
          });
          if (runKey) toolCallsByRun.delete(runKey);
          const toolNames = toolSummary.toolNames;
          const toolCallCount = toolSummary.toolCallCount;

          const row = {
            id: buildEventId(event, ctx),
            created_at: new Date().toISOString(),
            started_at: event.startedAt ?? callMeta?.startedAt ?? ctx.startedAt ?? null,
            ended_at: event.endedAt ?? callMeta?.endedAt ?? new Date().toISOString(),
            duration_ms: event.durationMs ?? callMeta?.durationMs ?? ctx.durationMs ?? null,
            time_to_first_token_ms: null,
            gateway_profile: runtimeMeta.gatewayProfile,
            agent_id: runtimeMeta.agentId,
            agent_name: runtimeMeta.agentName,
            runtime_id: runtimeMeta.runtimeId,
            machine_identity: runtimeMeta.machineIdentity,
            platform: actor.platform ?? null,
            channel_name: channelName,
            platform_user_id: actor.platformUserId,
            platform_user_display_name: resolvedDisplayName,
            platform_tenant_id: actor.platformTenantId,
            platform_conversation_id: actor.platformConversationId,
            platform_message_id: actor.platformMessageId,
            thread_id: actor.threadId,
            session_key: runtimeMeta.sessionKey,
            session_id: runtimeMeta.sessionId,
            run_id: runtimeMeta.runId,
            turn_id: null,
            request_id: runtimeMeta.requestId,
            provider_request_id: callMeta?.upstreamRequestIdHash ?? null,
            call_source: callSource,
            provider,
            model,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
            cache_read_tokens: usage.cacheReadTokens,
            cache_write_tokens: usage.cacheWriteTokens,
            reasoning_tokens: usage.reasoningTokens,
            estimated_cost_usd: cost.estimatedCostUsd,
            input_cost_usd: cost.inputCostUsd,
            output_cost_usd: cost.outputCostUsd,
            cache_cost_usd: cost.cacheCostUsd,
            cost_mode: cost.costMode,
            context_tokens_before: null,
            context_tokens_after: null,
            context_window: event.contextWindow ?? event.contextTokenBudget ?? null,
            had_tool_calls: toolCallCount > 0 ? 1 : 0,
            tool_call_count: toolCallCount,
            tool_names_json: toolNames.length ? JSON.stringify(toolNames) : null,
            status: rawUsage ? (callMeta?.outcome === "error" ? "error" : "success") : "no-usage",
            error_code: callMeta?.errorCode ?? null,
            error_message: event.errorMessage ?? null,
            retry_count: 0,
            prompt_hash: null,
            response_hash: null,
            preview: config.storePreview ? String(event.preview ?? "").slice(0, config.previewMaxChars) : null,
            raw_usage_json: (config.debugRawUsage && rawUsage) ? JSON.stringify(rawUsage) : null,
            metadata_json: buildMetadataJson(event, ctx, {
              rawChannelName,
              normalizedChannelName: channelName
            })
          };
          await db.insertUsageEvent(row);
          await enqueueMirror(row);
        } catch (error) {
          debugLog({ event: "llm_output_error", message: error?.message, stack: error?.stack, code: error?.code });
          api.logger?.warn?.("token-usage-ledger failed to record usage", error);
        }
      });
    }
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function registerHook(api, hookName, handler) {
  if (typeof api.on === "function") {
    // New SDK: api.on passes a single event object; context is at event.context.
    // Wrap to preserve the (event, ctx) signature used throughout this plugin.
    api.on(hookName, (event = {}) => handler(event, event.context ?? {}));
    return;
  }
  if (typeof api.registerHook === "function") {
    api.registerHook(hookName, handler, {
      name: hookName,
      events: [hookName]
    });
    return;
  }
}

function buildCallKey(event = {}, ctx = {}) {
  // ctx owns execution-context fields; event owns call-specific fields.
  // model_call_started/model_call_ended also carry runId on the event itself (docs).
  return [
    ctx.runId ?? event.runId,
    event.callId,
    ctx.sessionId,
    ctx.sessionKey,
    event.provider,
    event.model
  ].map((value) => value ?? "").join("|");
}

function buildRunKey(event = {}, ctx = {}) {
  // ctx.runId is the canonical source; event.runId is listed as optional on tool hooks (docs).
  const id = ctx.runId ?? event.runId ?? null;
  return typeof id === "string" && id.trim() ? id : null;
}

function buildMetadataJson(event = {}, ctx = {}, extra = {}) {
  return JSON.stringify({
    eventKeys: Object.keys(event ?? {}),
    contextKeys: Object.keys(ctx ?? {}),
    ...extra
  });
}

function extractRuntimeMetadata(event = {}, ctx = {}) {
  // ctx owns all execution-context identity fields; event owns call-specific fields.
  const agentId = ctx.agentId ?? parseAgentNameFromSessionKey(ctx.sessionKey);

  return {
    agentId,
    agentName:       agentId,
    runtimeId:       ctx.runtimeId       ?? null,
    machineIdentity: ctx.machineIdentity  ?? null,
    gatewayProfile:  ctx.gatewayProfile   ?? null,
    sessionKey:      ctx.sessionKey       ?? null,
    sessionId:       ctx.sessionId        ?? null,
    runId:           ctx.runId            ?? null,
    requestId:       event.callId         ?? null
  };
}

function parseAgentNameFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  const match = /^agent:([^:]+):/i.exec(sessionKey.trim());
  return match && match[1] ? match[1] : null;
}

function sqliteBindingTroubleshootingMessage(error) {
  const message = error?.message ?? String(error ?? "unknown error");
  return [
    "token-usage-ledger failed to initialize SQLite storage.",
    "This release uses a non-native sql.js backend, so host native bindings are not required.",
    "If this error persists, reinstall the plugin package and restart gateway.",
    `Original error: ${message}`
  ].join(" ");
}


