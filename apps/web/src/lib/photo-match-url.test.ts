import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPhotoMatchQueryString,
  DEFAULT_PHOTO_MATCH_STATE,
  hasMatchFilters,
  matchRequestKey,
  parsePhotoMatchState,
  toMatchRequestOptions,
} from "./photo-match-url";

const parse = (query: string) => parsePhotoMatchState(new URLSearchParams(query));

describe("photo-match-url", () => {
  it("parses an empty query to the defaults and writes nothing for them", () => {
    assert.deepEqual(parse(""), DEFAULT_PHOTO_MATCH_STATE);
    assert.equal(buildPhotoMatchQueryString(DEFAULT_PHOTO_MATCH_STATE), "");
  });

  it("round-trips every field canonically", () => {
    const state = parse("scope=Catalog&finish=holo&family=pink,red,gray&view=list&all=1&drop=d01020,%231030c0&keep=E0AC69");
    assert.deepEqual(state, {
      scope: "catalog",
      finish: "holo",
      families: ["red", "pink", "grey"],
      view: "list",
      palette: { showAll: true, drop: ["#D01020", "#1030C0"], keep: ["#E0AC69"] },
    });
    const query = buildPhotoMatchQueryString(state);
    assert.equal(query, "scope=catalog&finish=holo&family=red%2Cpink%2Cgrey&view=list&all=1&drop=D01020%2C1030C0&keep=E0AC69");
    assert.deepEqual(parse(query), state);
  });

  it("falls back on unknown values and ignores invalid hexes", () => {
    const state = parse("scope=everyone&finish=all&view=grid&all=yes&drop=zzz,ABC,D01020,D01020&family=plaid");
    assert.equal(state.scope, "owned");
    assert.equal(state.finish, "all");
    assert.equal(state.view, "colors");
    assert.equal(state.palette.showAll, false);
    assert.deepEqual(state.palette.drop, ["#D01020"]);
    assert.deepEqual(state.families, []);
  });

  it("caps the hex lists", () => {
    const many = Array.from({ length: 20 }, (_, i) => (0x100000 + i).toString(16)).join(",");
    assert.equal(parse(`drop=${many}`).palette.drop.length, 10);
  });

  it("builds request options and a filter key that ignores palette/view state", () => {
    const state = parse("scope=wishlist&finish=Holo&family=red&view=list&drop=D01020");
    assert.deepEqual(toMatchRequestOptions(state), { scope: "wishlist", finishes: ["Holo"], families: ["red"] });
    assert.deepEqual(toMatchRequestOptions(DEFAULT_PHOTO_MATCH_STATE), { scope: "owned" });
    assert.equal(matchRequestKey(state), matchRequestKey(parse("scope=wishlist&finish=holo&family=red")));
    assert.notEqual(matchRequestKey(state), matchRequestKey(parse("scope=catalog&finish=holo&family=red")));
    assert.equal(hasMatchFilters(state), true);
    assert.equal(hasMatchFilters(DEFAULT_PHOTO_MATCH_STATE), false);
  });
});
