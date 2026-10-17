#!/usr/bin/env node
// PostToolUse hook (Edit|Write|MultiEdit): after a change under
// packages/shared/src, rebuild swatchwatch-shared so the functions and web
// workspaces (which resolve its built dist/) see the new types instead of
// producing confusing stale-type errors.
//
// Scope: this only sees the file-edit tools. Shared sources changed through
// Bash (sed -i, git checkout, etc.) do not trigger a rebuild; run
// `npm run build:shared` yourself after those.
//
// Exit 2 = surface tsc errors to Claude; exit 0 otherwise.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readHookInput, resolveCheckout } from "./lib.mjs";

const input = readHookInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || !filePath) process.exit(0);

// Build in the checkout that owns the edited file (the active worktree), which
// can differ from CLAUDE_PROJECT_DIR after the session enters a worktree.
const { root, rel } = resolveCheckout(input, filePath);

if (!rel.startsWith("packages/shared/src/")) process.exit(0);

if (!existsSync(path.join(root, "node_modules"))) {
  process.stderr.write(
    "packages/shared changed but node_modules is missing in this checkout; run `npm ci` then `npm run build:shared`.\n"
  );
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build:shared"], {
  cwd: root,
  encoding: "utf8",
  timeout: 90_000,
});

if (result.status !== 0) {
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n");
  process.stderr.write(`npm run build:shared failed after editing ${rel}:\n${out}\n`);
  process.exit(2);
}

process.exit(0);
