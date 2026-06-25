function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function pickObject(...values) {
  for (const value of values) {
    if (value && typeof value === "object") return value;
  }
  return {};
}

export function extractIdentity(event = {}, ctx = {}) {
  const sender = pickObject(event.sender, event.user, event.actor, ctx.sender, ctx.user, ctx.actor);
  const feishu = pickObject(event.feishu, ctx.feishu, sender.feishu);
  const wechat = pickObject(event.wechat, ctx.wechat, sender.wechat);
  const channel = pickObject(event.channel, ctx.channel);
  const conversation = pickObject(event.conversation, ctx.conversation, event.thread, ctx.thread);

  const platform = firstString(
    event.platform,
    ctx.platform,
    channel.platform,
    feishu.tenant_key || feishu.open_id ? "feishu" : null,
    wechat.openid || wechat.unionid ? "wechat" : null,
    channel.name
  );

  let platformUserId = firstString(
    feishu.union_id,
    feishu.unionId,
    feishu.open_id,
    feishu.openId,
    feishu.user_id,
    feishu.userId,
    wechat.unionid,
    wechat.unionId,
    wechat.openid,
    wechat.openId,
    sender.union_id,
    sender.unionId,
    sender.open_id,
    sender.openId,
    sender.user_id,
    sender.userId,
    sender.id,
    event.platformUserId,
    ctx.platformUserId
  );

  const conversationId = firstString(
    event.platformConversationId,
    ctx.platformConversationId,
    conversation.id,
    conversation.thread_id,
    conversation.threadId,
    event.threadId,
    ctx.threadId,
    event.groupId,
    ctx.groupId,
    event.roomId,
    ctx.roomId,
    channel.conversationId,
    channel.id
  );

  if (platformUserId && conversationId && platformUserId === conversationId) {
    platformUserId = null;
  }

  return {
    platform,
    channelName: firstString(event.channelName, ctx.channelName, channel.name),
    platformUserId,
    platformUserDisplayName: firstString(
      feishu.name,
      feishu.display_name,
      wechat.nickname,
      wechat.displayName,
      sender.display_name,
      sender.displayName,
      sender.name,
      event.platformUserDisplayName,
      ctx.platformUserDisplayName
    ),
    platformTenantId: firstString(
      feishu.tenant_key,
      feishu.tenantKey,
      event.platformTenantId,
      ctx.platformTenantId,
      event.tenantId,
      ctx.tenantId
    ),
    platformConversationId: conversationId,
    platformMessageId: firstString(
      event.platformMessageId,
      ctx.platformMessageId,
      event.messageId,
      ctx.messageId,
      event.message?.id,
      ctx.message?.id
    ),
    threadId: firstString(event.threadId, ctx.threadId, conversation.thread_id, conversation.threadId)
  };
}
