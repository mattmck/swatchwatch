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

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const pattern = (anchored ? rule.slice(0, -1) : rule)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
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
