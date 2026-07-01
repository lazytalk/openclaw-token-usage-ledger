import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { buildEventId, createUsageDb, defaultDbPath } from "./db.js";
import { normalizeUsage } from "./normalizeUsage.js";
import { extractIdentity } from "./identity.js";
import { classifyCallSource, parseImChannelUserId } from "./classifySource.js";
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
      // Cache attribution from message_received metadata.
      // Keyed by sessionKey and runId so model hooks with empty ctx can still be attributed.
      const senderCache = new Map();
      let pendingSender = null;
      debugLog({ event: "register", dbPath: config.dbPath });

      // Capture senderName from OpenClaw metadata.
      registerHook(api, "message_received", async (event = {}, ctx = {}) => {
        const sessionKey = event.sessionKey ?? ctx.sessionKey ?? null;
        const runId = event.runId ?? ctx.runId ?? null;
        const attribution = buildMessageAttribution(event, ctx);
        const senderName = attribution.senderName;
        const senderId = attribution.senderId;
        try {
          const logPath = resolve(homedir(), ".openclaw", "plugins", "token-usage-ledger", "message-received.log");
          mkdirSync(dirname(logPath), { recursive: true });
          appendFileSync(logPath, JSON.stringify({
            ts: new Date().toISOString(),
            sessionKey,
            runId,
            senderName,
            senderId,
            eventKeys: Object.keys(event),
            metadataKeys: event.metadata ? Object.keys(event.metadata) : null,
            metadataSenderName: event.metadata?.senderName
          }) + "\n");
        } catch(e) { /* silent */ }
        if (hasAttribution(attribution)) {
          cacheSender(attribution);
          if (!firstString(runId)) pendingSender = { ...attribution, cachedAt: Date.now() };
          debugLog({ event: "message_received_cache", sessionKey, runId, senderId, senderName, agentId: attribution.agentId, platform: attribution.platform, channelName: attribution.channelName });
        } else {
          pendingSender = null;
        }
      });

      function cacheSender(attribution = {}) {
        const { sessionKey, runId } = attribution;
        for (const key of senderCacheKeys({ sessionKey, runId })) {
          const existing = senderCache.get(key) ?? {};
          senderCache.set(key, {
            ...existing,
            ...dropNullish(attribution),
            senderId: attribution.senderId ?? existing.senderId ?? null,
            senderName: attribution.senderName ?? existing.senderName ?? null
          });
        }
      }

      function resolveSender({ sessionKey, runId }) {
        for (const key of senderCacheKeys({ sessionKey, runId })) {
          const cached = senderCache.get(key);
          if (hasAttribution(cached)) return cached;
        }
        return {};
      }

      function claimPendingSender(runId) {
        if (!firstString(runId) || !pendingSender) return;
        if (Date.now() - pendingSender.cachedAt > 5 * 60 * 1000) {
          pendingSender = null;
          return;
        }
        cacheSender({ ...pendingSender, runId });
        debugLog({ event: "message_received_run_claim", runId, sessionKey: pendingSender.sessionKey, senderId: pendingSender.senderId, senderName: pendingSender.senderName });
        pendingSender = null;
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
        claimPendingSender(buildRunKey(event, ctx));
        modelCallStarted.set(key, new Date().toISOString());
      });

      registerHook(api, "after_tool_call", (event = {}, ctx = {}) => {
        const runKey = buildRunKey(event, ctx);
        const summary = extractToolSummaryFromAfterToolCall(event, ctx);
        claimPendingSender(runKey);
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
            const cachedAttribution = resolveSender(runtimeMeta);
            const { event: enrichedEvent, ctx: enrichedCtx } = enrichWithAttribution(event, ctx, cachedAttribution);
            const enrichedRuntimeMeta = extractRuntimeMetadata(enrichedEvent, enrichedCtx);
            const actor = extractIdentity(enrichedEvent, enrichedCtx);
            const callSource = classifyCallSource(enrichedEvent, enrichedCtx);
            const rawChannelName = actor.channelName ?? null;
            const channelName = normalizeChannelName(rawChannelName) ?? rawChannelName;
            const row = {
              id: buildEventId(event, ctx),
              created_at: new Date().toISOString(),
              started_at: callMeta.startedAt ?? null,
              ended_at: callMeta.endedAt,
              duration_ms: callMeta.durationMs,
              gateway_profile: enrichedRuntimeMeta.gatewayProfile,
              agent_id: enrichedRuntimeMeta.agentId,
              agent_name: enrichedRuntimeMeta.agentName,
              runtime_id: enrichedRuntimeMeta.runtimeId,
              machine_identity: enrichedRuntimeMeta.machineIdentity,
              platform: actor.platform ?? null,
              channel_name: channelName,
              platform_user_id: actor.platformUserId ?? cachedAttribution.senderId ?? null,
              platform_user_display_name: cachedAttribution.senderName ?? actor.platformUserDisplayName,
              platform_tenant_id: actor.platformTenantId,
              platform_conversation_id: actor.platformConversationId,
              platform_message_id: actor.platformMessageId,
              thread_id: actor.threadId,
              session_key: enrichedRuntimeMeta.sessionKey,
              session_id: enrichedRuntimeMeta.sessionId,
              run_id: enrichedRuntimeMeta.runId,
              turn_id: null,
              request_id: enrichedRuntimeMeta.requestId,
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
          claimPendingSender(runtimeMeta.runId);
          const cachedAttribution = resolveSender(runtimeMeta);
          const { event: enrichedEvent, ctx: enrichedCtx } = enrichWithAttribution(event, ctx, cachedAttribution);
          const enrichedRuntimeMeta = extractRuntimeMetadata(enrichedEvent, enrichedCtx);
          const actor = extractIdentity(enrichedEvent, enrichedCtx);
          const callSource = classifyCallSource(enrichedEvent, enrichedCtx);
          const rawChannelName = actor.channelName ?? null;
          const channelName = normalizeChannelName(rawChannelName) ?? rawChannelName;
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
            gateway_profile: enrichedRuntimeMeta.gatewayProfile,
            agent_id: enrichedRuntimeMeta.agentId,
            agent_name: enrichedRuntimeMeta.agentName,
            runtime_id: enrichedRuntimeMeta.runtimeId,
            machine_identity: enrichedRuntimeMeta.machineIdentity,
            platform: actor.platform ?? null,
            channel_name: channelName,
            platform_user_id: actor.platformUserId ?? cachedAttribution.senderId ?? null,
            platform_user_display_name: cachedAttribution.senderName ?? actor.platformUserDisplayName,
            platform_tenant_id: actor.platformTenantId,
            platform_conversation_id: actor.platformConversationId,
            platform_message_id: actor.platformMessageId,
            thread_id: actor.threadId,
            session_key: enrichedRuntimeMeta.sessionKey,
            session_id: enrichedRuntimeMeta.sessionId,
            run_id: enrichedRuntimeMeta.runId,
            turn_id: null,
            request_id: enrichedRuntimeMeta.requestId,
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
          debugLog({ event: "usage_event_inserted", id: row.id, runId: row.run_id, sessionKey: row.session_key, status: row.status, callSource: row.call_source, totalTokens: row.total_tokens });
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

function dropNullish(obj = {}) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== null && value !== undefined));
}

function hasAttribution(attribution = {}) {
  return Boolean(
    attribution.senderName ||
    attribution.senderId ||
    attribution.sessionKey ||
    attribution.runId ||
    attribution.agentId ||
    attribution.platform ||
    attribution.channelName ||
    attribution.channelId ||
    attribution.messageProvider
  );
}

function buildMessageAttribution(event = {}, ctx = {}) {
  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  const sessionKey = firstString(event.sessionKey, ctx.sessionKey);
  const runId = firstString(event.runId, ctx.runId);
  const parsed = parseSessionKey(sessionKey);
  const senderId = firstString(event.senderId, ctx.senderId, metadata.senderId, parsed.platformUserId);

  return {
    sessionKey,
    runId,
    senderId,
    senderName: firstString(metadata.senderName, event.senderName, ctx.senderName),
    agentId: firstString(event.agentId, ctx.agentId, parsed.agentId),
    channelId: firstString(event.channelId, ctx.channelId, metadata.channelId, parsed.channelId),
    channelName: firstString(event.channelName, ctx.channelName, metadata.channelName, parsed.channelName),
    messageProvider: firstString(event.messageProvider, ctx.messageProvider, metadata.messageProvider, parsed.messageProvider),
    platform: firstString(event.platform, ctx.platform, metadata.platform, parsed.platform),
    platformUserId: senderId,
    platformTenantId: firstString(event.platformTenantId, ctx.platformTenantId, metadata.platformTenantId, event.tenantId, ctx.tenantId, metadata.tenantId),
    platformConversationId: firstString(event.platformConversationId, ctx.platformConversationId, metadata.platformConversationId, event.threadId, ctx.threadId, metadata.threadId, metadata.originatingTo, parsed.platformConversationId),
    platformMessageId: firstString(event.platformMessageId, ctx.platformMessageId, event.messageId, ctx.messageId, metadata.messageId),
    threadId: firstString(event.threadId, ctx.threadId, metadata.threadId)
  };
}

function enrichWithAttribution(event = {}, ctx = {}, attribution = {}) {
  const fallback = dropNullish({
    sessionKey: attribution.sessionKey,
    runId: attribution.runId,
    agentId: attribution.agentId,
    channelId: attribution.channelId,
    channelName: attribution.channelName,
    messageProvider: attribution.messageProvider,
    platform: attribution.platform,
    platformUserId: attribution.platformUserId ?? attribution.senderId,
    platformUserDisplayName: attribution.senderName,
    platformTenantId: attribution.platformTenantId,
    platformConversationId: attribution.platformConversationId,
    platformMessageId: attribution.platformMessageId,
    threadId: attribution.threadId
  });

  return {
    event: { ...fallback, ...event },
    ctx: { ...fallback, ...ctx }
  };
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

function senderCacheKeys({ sessionKey, runId } = {}) {
  return [
    typeof runId === "string" && runId.trim() ? `run:${runId}` : null,
    typeof sessionKey === "string" && sessionKey.trim() ? `session:${sessionKey}` : null
  ].filter(Boolean);
}

function buildMetadataJson(event = {}, ctx = {}, extra = {}) {
  return JSON.stringify({
    eventKeys: Object.keys(event ?? {}),
    contextKeys: Object.keys(ctx ?? {}),
    ...extra
  });
}

function parseSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") return {};
  const parts = sessionKey.trim().split(":");
  if (parts[0] !== "agent" || parts.length < 3) return {};

  const agentId = parts[1] || null;
  const channelName = parts[2] || null;
  const channelKind = parts[3] || null;
  const channelId = parts.slice(4).join(":") || null;
  const isTuiSession = /^tui-/i.test(channelName ?? "");
  const isChatSession = Boolean(channelId || channelKind === "direct" || channelKind === "group");
  const platform = isTuiSession ? "openclaw" : isChatSession ? normalizeChannelName(channelName) ?? channelName : null;
  const directUserId = channelKind === "direct" ? parseImChannelUserId(channelId) ?? channelId : null;

  return {
    agentId,
    channelName: isTuiSession ? "tui" : isChatSession ? channelName : null,
    messageProvider: platform,
    platform,
    channelId,
    platformUserId: directUserId,
    platformConversationId: channelKind === "group" ? channelId : null
  };
}

function extractRuntimeMetadata(event = {}, ctx = {}) {
  // ctx owns all execution-context identity fields; event owns call-specific fields.
  const sessionKey = ctx.sessionKey ?? event.sessionKey ?? null;
  const agentId = ctx.agentId ?? event.agentId ?? parseAgentNameFromSessionKey(sessionKey);

  return {
    agentId,
    agentName:       agentId,
    runtimeId:       ctx.runtimeId       ?? null,
    machineIdentity: ctx.machineIdentity  ?? null,
    gatewayProfile:  ctx.gatewayProfile   ?? null,
    sessionKey,
    sessionId:       ctx.sessionId        ?? event.sessionId ?? null,
    runId:           ctx.runId            ?? event.runId ?? null,
    requestId:       event.callId         ?? event.requestId ?? event.resolvedRef ?? event.harnessId ?? event.runId ?? null
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


