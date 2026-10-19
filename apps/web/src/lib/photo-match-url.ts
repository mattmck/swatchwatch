import type { ColorFamily, MatchScope, PolishImageMatchRequest } from "swatchwatch-shared";
import { isMatchScope } from "swatchwatch-shared";
import { parseColorFamilyParam } from "@/lib/color-family-filter";
import { normalizePaletteHex, type PaletteSelection } from "@/lib/photo-match";
import type { ReadableParams } from "@/lib/polish-list-url";

/**
 * URL state for `/polishes/match` (#105), in the style of `polish-list-url.ts`.
 *
 * The photo itself never goes in the URL (it stays in memory, see `photo-match-session.ts`);
 * the URL carries everything else so a browser back from a polish detail page restores the
 * same view:
 *
 * | param    | meaning                                                  | default   |
 * |----------|----------------------------------------------------------|-----------|
 * | `scope`  | `owned` · `wishlist` · `catalog`                         | `owned`   |
 * | `finish` | one finish name                                          | any       |
 * | `family` | comma list of color families                             | any       |
 * | `view`   | `colors` (grouped per palette color) · `list` (flat)     | `colors`  |
 * | `all`    | `1` = show background / skin colors                      | hidden    |
 * | `drop`   | comma list of hexes (no `#`) removed from matching       | none      |
 * | `keep`   | comma list of default-hidden hexes added back            | none      |
 */

export type MatchView = "colors" | "list";

export interface PhotoMatchUrlState {
  scope: MatchScope;
  /** One finish name, or "all". */
  finish: string;
  families: ColorFamily[];
  view: MatchView;
  palette: PaletteSelection;
}

export const DEFAULT_PHOTO_MATCH_STATE: PhotoMatchUrlState = {
  scope: "owned",
  finish: "all",
  families: [],
  view: "colors",
  palette: { showAll: false, drop: [], keep: [] },
};

/** Max hexes read from `drop` / `keep` (the palette has at most 10 colors). */
const MAX_HEX_PARAMS = 10;

function parseHexList(value: string | null): string[] {
  if (!value) return [];
  const out = new Set<string>();
  for (const part of value.split(",")) {
    const hex = normalizePaletteHex(part);
    if (hex) out.add(hex);
    if (out.size >= MAX_HEX_PARAMS) break;
  }
  return [...out];
}

function serializeHexList(hexes: readonly string[]): string {
  return [...new Set(hexes.map(normalizePaletteHex).filter((hex): hex is string => hex !== null))]
    .map((hex) => hex.slice(1))
    .join(",");
}

export function parsePhotoMatchState(params: ReadableParams): PhotoMatchUrlState {
  const scope = params.get("scope")?.trim().toLowerCase();
  const finish = params.get("finish")?.trim();
  const all = params.get("all")?.trim().toLowerCase();
  return {
    scope: isMatchScope(scope) ? scope : "owned",
    finish: !finish || finish.toLowerCase() === "all" ? "all" : finish,
    families: parseColorFamilyParam(params.get("family")),
    view: params.get("view") === "list" ? "list" : "colors",
    palette: {
      showAll: all === "1" || all === "true",
      drop: parseHexList(params.get("drop")),
      keep: parseHexList(params.get("keep")),
    },
  };
}

/** Canonical query string (defaults omitted). */
export function buildPhotoMatchQueryString(state: PhotoMatchUrlState): string {
  const params = new URLSearchParams();
  if (state.scope !== "owned") params.set("scope", state.scope);
  if (state.finish !== "all") params.set("finish", state.finish);
  const families = parseColorFamilyParam(state.families.join(","));
  if (families.length > 0) params.set("family", families.join(","));
  if (state.view !== "colors") params.set("view", state.view);
  if (state.palette.showAll) params.set("all", "1");
  const drop = serializeHexList(state.palette.drop);
  if (drop) params.set("drop", drop);
  const keep = serializeHexList(state.palette.keep);
  if (keep) params.set("keep", keep);
  return params.toString();
}

/** Request options for the server-side filters (scope, finish, family). */
export function toMatchRequestOptions(
  state: Pick<PhotoMatchUrlState, "scope" | "finish" | "families">
): Omit<PolishImageMatchRequest, "image"> {
  return {
    scope: state.scope,
    ...(state.finish !== "all" ? { finishes: [state.finish] } : {}),
    ...(state.families.length > 0 ? { families: [...state.families] } : {}),
  };
}

/** Stable key of the server-side filters: a new key means the photo must be matched again. */
export function matchRequestKey(state: Pick<PhotoMatchUrlState, "scope" | "finish" | "families">): string {
  const families = parseColorFamilyParam(state.families.join(","));
  return [state.scope, state.finish.toLowerCase(), families.join(",")].join("|");
}

/** True when a server-side filter (finish, family) is narrowing the results. */
export function hasMatchFilters(state: Pick<PhotoMatchUrlState, "finish" | "families">): boolean {
  return state.finish !== "all" || state.families.length > 0;
}
