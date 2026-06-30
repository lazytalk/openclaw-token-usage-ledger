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

The plugin runtime schema currently accepts:

- `dbPath` (optional): absolute path to the SQLite file.
- `mirror` (optional): mirror settings for central HTTP ingest.

`mirror` fields:

- `enabled`: enable central mirror posting.
- `url`: central ingest endpoint.
- `apiKey`: bearer token for the endpoint.
- `timeoutMs`: per-request timeout (default `5000`).
- `retryIntervalMs`: background queue flush interval (default `15000`).
- `retryBaseDelayMs`: exponential retry base delay (default `2000`).
- `retryMaxDelayMs`: exponential retry max delay (default `300000`).
- `maxBatchSize`: queued rows sent per flush (default `50`).

Mirror delivery model:

- Every event is written to local SQLite first.
- Each event is then enqueued in a persistent local mirror outbox.
- A background worker flushes due outbox rows to the central endpoint.
- Failed sends are retried with exponential backoff until they succeed.
- This gives eventual sync without blocking local ledger recording.

Default database path when `dbPath` is omitted:

- `~/.openclaw/plugins/token-usage-ledger/usage.sqlite`

To inspect the ledger on a host, set `DB` from config and fall back to that default path if the config omits `dbPath`:

```bash
DB="$(jq -r '.plugins.entries["token-usage-ledger"].config.dbPath // empty' "$HOME/.openclaw/openclaw.json")"
if [ -z "$DB" ]; then
  DB="$HOME/.openclaw/plugins/token-usage-ledger/usage.sqlite"
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
          "dbPath": "/Users/you/.openclaw/plugins/token-usage-ledger/usage.sqlite"
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
bash scripts/setup-openclaw.sh /Users/you/.openclaw/plugins/token-usage-ledger/usage.sqlite
```

To start a clean smoke test from an empty ledger, back up and clear the current SQLite files first:

```bash
bash scripts/reset-ledger.sh
```

That moves the current database, WAL, and SHM files into a timestamped backup folder and leaves the ledger ready for a fresh TUI call.

Healthy runtime output should show:

- `hookCount: 4`
- `typedHooks`: `llm_output`, `message_received`, `model_call_started`, `model_call_ended`
- no diagnostics about blocked `llm_output`

The production SQLite writer uses `sql.js` (WASM SQLite), so it does not require native Node bindings.

For OpenClaw `2026.6.1`, managed installs remain deterministic because `sql.js` does not depend on native postinstall build steps.

If plugin runtime logs still show SQLite initialization errors, reinstall and restart:

```bash
openclaw plugins install /path/to/token-usage-ledger-<version>.tgz --force
openclaw gateway restart
```

### Supported install paths (OpenClaw 2026.6.1)

For this OpenClaw build, `openclaw plugins install` supports local paths (and linked local source), but URL npm specs are rejected.

Supported:

- Local package artifact (`.tgz`) path
- Local source directory with `--link`

Not supported in this build:

- `git+https://...`
- `https://...`
- Other URL-based npm specs

## Updating the Plugin

On the deployed host, run:

```bash
cd /path/to/openclaw-token-usage-ledger
git pull
npm install --omit=dev
openclaw gateway restart
```

Whether a gateway restart is required depends on what changed:

| Changed files | Restart needed? |
|---|---|
| `src/plugin.js`, `src/identity.js`, `src/classifySource.js`, `src/normalizeChannel.js`, `src/normalizeUsage.js`, `src/cost.js`, `src/db.js` | **Yes** — plugin runtime code runs inside the gateway process |
| `src/report.js`, `src/reportCore.js` | **No** — report runs as a separate one-shot process |

When in doubt, restart. It is always safe to do so.

After restarting, verify the plugin is loaded correctly:

```bash
openclaw plugins inspect token-usage-ledger --runtime --json
```

Healthy output should show `hookCount: 4` and no diagnostics about blocked `llm_output`.

If you install from release artifacts, update with one of these paths and then restart:

- tracked install update:

```bash
openclaw plugins update /path/to/token-usage-ledger-<version>.tgz
openclaw gateway restart
```

- direct replace (when install says plugin already exists):

```bash
openclaw plugins install /path/to/token-usage-ledger-<version>.tgz --force
openclaw gateway restart
```

## Release Artifact Deployment

For normal production rollout, prefer a versioned package artifact instead of manual file-by-file sync.

Create an artifact from this repo:

```bash
npm run release:pack
```

Create an artifact and bump version in one step:

```bash
npm run release:patch
```

By default, bump releases also create:

- a release commit: `chore(release): vX.Y.Z`
- an annotated git tag: `vX.Y.Z`

To bump and pack without creating a tag:

```bash
node scripts/release-pack.mjs --bump patch --no-tag
```

Other bump levels:

```bash
npm run release:minor
npm run release:major
```

These commands create tarballs under `assets/` and print the exact install command for OpenClaw.

### GitHub auto-release on version bump

This repo includes a GitHub Actions workflow at `.github/workflows/release-on-version-bump.yml`.

Behavior on each push to `main`:

- Reads `package.json` version.
- Compares it to the latest `v*` tag.
- If version increased, it creates and pushes a new tag (`vX.Y.Z`), packs the plugin tarball, and publishes a GitHub Release with the artifact.
- If version did not increase, it skips release.

This means packaging can be fully automated with one rule: bump `package.json` version when you want a release.

Install the generated GitHub release asset by downloading the stable latest file, then installing the local file with `openclaw plugins install`:

```bash
TMP_TGZ="${TMPDIR:-/tmp}/token-usage-ledger.tgz"

curl -fL -o "$TMP_TGZ" \
  "https://github.com/lazytalk/openclaw-token-usage-ledger/releases/latest/download/token-usage-ledger.tgz"

openclaw plugins install "$TMP_TGZ" --force
openclaw gateway restart
openclaw plugins inspect token-usage-ledger --runtime --json
```

Each release publishes both assets:

- versioned historical artifact: `token-usage-ledger-X.Y.Z.tgz`
- stable latest alias: `token-usage-ledger.tgz`

macOS quick upgrade (copy/paste):

```bash
TMP_TGZ="${TMPDIR:-/tmp}/token-usage-ledger.tgz"

curl -fL -o "$TMP_TGZ" \
  "https://github.com/lazytalk/openclaw-token-usage-ledger/releases/latest/download/token-usage-ledger.tgz" \
  && openclaw plugins install "$TMP_TGZ" --force \
  && openclaw gateway restart \
  && openclaw plugins inspect token-usage-ledger --runtime --json
```

Versioning policy recommendation:

- Do not bump package version for every commit.
- Bump package version for each release/deployment artifact (patch/minor/major by semantic versioning).
- Multiple commits can belong to one versioned release.

## Report Command

For a git-clone install (most common on a deployed host), run directly with `node`:

```bash
node /path/to/openclaw-token-usage-ledger/src/report.js \
  --db "$DB" \
  --since 24h \
  --format markdown
```

If the package was installed via npm or `openclaw plugins install`, the bin command is also available:

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
- `--session <session_key_or_id>`
- `--timezone America/Phoenix`
- `--format text | json | markdown`
- `--top 10`
- `--include-anomalies`

When `--session` is provided, text/markdown output includes a `Session calls` section listing each call in that session with timestamp, model, and token breakdown.

For a quick sanity check before running the report:

```bash
sqlite3 "$DB" ".tables"
sqlite3 "$DB" "select count(*) as rows, max(created_at) as latest from usage_events;"
```

Fresh smoke test flow:

1. Run `bash scripts/reset-ledger.sh` on the OpenClaw host.
2. Make one new TUI model call.
3. Check the newest row:

```bash
sqlite3 "$DB" "select count(*) as rows, max(created_at) as latest from usage_events;"
sqlite3 "$DB" "select created_at, agent_id, agent_name, platform, channel_name, call_source, session_key, metadata_json from usage_events order by created_at desc limit 1;"
```

Expected for a successful TUI attribution test:

- `rows` increases from `0` to `1`
- `latest` changes to the new call time
- `platform` is `openclaw`
- `channel_name` is `tui`
- `call_source` is `tui`

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
