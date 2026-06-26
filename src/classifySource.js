export function classifyCallSource(event = {}, ctx = {}) {
  const sessionKey = ctx.sessionKey ?? event.sessionKey ?? "";
  const runtimeId = ctx.runtimeId ?? event.runtimeId ?? "";
  if (typeof sessionKey === "string" && sessionKey.includes(":tui-")) return "tui";
  if (typeof runtimeId === "string" && runtimeId.startsWith("tui-")) return "tui";
  if (ctx.cronJobId || event.cronJobId || ctx.cron || event.cron) return "cron_job";
  if (ctx.compaction || event.compaction || event.reason === "compaction") return "compaction";
  if (ctx.memoryFlush || event.memoryFlush || event.reason === "memory_flush") return "memory_flush";
  if (ctx.heartbeat || event.heartbeat || event.reason === "heartbeat") return "heartbeat";
  if (ctx.subagent || event.subagent || event.agentRole === "subagent") return "subagent";
  if ((ctx.toolCallCount ?? event.toolCallCount ?? 0) > 0 || event.afterToolCall) return "tool_followup";
  if (ctx.manualCommand || event.manualCommand || event.commandName) return "manual_command";
  if (ctx.inboundMessage || event.messageReceived || event.message || ctx.message) return "user_chat";
  return "unknown";
}
