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

```json
{
  "plugins": {
    "entries": {
      "token-usage-ledger": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "timeoutMs": 30000
        },
        "config": {
          "dbPath": "~/.openclaw-ops/plugins/token-usage-ledger/usage.sqlite",
          "storeContent": false,
          "storePreview": false,
          "previewMaxChars": 120,
          "hashContent": true,
          "reportTimezone": "America/Phoenix",
          "defaultCurrency": "USD",
          "localModelsCostMode": "zero",
          "debugRawUsage": true
        }
      }
    }
  }
}
```

## Install For Local Development

```bash
npm install
npm test
openclaw plugins install --link .
openclaw plugins enable token-usage-ledger
openclaw gateway restart
```

The production SQLite writer uses `better-sqlite3`. The local unit tests avoid native dependencies where possible, but a real OpenClaw install should run `npm install` first.

## Report Command

```bash
openclaw-token-usage-report \
  --db ~/.openclaw-ops/plugins/token-usage-ledger/usage.sqlite \
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

## Notes

The plugin exports a default object with `id`, `name`, and `register(api)`. If your installed OpenClaw version requires a specific SDK wrapper such as `definePluginEntry`, wrap `createTokenUsageLedgerPlugin()` in that SDK helper in `src/index.js`.
