import assert from "node:assert/strict";
import test from "node:test";
import { classifyCallSource, parseImChannelPlatform, parseImChannelUserId, parseFeishuChannelId, parseFeishuUserId } from "../src/classifySource.js";

test("classifies TUI calls from session key", () => {
  const source = classifyCallSource({}, { sessionKey: "agent:main:tui-123" });
  assert.equal(source, "tui");
});

test("classifies TUI calls from runtime id", () => {
  const source = classifyCallSource({}, { runtimeId: "tui-abc" });
  assert.equal(source, "tui");
});

test("classifies WeChat calls from @im.wechat channelId as user chat source", () => {
  const source = classifyCallSource({}, { channelId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat" });
  assert.equal(source, "user_chat");
});

test("classifies Lark/Feishu calls from @im.lark channelId as user chat source", () => {
  const source = classifyCallSource({}, { channelId: "abc123@im.lark" });
  assert.equal(source, "user_chat");
});

test("classifies messageProvider calls as user chat source", () => {
  const source = classifyCallSource({}, { messageProvider: "feishu", channelId: "ou_5483d4c149c7b1ef00ea7297d41256da" });
  assert.equal(source, "user_chat");
});

test("classifies Feishu calls from ou_ channelId prefix as user chat source", () => {
  const source = classifyCallSource({}, { channelId: "ou_5483d4c149c7b1ef00ea7297d41256da" });
  assert.equal(source, "user_chat");
});

test("keeps tool followup higher priority than chat channel hints", () => {
  const source = classifyCallSource(
    { toolCallCount: 1, channelId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat" },
    { messageProvider: "openclaw-weixin" }
  );
  assert.equal(source, "tool_followup");
});

test("parseImChannelPlatform extracts platform from channelId", () => {
  assert.equal(parseImChannelPlatform("xyz@im.wechat"), "wechat");
  assert.equal(parseImChannelPlatform("xyz@im.feishu"), "feishu");
  assert.equal(parseImChannelPlatform("xyz@im.lark"), "lark");
  assert.equal(parseImChannelPlatform("tui-abc123"), null);
  assert.equal(parseImChannelPlatform(""), null);
  assert.equal(parseImChannelPlatform(null), null);
});

test("parseImChannelUserId extracts user id from channelId", () => {
  assert.equal(parseImChannelUserId("o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat"), "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU");
  assert.equal(parseImChannelUserId("abc123@im.feishu"), "abc123");
  assert.equal(parseImChannelUserId("tui-abc"), null);
  assert.equal(parseImChannelUserId(""), null);
  assert.equal(parseImChannelUserId(null), null);
});

test("parseFeishuUserId extracts open user id from ou_ channelId", () => {
  assert.equal(parseFeishuUserId("ou_5483d4c149c7b1ef00ea7297d41256da"), "ou_5483d4c149c7b1ef00ea7297d41256da");
  assert.equal(parseFeishuUserId("oc_5483d4c149c7b1ef00ea7297d41256da"), null); // oc_ = chat, not user
  assert.equal(parseFeishuUserId("tui-abc"), null);
  assert.equal(parseFeishuUserId(""), null);
});

test("parseFeishuChannelId detects Feishu open IDs", () => {
  assert.equal(parseFeishuChannelId("ou_5483d4c149c7b1ef00ea7297d41256da"), "feishu");
  assert.equal(parseFeishuChannelId("oc_5483d4c149c7b1ef00ea7297d41256da"), "feishu");
  assert.equal(parseFeishuChannelId("og_5483d4c149c7b1ef00ea7297d41256da"), "feishu");
  assert.equal(parseFeishuChannelId("o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat"), null);
  assert.equal(parseFeishuChannelId("tui-abc"), null);
  assert.equal(parseFeishuChannelId(""), null);
});
