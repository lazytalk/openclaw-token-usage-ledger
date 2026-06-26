import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { buildEventId, createUsageDb, defaultDbPath } from "./db.js";
import { normalizeUsage } from "./normalizeUsage.js";
import { extractIdentity } from "./identity.js";
import { classifyCallSource, parseImChannelPlatform, parseFeishuChannelId } from "./classifySource.js";
import { calculateCost } from "./cost.js";

// Always write debug log to the plugin data dir; override with LEDGER_DEBUG_LOG env var.
const _defaultDebugLog = resolve(homedir(), ".openclaw-ops", "plugins", "token-usage-ledger", "debug.jsonl");
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
  pricing: {}
};

export function createTokenUsageLedgerPlugin(options = {}) {
  const createDb = options.createDb ?? createUsageDb;
  return {
    id: "token-usage-ledger",
    name: "Token Usage Ledger",
    description: "Durable SQLite token accounting for OpenClaw model calls.",
    register(api = {}) {
      const config = { ...defaultConfig, ...(api.pluginConfig ?? api.config ?? {}) };
      const db = createDb(config.dbPath);
      const modelCallStarted = new Map();
      debugLog({ event: "register", dbPath: config.dbPath });

      registerHook(api, "model_call_started", (event = {}, ctx = {}) => {
        const key = buildCallKey(event, ctx);
        modelCallStarted.set(key, new Date().toISOString());
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
          try {
            const actor = extractIdentity(event, ctx);
            const callSource = classifyCallSource(event, ctx);
            db.insertUsageEvent({
              id: buildEventId(event, ctx),
              created_at: new Date().toISOString(),
              started_at: callMeta.startedAt ?? null,
              ended_at: callMeta.endedAt,
              duration_ms: callMeta.durationMs,
              gateway_profile: ctx.gatewayProfile ?? event.gatewayProfile ?? process.env.OPENCLAW_PROFILE ?? null,
              agent_id: ctx.agentId ?? event.agentId ?? runtimeHints.agentId ?? null,
              agent_name: ctx.agentName ?? event.agentName ?? (runtimeHints.agentId ? `agent:${runtimeHints.agentId}` : null),
              runtime_id: ctx.runtimeId ?? event.runtimeId ?? null,
              platform: actor.platform ?? runtimeHints.platform,
              channel_name: actor.channelName ?? runtimeHints.channelName,
              platform_user_id: actor.platformUserId,
              platform_user_display_name: actor.platformUserDisplayName,
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
              metadata_json: JSON.stringify({
                eventKeys: Object.keys(event ?? {}),
                contextKeys: Object.keys(ctx ?? {})
              })
            });
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
          const resolvedCallSource = callSource === "unknown" ? runtimeHints.source ?? callSource : callSource;
          const provider = event.provider ?? ctx.provider ?? null;
          const model = event.model ?? ctx.model ?? null;
          const callMeta = modelCallStarted.get(buildCallKey(event, ctx));
          const cost = rawUsage ? calculateCost({
            provider,
            model,
            usage,
            pricing: config.pricing,
            localModelsCostMode: config.localModelsCostMode
          }) : { estimatedCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0, cacheCostUsd: 0, costMode: "unknown" };
          const toolNames = event.toolNames ?? ctx.toolNames ?? [];
          const toolCallCount = Number(ctx.toolCallCount ?? event.toolCallCount ?? toolNames.length ?? 0) || 0;

          db.insertUsageEvent({
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
            platform: actor.platform ?? runtimeHints.platform,
            channel_name: actor.channelName ?? runtimeHints.channelName,
            platform_user_id: actor.platformUserId,
            platform_user_display_name: actor.platformUserDisplayName,
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
            metadata_json: JSON.stringify({
              eventKeys: Object.keys(event ?? {}),
              contextKeys: Object.keys(ctx ?? {})
            })
          });
        } catch (error) {
          debugLog({ event: "llm_output_error", message: error?.message, stack: error?.stack, code: error?.code });
          api.logger?.warn?.("token-usage-ledger failed to record usage", error);
        }
      });
    }
  };
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
