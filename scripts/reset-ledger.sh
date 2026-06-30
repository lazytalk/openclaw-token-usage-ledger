#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="token-usage-ledger"
CONFIG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
DB_PATH="${1:-${OPENCLAW_DB_PATH:-}}"
BACKUP_ROOT="${OPENCLAW_DB_BACKUP_DIR:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [ -z "$DB_PATH" ] && [ -f "$CONFIG_PATH" ]; then
  DB_PATH="$(jq -r --arg plugin "$PLUGIN_ID" '.plugins.entries[$plugin].config.dbPath // empty' "$CONFIG_PATH")"
fi

if [ -z "$DB_PATH" ]; then
  DB_PATH="$HOME/.openclaw/plugins/token-usage-ledger/usage.sqlite"
fi

DB_PATH="${DB_PATH/#\~/$HOME}"
BACKUP_ROOT="${BACKUP_ROOT/#\~/$HOME}"

if [ ! -e "$DB_PATH" ]; then
  echo "No ledger database found at: $DB_PATH"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${BACKUP_ROOT:-$(dirname "$DB_PATH")}/token-usage-ledger-backups/$stamp"
mkdir -p "$backup_dir"

for suffix in "" "-wal" "-shm"; do
  file="$DB_PATH$suffix"
  if [ -e "$file" ]; then
    mv "$file" "$backup_dir/$(basename "$file")"
  fi
done

echo "Backed up previous ledger files to: $backup_dir"
echo "Ledger has been cleared. Make one new TUI call, then query:"
echo "sqlite3 \"$DB_PATH\" \"select count(*) as rows, max(created_at) as latest from usage_events;\""
