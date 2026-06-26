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
