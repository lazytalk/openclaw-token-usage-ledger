export function normalizeChannelName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name) return null;

  if (["wechat", "weixin", "openclaw-wechat", "openclaw-weixin", "wx"].includes(name)) {
    return "wechat";
  }

  if (["feishu", "lark", "openclaw-feishu", "openclaw-lark"].includes(name)) {
    return "feishu";
  }

  return name;
}

// Channel-like values that were historically stored as call_source before the
// source classification fix. Map them to their canonical trigger-type equivalent.
const CHANNEL_LIKE_SOURCES = new Set([
  "wechat", "weixin", "openclaw-wechat", "openclaw-weixin", "wx",
  "feishu", "lark", "openclaw-feishu", "openclaw-lark"
]);

export function normalizeCallSource(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name) return null;
  // If a channel label leaked into call_source (historical rows), reclassify as user_chat
  if (CHANNEL_LIKE_SOURCES.has(name)) return "user_chat";
  return name;
}
