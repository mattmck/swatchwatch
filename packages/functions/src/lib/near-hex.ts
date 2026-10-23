import { hexToOklab } from "swatchwatch-shared";

/** Most target colors one `?nearHex=` request may rank against (a harmony palette plus its source). */
export const NEAR_HEX_MAX_TARGETS = 24;

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

export type NearHexFilterResult =
  | { ok: true; targets: string[] }
  | { ok: false; error: string; invalid: string[] };

/**
 * Parse the `nearHex` query parameter of `GET /api/polishes`: one or more 6-digit hexes, with
 * or without `#` (send `%23` or leave it out), comma-separated and/or repeated. Returns the
 * deduplicated targets as uppercase `#RRGGBB`, sorted (the distance is the minimum over all of
 * them, so order does not matter and the cache key stays stable), an empty list when the
 * parameter is absent/blank, or an error naming the bad values (callers answer 400).
 */
export function parseNearHexFilter(searchParams: URLSearchParams): NearHexFilterResult {
  const targets = new Set<string>();
  const invalid: string[] = [];

  for (const raw of searchParams.getAll("nearHex")) {
    for (const part of raw.split(",")) {
      const value = part.trim();
      if (!value) continue;
      const match = HEX_PATTERN.exec(value);
      if (match) {
        targets.add(`#${match[1].toUpperCase()}`);
      } else {
        invalid.push(value);
      }
    }
  }

  if (invalid.length > 0) {
    return {
      ok: false,
      invalid,
      error: `Invalid nearHex: ${invalid.join(", ")}. Expected 6-digit hex colors such as E0457B or #E0457B`,
    };
  }
  if (targets.size > NEAR_HEX_MAX_TARGETS) {
    return {
      ok: false,
      invalid: [],
      error: `nearHex accepts at most ${NEAR_HEX_MAX_TARGETS} colors (got ${targets.size})`,
    };
  }

  return { ok: true, targets: [...targets].sort() };
}

/**
 * SQL expression for the OKLAB distance from shade `s` (its stored display-hex OKLAB,
 * `shade.oklab_l/a/b`, migration 20261023001520034_shade-display-oklab) to the nearest target.
 * NULL when the shade has no usable display hex. Target coordinates come from the shared
 * `hexToOklab`, so the value equals `colorDistance(resolveDisplayHex(polish), target)`.
 * Placeholders start at `$firstParamIndex`, three per target.
 */
export function buildNearHexDistanceSql(
  targets: string[],
  firstParamIndex: number
): { sql: string; params: number[] } {
  if (targets.length === 0) {
    throw new Error("buildNearHexDistanceSql needs at least one target");
  }
  const params: number[] = [];
  const terms = targets.map((hex, i) => {
    const { L, a, b } = hexToOklab(hex);
    params.push(L, a, b);
    const p = firstParamIndex + i * 3;
    return `sqrt(power(s.oklab_l - $${p}::float8, 2) + power(s.oklab_a - $${p + 1}::float8, 2) + power(s.oklab_b - $${p + 2}::float8, 2))`;
  });
  return { sql: terms.length === 1 ? terms[0] : `LEAST(${terms.join(", ")})`, params };
}
