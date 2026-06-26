# OpenClaw Token Usage Ledger

OpenClaw plugin that records one durable token usage event per model call into SQLite, then reports usage without reading or depending on compacted session history.

## What It Stores

The collector records metadata and usage numbers only. It does not store full prompts or full responses by default.

Stored fields include:

- model call timing and latency
- platform user identity and conversation location
- agent, runtime, session, run, turn, request, provider request IDs
- provider, model, normalized input/output/cache/reasoning tokens
- estimated cost fields
- context window metadata
- tool call counts and tool names
- raw provider usage JSON for later correction/debugging

## Configuration

The plugin runtime schema currently accepts one plugin config key:

- `dbPath` (optional): absolute path to the SQLite file.

Default database path when `dbPath` is omitted:

- `~/.openclaw-ops/plugins/token-usage-ledger/usage.sqlite`

To inspect the ledger on a host, set `DB` from config and fall back to that default path if the config omits `dbPath`:

```bash
DB="$(jq -r '.plugins.entries["token-usage-ledger"].config.dbPath // empty' "$HOME/.openclaw/openclaw.json")"
if [ -z "$DB" ]; then
  DB="$HOME/.openclaw-ops/plugins/token-usage-ledger/usage.sqlite"
fi
```

Example plugin entry in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "token-usage-ledger": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "dbPath": "/Users/you/.openclaw-ops/plugins/token-usage-ledger/usage.sqlite"
        }
      }
    },
    "allow": [
      "token-usage-ledger"
    ]
  }
}
```

`allowConversationAccess` is required for non-bundled plugins to receive `llm_output`.

If you reinstall the plugin, OpenClaw may remove the entry from `openclaw.json`. Reapply the config patch above after reinstalling.

## Install For Local Development

```bash
npm install
npm test
openclaw plugins install --link .
```

Then patch OpenClaw config for conversation hook access and allow-list:

```bash
jq '
  .plugins.entries["token-usage-ledger"].enabled = true
  | .plugins.entries["token-usage-ledger"].hooks.allowConversationAccess = true
  | .plugins.allow = ((.plugins.allow // []) + ["token-usage-ledger"] | unique)
' "$HOME/.openclaw/openclaw.json" > /tmp/openclaw.json && mv /tmp/openclaw.json "$HOME/.openclaw/openclaw.json"

openclaw gateway restart
openclaw plugins inspect token-usage-ledger --runtime --json
```

For repeatable setup on a new host, use the helper script:

```bash
bash scripts/setup-openclaw.sh
```

To also pin a specific SQLite path, pass it as the first argument or set `OPENCLAW_DB_PATH`:

```bash
bash scripts/setup-openclaw.sh /Users/you/.openclaw-ops/plugins/token-usage-ledger/usage.sqlite
```

Healthy runtime output should show:

- `hookCount: 3`
- `typedHooks`: `llm_output`, `model_call_started`, `model_call_ended`
- no diagnostics about blocked `llm_output`

The production SQLite writer uses `better-sqlite3`. The local unit tests avoid native dependencies where possible, but a real OpenClaw install should run `npm install` first.

For OpenClaw `2026.6.1`, dependency installation depends on the install mode:

- `git:` plugin installs run `npm install --omit=dev` automatically before OpenClaw loads the plugin.
- npm/package installs are installed into OpenClaw's managed npm root automatically.
- Raw local directory installs should be treated as source installs; run `npm install` in this repo first so `better-sqlite3` exists.

If `better-sqlite3` cannot use a prebuilt binary on your remote machine, the machine needs a working native build toolchain for Node modules.

## Report Command

```bash
openclaw-token-usage-report \
  --db "$DB" \
  --since 24h \
  --format markdown
```

Supported options:

- `--db <path>`
- `--since 24h`
- `--from 2026-06-25T00:00:00`
- `--to 2026-06-26T00:00:00`
- `--timezone America/Phoenix`
- `--format text | json | markdown`
- `--top 10`
- `--include-anomalies`

For a quick sanity check before running the report:

```bash
sqlite3 "$DB" ".tables"
sqlite3 "$DB" "select count(*) as rows, max(created_at) as latest from usage_events;"
```

## Cron Reporter

Use command cron for reports. The cron job reads the SQLite ledger only; it does not collect usage and it does not call a model.

```bash
openclaw cron create "0 0 * * *" \
  --name "Daily token usage report" \
  --command-argv '["node","/path/to/openclaw-token-usage-ledger/src/report.js","--since","24h","--format","markdown"]' \
  --command-cwd "/path/to/openclaw-token-usage-ledger" \
  --announce \
  --channel feishu \
  --to "<target>"
```

## OpenClaw 2026.6.1 Compatibility

This plugin targets OpenClaw `2026.6.1 (2e08f0f)`.

Compatibility notes from that source revision:

- `llm_output`, `model_call_started`, and `model_call_ended` are supported hook names.
- Plugin entries may use the canonical `definePluginEntry` helper, but OpenClaw also loads the same normalized object shape exported by this package: `id`, `name`, `description`, and `register(api)`.
- The native hook API is `api.registerHook(...)`. This plugin uses that and keeps a fallback to `api.on(...)` only for older experimental runtimes.
- `llm_output.usage` uses OpenClaw-native fields: `input`, `output`, `cacheRead`, `cacheWrite`, and `total`. The normalizer supports those fields plus common provider variants.
