// Shared helpers for the Claude Code hooks in this directory.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Parse the hook JSON from stdin; null when missing or malformed (hooks must never block on bad input). */
export function readHookInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Locate the git checkout that owns the edited file and the file's path inside it.
 *
 * CLAUDE_PROJECT_DIR stays at the original checkout when a session moves into a
 * git worktree, so the checkout is derived from the file itself rather than from
 * that variable. Falls back to the project dir when the file is not in a git repo.
 */
export function resolveCheckout(input, filePath) {
  const fallbackDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const abs = path.resolve(input.cwd || fallbackDir, filePath);

  // The file (or even its directory) may not exist yet when it is about to be created.
  let dir = path.dirname(abs);
  while (!existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const realAbs = path.join(realpathSync(dir), path.relative(dir, abs));

  let root;
  try {
    root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    root = realpathSync(fallbackDir);
  }

  const rel = path.relative(root, realAbs).split(path.sep).join("/");
  return { root, rel, abs: realAbs };
}
