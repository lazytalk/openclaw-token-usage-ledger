import { buildEventId, createUsageDb } from "./db.js";
import { normalizeUsage } from "./normalizeUsage.js";
import { extractIdentity } from "./identity.js";
import { classifyCallSource } from "./classifySource.js";
import { calculateCost } from "./cost.js";

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

export function createTokenUsageLedgerPlugin() {
  return {
    id: "token-usage-ledger",
    name: "Token Usage Ledger",
    register(api = {}) {
      const config = { ...defaultConfig, ...(api.config ?? {}) };
      const db = createUsageDb(config.dbPath);

      api.on?.("llm_output", async (event = {}, ctx = {}) => {
        try {
          const rawUsage = event.usage ?? event.rawUsage ?? event.response?.usage;
          if (!rawUsage) return;

          const usage = normalizeUsage(rawUsage);
          const actor = extractIdentity(event, ctx);
          const callSource = classifyCallSource(event, ctx);
          const provider = event.provider ?? ctx.provider ?? null;
          const model = event.model ?? ctx.model ?? null;
          const cost = calculateCost({
            provider,
            model,
            usage,
            pricing: config.pricing,
            localModelsCostMode: config.localModelsCostMode
          });
          const toolNames = event.toolNames ?? ctx.toolNames ?? [];
          const toolCallCount = Number(ctx.toolCallCount ?? event.toolCallCount ?? toolNames.length ?? 0) || 0;

          db.insertUsageEvent({
            id: buildEventId(event, ctx),
            created_at: new Date().toISOString(),
            started_at: event.startedAt ?? ctx.startedAt ?? null,
            ended_at: event.endedAt ?? new Date().toISOString(),
            duration_ms: event.durationMs ?? ctx.durationMs ?? null,
            time_to_first_token_ms: event.timeToFirstTokenMs ?? null,
            gateway_profile: ctx.gatewayProfile ?? event.gatewayProfile ?? process.env.OPENCLAW_PROFILE ?? null,
            agent_id: ctx.agentId ?? event.agentId ?? null,
            agent_name: ctx.agentName ?? event.agentName ?? null,
            runtime_id: ctx.runtimeId ?? event.runtimeId ?? null,
            platform: actor.platform,
            channel_name: actor.channelName,
            platform_user_id: actor.platformUserId,
            platform_user_display_name: actor.platformUserDisplayName,
            platform_tenant_id: actor.platformTenantId,
            platform_conversation_id: actor.platformConversationId,
            platform_message_id: actor.platformMessageId,
            thread_id: actor.threadId,
            session_key: ctx.sessionKey ?? event.sessionKey ?? null,
            session_id: ctx.sessionId ?? event.sessionId ?? null,
            run_id: ctx.runId ?? event.runId ?? null,
            turn_id: ctx.turnId ?? event.turnId ?? null,
            request_id: event.requestIdHash ?? event.requestId ?? null,
            provider_request_id: event.providerRequestId ?? null,
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
            context_tokens_before: event.contextTokensBefore ?? null,
            context_tokens_after: event.contextTokensAfter ?? null,
            context_window: event.contextWindow ?? event.contextTokenBudget ?? null,
            had_tool_calls: toolCallCount > 0 ? 1 : 0,
            tool_call_count: toolCallCount,
            tool_names_json: toolNames.length ? JSON.stringify(toolNames) : null,
            status: event.status ?? "success",
            error_code: event.errorCode ?? null,
            error_message: event.errorMessage ?? null,
            retry_count: event.retryCount ?? 0,
            prompt_hash: null,
            response_hash: null,
            preview: config.storePreview ? String(event.preview ?? "").slice(0, config.previewMaxChars) : null,
            raw_usage_json: config.debugRawUsage ? JSON.stringify(rawUsage) : null,
            metadata_json: JSON.stringify({
              eventKeys: Object.keys(event ?? {}),
              contextKeys: Object.keys(ctx ?? {})
            })
          });
        } catch (error) {
          api.logger?.warn?.("token-usage-ledger failed to record usage", error);
        }
      });
    }
  };
}
