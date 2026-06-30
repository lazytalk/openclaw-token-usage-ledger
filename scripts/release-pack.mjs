#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args, options = {}) {
  return execFileSync(npmCmd, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...options,
  });
}

function readPackageVersion() {
  const pkgPath = resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/release-pack.mjs [--bump patch|minor|major]",
      "",
      "Examples:",
      "  node scripts/release-pack.mjs",
      "  node scripts/release-pack.mjs --bump patch",
      "",
      "Behavior:",
      "  - Optional version bump with npm version --no-git-tag-version",
      "  - Creates an npm tarball under ./artifacts",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const args = { bump: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--bump") {
      const level = argv[i + 1];
      if (!level || !["patch", "minor", "major"].includes(level)) {
        throw new Error("--bump requires one of: patch, minor, major");
      }
      args.bump = level;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (args.bump) {
    runNpm(["version", args.bump, "--no-git-tag-version"], { stdio: "inherit" });
  }

  const artifactsDir = resolve(process.cwd(), "artifacts");
  if (!existsSync(artifactsDir)) {
    mkdirSync(artifactsDir, { recursive: true });
  }

  const packJson = runNpm(["pack", "--pack-destination", artifactsDir, "--json"]);
  const parsed = JSON.parse(packJson);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const fileName = first?.filename;
  if (!fileName) {
    throw new Error("Could not determine packed file name from npm pack output");
  }

  const artifactPath = join(artifactsDir, fileName);
  const version = readPackageVersion();

  process.stdout.write(`\nRelease artifact created:\n${artifactPath}\n`);
  process.stdout.write(`Current package version: ${version}\n\n`);
  process.stdout.write("Install on target host with:\n");
  process.stdout.write(`openclaw plugins install \"${artifactPath}\"\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`release-pack failed: ${error.message}\n`);
  process.exit(1);
}
