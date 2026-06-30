import { appendFileSync, mkdirSync } from "fs";
import { homedir, hostname } from "os";
import { resolve, dirname } from "path";
import { buildEventId, createUsageDb, defaultDbPath } from "./db.js";
import { normalizeUsage } from "./normalizeUsage.js";
import { extractIdentity } from "./identity.js";
import { classifyCallSource, parseImChannelPlatform, parseFeishuChannelId } from "./classifySource.js";
import { calculateCost } from "./cost.js";
import { normalizeChannelName } from "./normalizeChannel.js";

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
      try {
        if (typeof db.query === "function") {
          db.query("SELECT 1 AS ok");
        }
      } catch (error) {
        const hint = sqliteBindingTroubleshootingMessage(error);
        api.logger?.error?.(hint);
        throw new Error(hint);
      }
      const modelCallStarted = new Map();
      const toolCallsByRun = new Map();
      // Cache sender names from message_received metadata.
      // Keyed by sessionKey → { senderId, senderName }
      const senderCache = new Map();
      debugLog({ event: "register", dbPath: config.dbPath });

      // Capture senderName from OpenClaw metadata.
      registerHook(api, "message_received", async (event = {}, ctx = {}) => {
        const sessionKey = event.sessionKey ?? ctx.sessionKey;
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

      function normalizedMirrorConfig() {
        const mirror = config.mirror ?? {};
        return {
          enabled: Boolean(mirror.enabled && mirror.url && mirror.apiKey),
          url: firstString(mirror.url),
          apiKey: firstString(mirror.apiKey),
          timeoutMs: Number(mirror.timeoutMs ?? 5000) || 5000,
          retryIntervalMs: Number(mirror.retryIntervalMs ?? 15000) || 15000,
          retryBaseDelayMs: Number(mirror.retryBaseDelayMs ?? 2000) || 2000,
          retryMaxDelayMs: Number(mirror.retryMaxDelayMs ?? 300000) || 300000,
          maxBatchSize: Number(mirror.maxBatchSize ?? 50) || 50
        };
      }

      async function mirrorUsageEvent(row) {
        const mirror = normalizedMirrorConfig();
        if (!mirror.enabled || !mirror.url || !mirror.apiKey || typeof fetchImpl !== "function") {
          return { ok: false, error: "mirror_not_configured" };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), mirror.timeoutMs);

        try {
          const response = await fetchImpl(mirror.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${mirror.apiKey}`
            },
            body: JSON.stringify(row),
            signal: controller.signal
          });

          if (!response.ok) {
            debugLog({ event: "mirror_http_error", status: response.status, url: mirror.url, id: row.id });
            return { ok: false, error: `http_${response.status}` };
          }
          return { ok: true };
        } catch (error) {
          debugLog({ event: "mirror_request_error", url: mirror.url, id: row.id, message: error?.message ?? String(error) });
          return { ok: false, error: error?.message ?? String(error) };
        } finally {
          clearTimeout(timeout);
        }
      }

      const mirror = normalizedMirrorConfig();
      const canUseMirrorQueue = mirror.enabled
        && typeof db.enqueueMirrorEvent === "function"
        && typeof db.listPendingMirrorEvents === "function"
        && typeof db.markMirrorEventSynced === "function"
        && typeof db.markMirrorEventFailed === "function";
      let mirrorFlushRunning = false;

      function computeNextRetryAt(attemptCount) {
        const safeAttempt = Math.max(1, Number(attemptCount) || 1);
        const base = Math.max(100, mirror.retryBaseDelayMs);
        const max = Math.max(base, mirror.retryMaxDelayMs);
        const jitterMs = Math.floor(Math.random() * Math.min(base, 1000));
        const delayMs = Math.min(max, base * (2 ** (safeAttempt - 1))) + jitterMs;
        return new Date(Date.now() + delayMs).toISOString();
      }

      async function flushMirrorQueue() {
        if (!canUseMirrorQueue || mirrorFlushRunning) return;
        mirrorFlushRunning = true;
        try {
          const batchLimit = Math.max(1, Math.min(500, mirror.maxBatchSize));
          while (true) {
            const pending = db.listPendingMirrorEvents(batchLimit);
            if (!pending.length) break;

            for (const entry of pending) {
              if (!entry?.id) continue;
              if (!entry.payload || typeof entry.payload !== "object") {
                db.markMirrorEventSynced(entry.id);
                continue;
              }

              const result = await mirrorUsageEvent(entry.payload);
              if (result.ok) {
                db.markMirrorEventSynced(entry.id);
              } else {
                const attempt = (Number(entry.attemptCount) || 0) + 1;
                const nextRetryAt = computeNextRetryAt(attempt);
                db.markMirrorEventFailed(entry.id, nextRetryAt, firstString(result.error, "mirror_failed"));
              }
            }

            if (pending.length < batchLimit) break;
          }
        } catch (error) {
          debugLog({ event: "mirror_queue_flush_error", message: error?.message ?? String(error) });
        } finally {
          mirrorFlushRunning = false;
        }
      }

      if (canUseMirrorQueue) {
        const timer = setInterval(() => {
          void flushMirrorQueue();
        }, Math.max(1000, mirror.retryIntervalMs));
        if (typeof timer.unref === "function") timer.unref();
      }

      function enqueueMirror(row) {
        if (!mirror.enabled) return;
        if (canUseMirrorQueue) {
          db.enqueueMirrorEvent(row);
          void flushMirrorQueue();
          return;
        }
        void mirrorUsageEvent(row);
      }

      registerHook(api, "model_call_started", (event = {}, ctx = {}) => {
        const key = buildCallKey(event, ctx);
        modelCallStarted.set(key, new Date().toISOString());
      });

      registerHook(api, "after_tool_call", (event = {}, ctx = {}) => {
        const runKey = buildRunKey(event, ctx);
        const summary = extractToolSummaryFromAfterToolCall(event, ctx);
        if (!runKey || summary.toolCallCount <= 0) return;

        const existing = toolCallsByRun.get(runKey) ?? { toolCallCount: 0, toolNames: [] };
        toolCallsByRun.set(runKey, mergeToolSummaries(existing, summary));
      });

      registerHook(api, "model_call_ended", (event = {}, ctx = {}) => {
        const key = buildCallKey(event, ctx);
        const startedAt = modelCallStarted.get(key);
        const runtimeHints = deriveRuntimeHints(event, ctx);
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
          const runKey = buildRunKey(event, ctx);
          if (runKey) toolCallsByRun.delete(runKey);
          try {
            const actor = extractIdentity(event, ctx);
            const callSource = classifyCallSource(event, ctx);
            const rawChannelName = actor.channelName ?? runtimeHints.channelName;
            const channelName = normalizeChannelName(rawChannelName) ?? rawChannelName;
            const resolvedDisplayName = resolveDisplayName(runtimeHints.sessionKey);
            const machineIdentity = resolveMachineIdentity(event, ctx);
            const row = {
              id: buildEventId(event, ctx),
              created_at: new Date().toISOString(),
              started_at: callMeta.startedAt ?? null,
              ended_at: callMeta.endedAt,
              duration_ms: callMeta.durationMs,
              gateway_profile: ctx.gatewayProfile ?? event.gatewayProfile ?? process.env.OPENCLAW_PROFILE ?? null,
              agent_id: ctx.agentId ?? event.agentId ?? runtimeHints.agentId ?? null,
              agent_name: ctx.agentName ?? event.agentName ?? (runtimeHints.agentId ? `agent:${runtimeHints.agentId}` : null),
              runtime_id: ctx.runtimeId ?? event.runtimeId ?? null,
              machine_identity: machineIdentity,
              platform: actor.platform ?? runtimeHints.platform,
              channel_name: channelName,
              platform_user_id: actor.platformUserId,
              platform_user_display_name: resolvedDisplayName,
              platform_tenant_id: actor.platformTenantId,
              platform_conversation_id: actor.platformConversationId,
              platform_message_id: actor.platformMessageId,
              thread_id: actor.threadId,
              session_key: runtimeHints.sessionKey,
              session_id: ctx.sessionId ?? event.sessionId ?? null,
              run_id: ctx.runId ?? event.runId ?? null,
              turn_id: ctx.turnId ?? event.turnId ?? null,
              request_id: event.requestIdHash ?? event.requestId ?? event.callId ?? null,
              provider_request_id: event.providerRequestId ?? event.upstreamRequestIdHash ?? null,
              call_source: callSource === "unknown" ? runtimeHints.source ?? callSource : callSource,
              provider: event.provider ?? ctx.provider ?? null,
              model: event.model ?? ctx.model ?? null,
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
              retry_count: event.retryCount ?? 0,
              raw_usage_json: null,
              metadata_json: buildMetadataJson(event, ctx, {
                rawChannelName,
                normalizedChannelName: channelName
              })
            };
            db.insertUsageEvent(row);
            enqueueMirror(row);
          } catch (error) {
            api.logger?.warn?.("token-usage-ledger failed to record failed model call", error);
          }
        }
      });

      registerHook(api, "llm_output", async (event = {}, ctx = {}) => {
        try {
          const rawUsage = event.usage ?? event.rawUsage ?? event.response?.usage;
          if (!rawUsage) {
            debugLog({
              event: "llm_output_no_usage",
              usageValue: event.usage,
              rawUsageValue: event.rawUsage,
              responseUsageValue: event.response?.usage,
              provider: event.provider ?? ctx.provider ?? null,
              model: event.model ?? ctx.model ?? null,
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
          const runtimeHints = deriveRuntimeHints(event, ctx);
          const callSource = classifyCallSource(event, ctx);
          const rawChannelName = actor.channelName ?? runtimeHints.channelName;
          const channelName = normalizeChannelName(rawChannelName) ?? rawChannelName;
          const resolvedCallSource = callSource === "unknown" ? runtimeHints.source ?? callSource : callSource;
          const resolvedDisplayName = resolveDisplayName(runtimeHints.sessionKey);
          const machineIdentity = resolveMachineIdentity(event, ctx);
          const provider = event.provider ?? ctx.provider ?? null;
          const model = event.model ?? ctx.model ?? null;
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
          if (runKey) toolCallsByRun.delete(runKey);
          const toolNames = toolSummary.toolNames;
          const toolCallCount = toolSummary.toolCallCount;

          const row = {
            id: buildEventId(event, ctx),
            created_at: new Date().toISOString(),
            started_at: event.startedAt ?? callMeta?.startedAt ?? ctx.startedAt ?? null,
            ended_at: event.endedAt ?? callMeta?.endedAt ?? new Date().toISOString(),
            duration_ms: event.durationMs ?? callMeta?.durationMs ?? ctx.durationMs ?? null,
            time_to_first_token_ms: event.timeToFirstTokenMs ?? event.timeToFirstByteMs ?? null,
            gateway_profile: ctx.gatewayProfile ?? event.gatewayProfile ?? process.env.OPENCLAW_PROFILE ?? null,
            agent_id: ctx.agentId ?? event.agentId ?? runtimeHints.agentId ?? null,
            agent_name: ctx.agentName ?? event.agentName ?? (runtimeHints.agentId ? `agent:${runtimeHints.agentId}` : null),
            runtime_id: ctx.runtimeId ?? event.runtimeId ?? null,
            machine_identity: machineIdentity,
            platform: actor.platform ?? runtimeHints.platform,
            channel_name: channelName,
            platform_user_id: actor.platformUserId,
            platform_user_display_name: resolvedDisplayName,
            platform_tenant_id: actor.platformTenantId,
            platform_conversation_id: actor.platformConversationId,
            platform_message_id: actor.platformMessageId,
            thread_id: actor.threadId,
            session_key: runtimeHints.sessionKey,
            session_id: ctx.sessionId ?? event.sessionId ?? null,
            run_id: ctx.runId ?? event.runId ?? null,
            turn_id: ctx.turnId ?? event.turnId ?? null,
            request_id: event.requestIdHash ?? event.requestId ?? event.callId ?? null,
            provider_request_id: event.providerRequestId ?? event.upstreamRequestIdHash ?? callMeta?.upstreamRequestIdHash ?? null,
            call_source: resolvedCallSource,
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
            context_tokens_before: event.contextTokensBefore ?? null,
            context_tokens_after: event.contextTokensAfter ?? null,
            context_window: event.contextWindow ?? event.contextTokenBudget ?? null,
            had_tool_calls: toolCallCount > 0 ? 1 : 0,
            tool_call_count: toolCallCount,
            tool_names_json: toolNames.length ? JSON.stringify(toolNames) : null,
            status: rawUsage ? (event.status ?? (callMeta?.outcome === "error" ? "error" : "success")) : "no-usage",
            error_code: event.errorCode ?? callMeta?.errorCode ?? null,
            error_message: event.errorMessage ?? null,
            retry_count: event.retryCount ?? 0,
            prompt_hash: null,
            response_hash: null,
            preview: config.storePreview ? String(event.preview ?? "").slice(0, config.previewMaxChars) : null,
            raw_usage_json: (config.debugRawUsage && rawUsage) ? JSON.stringify(rawUsage) : null,
            metadata_json: buildMetadataJson(event, ctx, {
              rawChannelName,
              normalizedChannelName: channelName
            })
          };
          db.insertUsageEvent(row);
          enqueueMirror(row);
        } catch (error) {
          debugLog({ event: "llm_output_error", message: error?.message, stack: error?.stack, code: error?.code });
          api.logger?.warn?.("token-usage-ledger failed to record usage", error);
        }
      });
    }
  };
}

function resolveMachineIdentity(event = {}, ctx = {}) {
  return firstString(
    ctx.machineIdentity,
    event.machineIdentity,
    ctx.machineId,
    event.machineId,
    ctx.nodeId,
    event.nodeId,
    ctx.hostname,
    event.hostname,
    process.env.OPENCLAW_MACHINE_ID,
    process.env.HOSTNAME,
    process.env.COMPUTERNAME,
    hostname()
  );
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function registerHook(api, hookName, handler) {
  if (typeof api.on === "function") {
    api.on(hookName, handler);
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
  return [
    ctx.runId ?? event.runId,
    event.callId,
    ctx.sessionId ?? event.sessionId,
    ctx.sessionKey ?? event.sessionKey,
    event.provider ?? ctx.provider,
    event.model ?? ctx.model
  ].map((value) => value ?? "").join("|");
}

function buildRunKey(event = {}, ctx = {}) {
  return firstString(
    ctx.runId,
    event.runId,
    ctx.sessionId,
    event.sessionId,
    ctx.sessionKey,
    event.sessionKey
  );
}

function buildMetadataJson(event = {}, ctx = {}, extra = {}) {
  return JSON.stringify({
    eventKeys: Object.keys(event ?? {}),
    contextKeys: Object.keys(ctx ?? {}),
    ...extra
  });
}

function deriveRuntimeHints(event = {}, ctx = {}) {
  const sessionKey = ctx.sessionKey ?? event.sessionKey ?? null;
  const runtimeId = ctx.runtimeId ?? event.runtimeId ?? null;
  const channelId = ctx.channelId ?? event.channelId ?? null;
  const trigger = ctx.trigger ?? event.trigger ?? null;
  const messageProvider = ctx.messageProvider ?? event.messageProvider ?? null;
  const hints = {
    sessionKey,
    agentId: null,
    platform: null,
    channelName: null,
    source: null
  };

  if (typeof sessionKey === "string") {
    const match = /^agent:([^:]+):(.+)$/.exec(sessionKey);
    if (match) {
      hints.agentId = match[1] || null;
      const tail = match[2] || "";
      if (tail.startsWith("tui-")) {
        hints.platform = "openclaw";
        hints.channelName = "tui";
        hints.source = "tui";
      }
    } else if (sessionKey.includes("tui-")) {
      hints.platform = "openclaw";
      hints.channelName = "tui";
      hints.source = "tui";
    }
  }

  if (!hints.channelName && typeof messageProvider === "string" && messageProvider.trim()) {
    hints.platform = hints.platform ?? "openclaw";
    hints.channelName = messageProvider.trim().toLowerCase();
    hints.source = hints.source ?? hints.channelName;
  }

  if (!hints.channelName && typeof channelId === "string" && channelId.trim()) {
    const imPlatform = parseImChannelPlatform(channelId);
    const feishuPlatform = parseFeishuChannelId(channelId);
    const platform = imPlatform ?? feishuPlatform;
    if (platform) {
      hints.platform = hints.platform ?? "openclaw";
      hints.channelName = platform;
      hints.source = hints.source ?? platform;
    } else {
      hints.channelName = channelId;
    }
  }

  if (!hints.source && typeof trigger === "string" && trigger.trim()) {
    if (trigger.includes("tui")) {
      hints.platform = hints.platform ?? "openclaw";
      hints.channelName = hints.channelName ?? "tui";
      hints.source = "tui";
    }
  }

  if (typeof runtimeId === "string" && runtimeId.startsWith("tui-") && !hints.source) {
    hints.platform = hints.platform ?? "openclaw";
    hints.channelName = hints.channelName ?? "tui";
    hints.source = "tui";
  }

  return hints;
}

function extractToolSummary(event = {}) {
  const extracted = extractToolCallsFromAssistant(event.lastAssistant);
  return {
    toolNames: [...extracted.names],
    toolCallCount: extracted.callCount
  };
}

function extractToolSummaryFromAfterToolCall(event = {}, ctx = {}) {
  const names = new Set();
  let callCount = 0;

  const candidates = [
    event,
    event.toolCall,
    event.tool_call,
    event.toolUse,
    event.tool_use,
    event.functionCall,
    event.function_call,
    event.call,
    event.payload,
    event.data,
    ctx.toolCall,
    ctx.tool_call,
    ctx.toolUse,
    ctx.tool_use,
    ctx.functionCall,
    ctx.function_call,
    ctx.call,
    ctx.payload,
    ctx.data
  ];

  for (const candidate of candidates) {
    const result = extractToolCallFromCandidate(candidate);
    if (!result) continue;
    callCount += 1;
    if (result.name) names.add(result.name);
    break;
  }

  return {
    toolNames: [...names],
    toolCallCount: callCount
  };
}

function extractToolCallFromCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;

  const name = firstString(
    candidate.name,
    candidate.tool_name,
    candidate.tool,
    candidate.function_name,
    candidate.function,
    candidate.toolCall?.name,
    candidate.toolCall?.tool_name,
    candidate.toolCall?.tool,
    candidate.toolCall?.function_name,
    candidate.toolCall?.function,
    candidate.tool_call?.name,
    candidate.tool_call?.tool_name,
    candidate.tool_call?.tool,
    candidate.tool_call?.function_name,
    candidate.tool_call?.function
  );

  if (name) {
    return { name };
  }

  return null;
}

function mergeToolSummaries(primary = {}, secondary = {}) {
  const names = new Set();
  for (const name of primary.toolNames ?? []) {
    if (typeof name === "string" && name.trim()) names.add(name);
  }
  for (const name of secondary.toolNames ?? []) {
    if (typeof name === "string" && name.trim()) names.add(name);
  }

  return {
    toolNames: [...names],
    toolCallCount: Number(primary.toolCallCount ?? 0) + Number(secondary.toolCallCount ?? 0)
  };
}

function isToolCallBlockType(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized === "toolcall"
    || normalized === "tooluse"
    || normalized === "tool_call"
    || normalized === "tool_use"
    || normalized === "functioncall"
    || normalized === "function_call";
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

function extractToolCallsFromAssistant(assistant) {
  const names = new Set();
  if (!assistant || typeof assistant !== "object") {
    return { callCount: 0, names };
  }
  const content = assistant.content;
  if (!Array.isArray(content)) {
    return { callCount: 0, names };
  }

  let callCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (!isToolCallBlockType(block.type)) continue;

    callCount += 1;
    const name = firstString(
      block.name,
      block.tool_name,
      block.tool,
      block.function_name,
      block.function
    );
    if (name) names.add(name);
  }

  return { callCount, names };
}
