#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="token-usage-ledger"
CONFIG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
DB_PATH="${1:-${OPENCLAW_DB_PATH:-}}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw is required" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "OpenClaw config not found: $CONFIG_PATH" >&2
  exit 1
fi

tmp_file="$(mktemp)"

if [ -n "$DB_PATH" ]; then
  jq --arg plugin "$PLUGIN_ID" --arg dbPath "$DB_PATH" '
    .plugins.entries[$plugin] = ((.plugins.entries[$plugin] // {}) + {"enabled": true})
    | .plugins.entries[$plugin].hooks.allowConversationAccess = true
    | .plugins.entries[$plugin].config.dbPath = $dbPath
    | .plugins.allow = ((.plugins.allow // []) + [$plugin] | unique)
  ' "$CONFIG_PATH" > "$tmp_file"
else
  jq --arg plugin "$PLUGIN_ID" '
    .plugins.entries[$plugin] = ((.plugins.entries[$plugin] // {}) + {"enabled": true})
    | .plugins.entries[$plugin].hooks.allowConversationAccess = true
    | .plugins.allow = ((.plugins.allow // []) + [$plugin] | unique)
  ' "$CONFIG_PATH" > "$tmp_file"
fi

mv "$tmp_file" "$CONFIG_PATH"

openclaw gateway restart
openclaw plugins inspect "$PLUGIN_ID" --runtime --json | jq '.typedHooks, .policy, .diagnostics'
