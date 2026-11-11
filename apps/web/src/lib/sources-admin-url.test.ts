import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSourcesAdminSearch, parseSourcesAdminState, type SourcesAdminState } from "./sources-admin-url";

describe("sources admin URL state", () => {
  it("round trips every field", () => {
    const s: SourcesAdminState = {
      view: "brands",
      q: "ilnp",
      kind: "retailer",
      enabled: "on",
      permission: ["asked", "granted"],
      supply: "own",
      sort: "latestIngest",
      dir: "desc",
      open: 12,
    };
    const search = buildSourcesAdminSearch("?tab=sources", s);
    assert.match(search, /^\?tab=sources/);
    assert.deepEqual(parseSourcesAdminState(new URLSearchParams(search)), s);
  });

  it("writes nothing for defaults and keeps other params", () => {
    const d = parseSourcesAdminState(new URLSearchParams(""));
    assert.equal(buildSourcesAdminSearch("?tab=sources", d), "?tab=sources");
    assert.equal(buildSourcesAdminSearch("?tab=sources&x=1&kind=feed", d), "?tab=sources&x=1");
  });

  it("writes permission in tuple order", () => {
    const d = parseSourcesAdminState(new URLSearchParams(""));
    const search = buildSourcesAdminSearch("", { ...d, permission: ["granted", "asked"] });
    assert.equal(search, "?permission=asked%2Cgranted");
  });

  it("drops garbage and keeps valid values", () => {
    const p = new URLSearchParams("view=x&kind=shop&enabled=maybe&permission=granted,bogus,asked&sort=nope&dir=up&open=abc");
    assert.deepEqual(parseSourcesAdminState(p), {
      view: "sites", q: "", kind: null, enabled: null, permission: ["asked", "granted"],
      supply: null, sort: "site", dir: "asc", open: null,
    });
  });

  it("falls back when the sort key belongs to the other view", () => {
    assert.equal(parseSourcesAdminState(new URLSearchParams("view=sites&sort=blocker")).sort, "site");
    assert.equal(parseSourcesAdminState(new URLSearchParams("view=brands&sort=kind")).sort, "brand");
  });

  it("rejects non-positive open", () => {
    assert.equal(parseSourcesAdminState(new URLSearchParams("open=0")).open, null);
    assert.equal(parseSourcesAdminState(new URLSearchParams("open=-3")).open, null);
  });
});
