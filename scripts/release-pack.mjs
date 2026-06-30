#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args, options = {}) {
  return execFileSync(npmCmd, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    ...options,
  });
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
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

function syncPluginManifestVersion(version) {
  const manifestPath = resolve(process.cwd(), "openclaw.plugin.json");
  if (!existsSync(manifestPath)) {
    return false;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version === version) {
    return true;
  }
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return true;
}

function assertGitCleanWorkingTree() {
  const status = runGit(["status", "--porcelain"]).trim();
  if (status) {
    throw new Error("git working tree must be clean before a tagged release");
  }
}

function ensureTagDoesNotExist(tagName) {
  try {
    const existing = runGit(["tag", "-l", tagName]).trim();
    if (existing === tagName) {
      throw new Error(`git tag already exists: ${tagName}`);
    }
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) {
      throw error;
    }
    // git tag -l should not fail normally; if it does, bubble up.
    throw error;
  }
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/release-pack.mjs [--bump patch|minor|major] [--tag|--no-tag]",
      "",
      "Examples:",
      "  node scripts/release-pack.mjs",
      "  node scripts/release-pack.mjs --bump patch",
      "  node scripts/release-pack.mjs --bump patch --no-tag",
      "",
      "Behavior:",
      "  - Optional version bump with npm version --no-git-tag-version",
      "  - When bumping, creates a release commit and annotated git tag by default",
      "  - Creates an npm tarball under ./artifacts",
    ].join("\n") + "\n",
  );
}

function parseArgs(argv) {
  const args = { bump: null, tag: null };
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
    if (arg === "--tag") {
      args.tag = true;
      continue;
    }
    if (arg === "--no-tag") {
      args.tag = false;
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

  const shouldTag = args.bump ? args.tag !== false : args.tag === true;

  if (shouldTag) {
    assertGitCleanWorkingTree();
  }

  if (args.bump) {
    runNpm(["version", args.bump, "--no-git-tag-version"], { stdio: "inherit" });
    syncPluginManifestVersion(readPackageVersion());
  }

  const version = readPackageVersion();
  const tagName = `v${version}`;

  if (shouldTag) {
    ensureTagDoesNotExist(tagName);
    runGit(["add", "package.json"], { stdio: "inherit" });
    if (existsSync(resolve(process.cwd(), "openclaw.plugin.json"))) {
      runGit(["add", "openclaw.plugin.json"], { stdio: "inherit" });
    }
    runGit(["commit", "-m", `chore(release): ${tagName}`], { stdio: "inherit" });
    runGit(["tag", "-a", tagName, "-m", tagName], { stdio: "inherit" });
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
  process.stdout.write(`\nRelease artifact created:\n${artifactPath}\n`);
  process.stdout.write(`Current package version: ${version}\n\n`);
  if (shouldTag) {
    process.stdout.write(`Created git tag: ${tagName}\n\n`);
    process.stdout.write("Push release commit and tag with:\n");
    process.stdout.write("git push origin main --follow-tags\n\n");
  }
  process.stdout.write("Install on target host with:\n");
  process.stdout.write(`openclaw plugins install \"${artifactPath}\"\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`release-pack failed: ${error.message}\n`);
  process.exit(1);
}
