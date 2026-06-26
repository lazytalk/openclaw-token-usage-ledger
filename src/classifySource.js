export function classifyCallSource(event = {}, ctx = {}) {
  const sessionKey = ctx.sessionKey ?? event.sessionKey ?? "";
  const runtimeId = ctx.runtimeId ?? event.runtimeId ?? "";
  const channelId = ctx.channelId ?? event.channelId ?? "";
  const messageProvider = ctx.messageProvider ?? event.messageProvider ?? "";
  const hasMessageProvider = typeof messageProvider === "string" && messageProvider.trim();
  const hasImChannel = Boolean(parseImChannelPlatform(channelId) || parseFeishuChannelId(channelId));

  if (typeof sessionKey === "string" && sessionKey.includes(":tui-")) return "tui";
  if (typeof runtimeId === "string" && runtimeId.startsWith("tui-")) return "tui";
  if (ctx.cronJobId || event.cronJobId || ctx.cron || event.cron) return "cron_job";
  if (ctx.compaction || event.compaction || event.reason === "compaction") return "compaction";
  if (ctx.memoryFlush || event.memoryFlush || event.reason === "memory_flush") return "memory_flush";
  if (ctx.heartbeat || event.heartbeat || event.reason === "heartbeat") return "heartbeat";
  if (ctx.subagent || event.subagent || event.agentRole === "subagent") return "subagent";
  if ((ctx.toolCallCount ?? event.toolCallCount ?? 0) > 0 || event.afterToolCall) return "tool_followup";
  if (ctx.manualCommand || event.manualCommand || event.commandName) return "manual_command";
  if (ctx.inboundMessage || event.messageReceived || event.message || ctx.message || hasMessageProvider || hasImChannel) return "user_chat";
  return "unknown";
}

// channelId format: "{peerId}@im.{platform}" e.g. "abc123@im.wechat"
export function parseImChannelPlatform(channelId = "") {
  if (typeof channelId !== "string") return null;
  const m = /\@im\.([a-z][a-z0-9_-]*)$/i.exec(channelId);
  return m ? m[1].toLowerCase() : null;
}

// Feishu open IDs: ou_ = open user, oc_ = open chat, og_ = open group
export function parseFeishuChannelId(channelId = "") {
  if (typeof channelId !== "string") return null;
  if (/^o[ucg]_[0-9a-f]{32}$/.test(channelId)) return "feishu";
  return null;
}
