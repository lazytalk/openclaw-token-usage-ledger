// Tool-call extraction utilities for OpenClaw hook payloads.
// OpenClaw 2026.6.1 block type contract:
//   "toolCall"  blocks carry the tool name in block.name
//   "tool_call" blocks carry the tool name in block.toolName

export function extractToolSummary(event = {}) {
  const extracted = extractToolCallsFromAssistant(event.lastAssistant);
  return {
    toolNames: [...extracted.names],
    toolCallCount: extracted.callCount
  };
}

export function extractToolSummaryFromAfterToolCall(event = {}) {
  const name = event.toolName;
  if (typeof name !== "string" || !name.trim()) {
    return { toolNames: [], toolCallCount: 0 };
  }
  return { toolNames: [name], toolCallCount: 1 };
}

export function mergeToolSummaries(primary = {}, secondary = {}) {
  const names = new Set();
  for (const name of primary.toolNames ?? []) {
    if (typeof name === "string" && name.trim()) names.add(name);
  }
  for (const name of secondary.toolNames ?? []) {
    if (typeof name === "string" && name.trim()) names.add(name);
  }
  return {
    toolNames: [...names],
    toolCallCount: Number(primary.toolCallCount ?? 0) + Number(secondary.toolCallCount ?? 0)
  };
}

function isToolCallBlockType(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized === "toolcall" || normalized === "tool_call";
}

function extractToolCallsFromAssistant(assistant) {
  const names = new Set();
  if (!assistant || typeof assistant !== "object") {
    return { callCount: 0, names };
  }
  const content = assistant.content;
  if (!Array.isArray(content)) {
    return { callCount: 0, names };
  }

  let callCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (!isToolCallBlockType(block.type)) continue;

    callCount += 1;
    const name = block.type === "toolCall" ? block.name : block.toolName;
    if (name) names.add(name);
  }

  return { callCount, names };
}
