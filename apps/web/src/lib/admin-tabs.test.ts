import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN_TABS, buildAdminTabSearch, getTabFromQuery } from "./admin-tabs";

describe("getTabFromQuery", () => {
  it("returns each known tab unchanged", () => {
    for (const tab of ADMIN_TABS) {
      assert.equal(getTabFromQuery(tab), tab);
    }
  });

  it("falls back to configuration for missing or unknown values", () => {
    assert.equal(getTabFromQuery(null), "configuration");
    assert.equal(getTabFromQuery(""), "configuration");
    assert.equal(getTabFromQuery("nope"), "configuration");
    assert.equal(getTabFromQuery("USERS"), "configuration");
  });
});

describe("buildAdminTabSearch", () => {
  it("sets the tab on an empty query", () => {
    assert.equal(buildAdminTabSearch("", "users"), "?tab=users");
  });

  it("replaces an existing tab and keeps other params", () => {
    assert.equal(buildAdminTabSearch("?tab=users&debug=1", "job-runs"), "?tab=job-runs&debug=1");
  });
});
