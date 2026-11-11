import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminBrandListItem, AdminSourceListItem } from "swatchwatch-shared";
import {
  brandProfileForm,
  changedProfileFields,
  createReadGuard,
  filterBrands,
  filterSites,
  historyDetail,
  sortBrands,
  sortSites,
} from "./sources-admin-view";
import { DEFAULT_SOURCES_ADMIN_STATE, type SourcesAdminState } from "./sources-admin-url";

const state = (o: Partial<SourcesAdminState>): SourcesAdminState => ({ ...DEFAULT_SOURCES_ADMIN_STATE, ...o });

function site(id: number, o: Partial<AdminSourceListItem> = {}): AdminSourceListItem {
  return {
    dataSourceId: id, name: `Src${id}`, displayName: `Site ${id}`, baseUrl: `https://s${id}.example`,
    kind: "brand", connector: "Shopify", fetchable: true, enabled: false,
    needsStoreOk: true, permission: { status: "not_asked" }, permissionStored: false, onWithoutOk: false,
    imagesPermitted: false, currency: null, termsScrapingClause: null, termsCheckedAt: null,
    lastJob: null, liveListings: 0, shades: 0, ...o,
  };
}

function brand(id: number, o: Partial<AdminBrandListItem> = {}): AdminBrandListItem {
  return {
    brandId: id, name: `Brand ${id}`, colorShades: 0, otherShades: 0, ownStores: [], retailers: [],
    supply: "none", profile: null, latestIngestAt: null, ...o,
  };
}

const job = (startedAt: string | null) => ({ jobId: "j", status: "succeeded" as const, startedAt, finishedAt: null, recordsProcessed: 1 });

describe("filterSites", () => {
  it("combines kind, enabled, permission and q", () => {
    const items = [
      site(1, { kind: "retailer", enabled: true, permission: { status: "granted" } }),
      site(2, { kind: "retailer", enabled: false, permission: { status: "granted" } }),
      site(3, { kind: "brand", enabled: true, permission: { status: "granted" } }),
      site(4, { kind: "retailer", enabled: true, permission: { status: "asked" } }),
    ];
    const out = filterSites(items, state({ kind: "retailer", enabled: "on", permission: ["granted"], q: "SITE" }));
    assert.deepEqual(out.map((i) => i.dataSourceId), [1]);
  });

  it("matches q on name and baseUrl", () => {
    const items = [site(1, { name: "ILNPShopify" }), site(2, { baseUrl: "https://ilnp.com" }), site(3)];
    assert.deepEqual(filterSites(items, state({ q: "ilnp" })).map((i) => i.dataSourceId), [1, 2]);
  });
});

describe("filterBrands", () => {
  it("supply=own returns own and both", () => {
    const items = [brand(1, { supply: "own" }), brand(2, { supply: "both" }), brand(3, { supply: "retailer" }), brand(4)];
    assert.deepEqual(filterBrands(items, state({ view: "brands", supply: "own" })).map((i) => i.brandId), [1, 2]);
    assert.deepEqual(filterBrands(items, state({ supply: "retailer" })).map((i) => i.brandId), [3]);
  });
});

describe("sortSites", () => {
  it("puts never-run sources last in both directions", () => {
    const items = [
      site(1, { lastJob: null }),
      site(2, { lastJob: job("2026-11-01T00:00:00Z") }),
      site(3, { lastJob: job("2026-11-05T00:00:00Z") }),
    ];
    assert.deepEqual(sortSites(items, "lastJob", "desc").map((i) => i.dataSourceId), [3, 2, 1]);
    assert.deepEqual(sortSites(items, "lastJob", "asc").map((i) => i.dataSourceId), [2, 3, 1]);
  });

  it("sorts permission by status order and enabled on first", () => {
    const items = [
      site(1, { permission: { status: "declined" } }),
      site(2, { permission: { status: "not_needed" } }),
      site(3, { permission: { status: "granted" }, enabled: true }),
    ];
    assert.deepEqual(sortSites(items, "permission", "asc").map((i) => i.dataSourceId), [2, 3, 1]);
    assert.deepEqual(sortSites(items, "enabled", "asc")[0].dataSourceId, 3);
  });

  it("breaks ties on display name", () => {
    const items = [site(2, { shades: 5 }), site(1, { shades: 5 })];
    assert.deepEqual(sortSites(items, "shades", "desc").map((i) => i.dataSourceId), [1, 2]);
  });
});

describe("sortBrands", () => {
  it("sorts shades by total, blocker with nulls last, ownStore by count then name", () => {
    const ref = (n: string) => ({ dataSourceId: 1, displayName: n, kind: "brand" as const, enabled: true, permissionStatus: "granted" as const, link: "explicit" as const });
    const items = [
      brand(1, { colorShades: 1, otherShades: 1, ownStores: [ref("Zed")], profile: { websiteUrl: null, platform: null, blocker: "B", notes: null, ownDataSourceId: null, updatedAt: null } }),
      brand(2, { colorShades: 5, ownStores: [ref("Alpha")] }),
      brand(3, { colorShades: 0 }),
    ];
    assert.deepEqual(sortBrands(items, "shades", "desc").map((i) => i.brandId), [2, 1, 3]);
    assert.deepEqual(sortBrands(items, "blocker", "desc").map((i) => i.brandId), [1, 2, 3]);
    assert.deepEqual(sortBrands(items, "ownStore", "asc").map((i) => i.brandId), [3, 2, 1]);
  });
});

describe("historyDetail", () => {
  it("is empty without an override or a status change", () => {
    assert.equal(historyDetail({}), "");
    assert.equal(historyDetail({ enabled: { from: false, to: true } }), "");
    assert.equal(
      historyDetail({ permission: { from: { status: "asked", askedAt: "a" }, to: { status: "asked", askedAt: "b" } } }),
      "",
    );
  });

  it("shows the override and the permission status change", () => {
    assert.equal(historyDetail({ override: true, permissionStatus: "asked" }), ": turned on without an OK");
    assert.equal(
      historyDetail({ permission: { from: null, to: { status: "granted" } } }),
      ": permission none → granted",
    );
    assert.equal(
      historyDetail({ override: true, permission: { from: { status: "asked" }, to: { status: "declined" } } }),
      ": turned on without an OK, permission asked → declined",
    );
  });
});

describe("changedProfileFields", () => {
  const opened = { websiteUrl: "https://a.example", platform: "shopify" as const, blocker: null, notes: "old notes", ownDataSourceId: 4, updatedAt: null };

  it("sends nothing for an untouched form and only the edited keys otherwise", () => {
    assert.deepEqual(changedProfileFields(opened, brandProfileForm(opened)), {});
    const form = { ...brandProfileForm(opened), blocker: "  Behind Cloudflare ", ownDataSourceId: "none" };
    assert.deepEqual(changedProfileFields(opened, form), { blocker: "Behind Cloudflare", ownDataSourceId: null });
    assert.deepEqual(changedProfileFields(null, { ...brandProfileForm(null), platform: "custom" }), { platform: "custom" });
  });

  it("two saves around another admin's notes edit never send the old notes back", () => {
    // Save 1 edits the blocker; the response carries notes another admin saved meanwhile.
    const first = changedProfileFields(opened, { ...brandProfileForm(opened), blocker: "No feed" });
    assert.deepEqual(first, { blocker: "No feed" });
    const saved = { ...opened, blocker: "No feed", notes: "their notes" };
    // The panel refills the form and the baseline from the response; save 2 edits the website.
    const second = changedProfileFields(saved, { ...brandProfileForm(saved), websiteUrl: "https://b.example" });
    assert.deepEqual(second, { websiteUrl: "https://b.example" });
    // Comparing the stale form against a refreshed profile instead would have sent "old notes".
    assert.deepEqual(changedProfileFields(saved, brandProfileForm(opened)).notes, "old notes");
  });
});

describe("createReadGuard", () => {
  it("drops a poll that started during a write and returned after it", () => {
    const guard = createReadGuard();
    guard.invalidate(); // write starts
    const pollIsCurrent = guard.beginRead(); // poll starts while the write is in flight
    guard.invalidate(); // write succeeds and is applied
    assert.equal(pollIsCurrent(), false);
  });

  it("keeps a read when no write happened, drops one begun before a write", () => {
    const guard = createReadGuard();
    const read = guard.beginRead();
    assert.equal(read(), true);
    const before = guard.beginRead();
    guard.invalidate();
    assert.equal(before(), false);
    assert.equal(guard.beginRead()(), true);
  });
});
