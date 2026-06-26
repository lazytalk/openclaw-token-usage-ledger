import assert from "node:assert/strict";
import test from "node:test";
import { extractIdentity } from "../src/identity.js";

test("prefers Feishu union_id and stores conversation separately", () => {
  const actor = extractIdentity({
    feishu: {
      union_id: "union-1",
      open_id: "open-1",
      tenant_key: "tenant-1",
      name: "Ada"
    },
    conversation: { id: "chat-1" },
    messageId: "msg-1"
  });

  assert.equal(actor.platform, "feishu");
  assert.equal(actor.platformUserId, "union-1");
  assert.equal(actor.platformConversationId, "chat-1");
  assert.equal(actor.platformTenantId, "tenant-1");
  assert.equal(actor.platformUserDisplayName, "Ada");
});

test("prefers WeChat unionid over openid", () => {
  const actor = extractIdentity({
    wechat: { unionid: "union-wx", openid: "open-wx", nickname: "Lin" },
    roomId: "room-1"
  });

  assert.equal(actor.platform, "wechat");
  assert.equal(actor.platformUserId, "union-wx");
  assert.equal(actor.platformConversationId, "room-1");
});

test("does not reuse conversation id as user id", () => {
  const actor = extractIdentity({
    sender: { id: "chat-1" },
    conversation: { id: "chat-1" }
  });

  assert.equal(actor.platformUserId, null);
  assert.equal(actor.platformConversationId, "chat-1");
});

test("extracts wechat user id from channelId @im.wechat format", () => {
  const actor = extractIdentity({}, { channelId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat" });

  assert.equal(actor.platformUserId, "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU");
  assert.equal(actor.platform, "wechat");
});

test("extracts feishu user id from ou_ channelId format", () => {
  const actor = extractIdentity({}, { channelId: "ou_5483d4c149c7b1ef00ea7297d41256da" });

  assert.equal(actor.platformUserId, "ou_5483d4c149c7b1ef00ea7297d41256da");
  assert.equal(actor.platform, "feishu");
});
