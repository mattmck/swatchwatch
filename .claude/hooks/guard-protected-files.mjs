#!/usr/bin/env node
// PreToolUse hook (Edit|Write|MultiEdit): blocks edits that should never happen
// from an agent.
//
//  - Migrations already committed to HEAD in packages/functions/migrations/
//    (applied migrations are immutable; add a new one instead). Migrations that
//    are new in the working tree stay editable.
//  - local.settings.json and .env* files (secrets; .env.example is allowed).
//
// Scope: this only sees the file-edit tools. Writes made through Bash (sed -i,
// redirects, etc.) do not trigger it, so it is a guard rail, not a hard boundary.
//
// Exit 2 = block the tool call and show stderr to Claude.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readHookInput, resolveCheckout } from "./lib.mjs";

const input = readHookInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== "string" || !filePath) process.exit(0);

// Resolve against the checkout that owns the file (the active worktree), not
// CLAUDE_PROJECT_DIR, so the HEAD lookup below uses that checkout's history.
const { root, rel, abs } = resolveCheckout(input, filePath);
const base = path.basename(abs);

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

if (base === "local.settings.json" || (base.startsWith(".env") && base !== ".env.example")) {
  block(
    `Blocked: ${rel} holds local secrets. Edit packages/functions/local.settings.json.example ` +
      `(or .env.example) instead and ask the user to update their local copy.`
  );
}

if (/^packages\/functions\/migrations\/[^/]+\.sql$/.test(rel)) {
  let committed = false;
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: root, stdio: "ignore" });
    committed = true;
  } catch {
    committed = false; // new/uncommitted file (or no git): allow
  }
  if (committed) {
    block(
      `Blocked: ${rel} is already committed, so it may have been applied to a database. ` +
        `Never edit an applied migration; create a new one (use the create-migration skill).`
    );
  }
}

process.exit(0);
