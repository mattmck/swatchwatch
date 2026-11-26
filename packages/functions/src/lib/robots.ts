/**
 * A small robots.txt reader for connectors that call a store's API paths (the WooCommerce Store
 * API connector). It answers one question: does robots.txt disallow `path` for our crawler?
 *
 * Scope (deliberately narrow, RFC 9309 subset):
 * - Groups: one or more `User-agent` lines followed by rules; a `User-agent` line after a rule
 *   starts a new group. `#` comments and unknown fields are ignored.
 * - Agent choice: the groups whose `User-agent` names our product token (case-insensitive, e.g.
 *   `SwatchWatch` or `SwatchWatch/1.0`) apply; only when none does, the `*` groups apply.
 * - Rules: a non-empty `Disallow` value disallows every path it is a prefix of (`*` matches any
 *   run of characters, a trailing `$` anchors the end). An empty `Disallow` disallows nothing.
 * - `Allow` lines are NOT read: there is no longest-match precedence, so an `Allow` that would
 *   re-open part of a disallowed prefix still leaves it disallowed (the conservative reading).
 */

export interface RobotsGroup {
  /** Lower-cased `User-agent` values of the group. */
  agents: string[];
  /** Non-empty `Disallow` values, in file order. */
  disallow: string[];
}

/** The groups of a robots.txt body. */
export function parseRobotsTxt(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.replace(/^﻿/, "").split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // A rule before any User-agent line belongs to no group.
    if (field === "disallow" && value) current.disallow.push(value);
  }
  return groups;
}

/**
 * Whether `rule` matches `path`: `*` matches any run of characters (empty included), a trailing
 * `$` anchors the end, and without it the rule only has to match a prefix of the path. An
 * iterative glob match (greedy with one backtrack point, O(rule × path) at worst), so a remote
 * rule with many `*`s can never cause regex backtracking.
 */
function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const pattern = anchored ? rule.slice(0, -1) : rule;
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < path.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      p += 1;
      mark = s;
      continue;
    }
    // The whole rule matched a prefix of the path.
    if (p === pattern.length && !anchored) return true;
    if (p < pattern.length && pattern[p] === path[s]) {
      p += 1;
      s += 1;
      continue;
    }
    if (star >= 0) {
      // Let the last `*` take one more character and retry from there.
      p = star + 1;
      mark += 1;
      s = mark;
      continue;
    }
    return false;
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * True when robots.txt disallows `path` for the crawler whose product token is `agentToken`
 * (see the module comment for the rules read).
 */
export function isPathDisallowed(body: string, agentToken: string, path: string): boolean {
  const groups = parseRobotsTxt(body);
  const token = agentToken.trim().toLowerCase();
  // "SwatchWatch" and "SwatchWatch/1.0" name us; "*" and other crawlers do not.
  const named = groups.filter((group) => group.agents.some((agent) => agent.split("/")[0].trim() === token));
  const applicable = named.length > 0 ? named : groups.filter((group) => group.agents.includes("*"));
  return applicable.some((group) => group.disallow.some((rule) => ruleMatches(rule, path)));
}
