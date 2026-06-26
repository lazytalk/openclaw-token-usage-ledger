import assert from "node:assert/strict";
import test from "node:test";
import { classifyCallSource, parseImChannelPlatform } from "../src/classifySource.js";

test("classifies TUI calls from session key", () => {
  const source = classifyCallSource({}, { sessionKey: "agent:main:tui-123" });
  assert.equal(source, "tui");
});

test("classifies TUI calls from runtime id", () => {
  const source = classifyCallSource({}, { runtimeId: "tui-abc" });
  assert.equal(source, "tui");
});

test("classifies WeChat calls from @im.wechat channelId", () => {
  const source = classifyCallSource({}, { channelId: "o9cq80x7h0yhlL0XY7Ivw0Fa3hdU@im.wechat" });
  assert.equal(source, "wechat");
});

test("classifies Lark/Feishu calls from @im.lark channelId", () => {
  const source = classifyCallSource({}, { channelId: "abc123@im.lark" });
  assert.equal(source, "lark");
});

test("parseImChannelPlatform extracts platform from channelId", () => {
  assert.equal(parseImChannelPlatform("xyz@im.wechat"), "wechat");
  assert.equal(parseImChannelPlatform("xyz@im.feishu"), "feishu");
  assert.equal(parseImChannelPlatform("xyz@im.lark"), "lark");
  assert.equal(parseImChannelPlatform("tui-abc123"), null);
  assert.equal(parseImChannelPlatform(""), null);
  assert.equal(parseImChannelPlatform(null), null);
});
