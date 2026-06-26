import assert from "node:assert/strict";
import test from "node:test";
import { classifyCallSource } from "../src/classifySource.js";

test("classifies TUI calls from session key", () => {
  const source = classifyCallSource({}, { sessionKey: "agent:main:tui-123" });
  assert.equal(source, "tui");
});

test("classifies TUI calls from runtime id", () => {
  const source = classifyCallSource({}, { runtimeId: "tui-abc" });
  assert.equal(source, "tui");
});
