import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("package.json declares native OpenClaw extension metadata and semver floor", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.deepEqual(packageJson.openclaw.extensions, ["./src/index.js"]);
  assert.equal(packageJson.openclaw.hooks, undefined);
  assert.equal(packageJson.openclaw.install.minHostVersion, ">=2026.6.1");
});

test("openclaw.plugin.json declares required native manifest fields", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

  assert.equal(manifest.id, "token-usage-ledger");
  assert.deepEqual(manifest.configSchema, {
    type: "object",
    additionalProperties: false,
    properties: {
      dbPath: {
        type: "string",
        description: "Absolute path to the SQLite database file. Defaults to a file inside the plugin's data directory."
      },
      mirror: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: {
            type: "boolean",
            description: "When true, mirror each locally recorded usage row to a central HTTP ingest endpoint."
          },
          url: {
            type: "string",
            description: "HTTP endpoint that accepts usage event POST requests."
          },
          apiKey: {
            type: "string",
            description: "Bearer token used for the central ingest endpoint."
          },
          timeoutMs: {
            type: "number",
            description: "Mirror request timeout in milliseconds. Defaults to 5000."
          },
          retryIntervalMs: {
            type: "number",
            description: "Background retry flush interval for unsynced mirror events in milliseconds. Defaults to 15000."
          },
          retryBaseDelayMs: {
            type: "number",
            description: "Base delay for exponential retry backoff in milliseconds. Defaults to 2000."
          },
          retryMaxDelayMs: {
            type: "number",
            description: "Maximum delay for exponential retry backoff in milliseconds. Defaults to 300000."
          },
          maxBatchSize: {
            type: "number",
            description: "Maximum number of queued mirror events sent in a single flush. Defaults to 50."
          }
        }
      }
    }
  });
});

test("release versions stay synchronized across package metadata", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

  assert.equal(manifest.version, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
});