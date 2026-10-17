import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ShadeReviewItem, ShadeReviewListResponse, ShadeReviewMergeCandidate } from "swatchwatch-shared";
import {
  approveFormFromItem,
  buildApprovePayload,
  buildComparisonRows,
  describeColorDistance,
  formatSimilarity,
  loadReviewQueueState,
  mergeConfirmationMessage,
  runReviewAction,
  validateApproveForm,
} from "../app/(admin)/admin/reference-data/components/review-queue-tab";

function buildItem(overrides: Partial<ShadeReviewItem> = {}): ShadeReviewItem {
  return {
    shadeId: "500",
    brandId: "1",
    brand: "OPI",
    name: "Big Aple Red",
    finish: "creme",
    finishes: ["creme"],
    collection: null,
    colorName: null,
    vendorHex: "#C4113C",
    detectedHex: null,
    nameHex: null,
    displayHex: "#C4113C",
    displaySource: "vendor",
    createdAt: "2026-10-01T00:00:00.000Z",
    createdByUserId: 7,
    submitterCount: 2,
    reviewStatus: null,
    reviewedAt: null,
    reviewedByUserId: null,
    reviewNote: null,
    candidates: [],
    ...overrides,
  };
}

function buildCandidate(overrides: Partial<ShadeReviewMergeCandidate> = {}): ShadeReviewMergeCandidate {
  return {
    shadeId: "100",
    brand: "OPI",
    name: "Big Apple Red",
    finishes: ["creme"],
    collection: null,
    colorName: null,
    vendorHex: "#c4113c",
    detectedHex: "#C5123D",
    nameHex: null,
    displayHex: "#c4113c",
    displaySource: "vendor",
    similarity: 0.857,
    nameSimilarity: 0.8,
    sameBrand: true,
    colorDistance: 0,
    inventoryCount: 12,
    swatchImageUrl: null,
    ...overrides,
  };
}

describe("ReviewQueueTab helpers", () => {
  it("buildApprovePayload sends nothing when the form is unchanged", () => {
    const item = buildItem();
    assert.deepEqual(buildApprovePayload(item, approveFormFromItem(item)), {});
  });

  it("buildApprovePayload sends only edited fields, normalizing hexes and clearing with null", () => {
    const item = buildItem({ collection: "Fall 2026", nameHex: "#111111" });
    const form = {
      ...approveFormFromItem(item),
      name: " Big Apple Red ",
      finishes: ["creme", "shimmer"],
      collection: "  ",
      vendorHex: "aabbcc",
      nameHex: "#111111",
      note: " typo ",
    };
    assert.deepEqual(buildApprovePayload(item, form), {
      name: "Big Apple Red",
      finishes: ["creme", "shimmer"],
      collection: null,
      vendorHex: "#AABBCC",
      note: "typo",
    });
  });

  it("validateApproveForm rejects empty identity fields and malformed hexes", () => {
    const form = approveFormFromItem(buildItem());
    assert.equal(validateApproveForm(form), null);
    assert.match(validateApproveForm({ ...form, brand: " " }) ?? "", /Brand/);
    assert.match(validateApproveForm({ ...form, name: "" }) ?? "", /Name/);
    assert.match(validateApproveForm({ ...form, vendorHex: "red" }) ?? "", /Vendor hex/);
    assert.equal(validateApproveForm({ ...form, nameHex: "" }), null);
  });

  it("buildComparisonRows flags differing fields case-insensitively", () => {
    const rows = buildComparisonRows(buildItem(), buildCandidate());
    const byField = Object.fromEntries(rows.map((row) => [row.field, row]));
    assert.equal(byField.brand.differs, false);
    assert.equal(byField.name.differs, true);
    assert.equal(byField.vendorHex.differs, false, "hex case must not count as a difference");
    assert.equal(byField.detectedHex.differs, true);
    assert.equal(byField.finishes.submission, "creme");
    assert.ok(buildComparisonRows(buildItem(), null).every((row) => !row.differs));
  });

  it("mergeConfirmationMessage names both shades, the affected users and irreversibility", () => {
    const message = mergeConfirmationMessage(buildItem(), buildCandidate());
    assert.match(message, /Big Aple Red[\s\S]*#500[\s\S]*Big Apple Red[\s\S]*#100/);
    assert.match(message, /2 users' inventory/);
    assert.match(message, /cannot be undone/);
    assert.match(mergeConfirmationMessage(buildItem({ submitterCount: 1 }), buildCandidate()), /1 user's inventory/);
  });

  it("formats similarity and color distance", () => {
    assert.equal(formatSimilarity(0.857), "86%");
    assert.equal(formatSimilarity(1.4), "100%");
    assert.equal(describeColorDistance(null), "no hex to compare");
    assert.match(describeColorDistance(0.01), /same color/);
    assert.match(describeColorDistance(0.2), /different/);
  });

  it("loadReviewQueueState sets loading/error/response", async () => {
    const loading: boolean[] = [];
    const errors: Array<string | null> = [];
    let response: ShadeReviewListResponse | null = null;
    const page: ShadeReviewListResponse = { items: [buildItem()], total: 1, page: 1, pageSize: 25, state: "pending" };
    await loadReviewQueueState({
      listQueue: async (params) => {
        assert.deepEqual(params, { state: "pending", page: 1, q: "", pageSize: 25 });
        return page;
      },
      request: { state: "pending", page: 1, q: "" },
      isMounted: () => true,
      setIsLoading: (value) => loading.push(value),
      setLoadError: (value) => errors.push(value),
      setResponse: (value) => {
        response = value;
      },
    });
    assert.deepEqual(loading, [true, false]);
    assert.deepEqual(errors, [null]);
    assert.equal(response, page);

    const failedErrors: Array<string | null> = [];
    await loadReviewQueueState({
      listQueue: async () => {
        throw new Error("boom");
      },
      request: { state: "rejected", page: 2, q: "x" },
      isMounted: () => true,
      setIsLoading: () => {},
      setLoadError: (value) => failedErrors.push(value),
      setResponse: () => assert.fail("must not set a response on failure"),
    });
    assert.deepEqual(failedErrors, [null, "boom"]);
  });

  it("runReviewAction stops when the confirmation is declined", async () => {
    let called = false;
    const ran = await runReviewAction({
      confirm: () => false,
      action: async () => {
        called = true;
        return { message: "merged" };
      },
      setPending: () => assert.fail("no pending state when declined"),
      setError: () => {},
      setNotice: () => {},
      refresh: async () => assert.fail("no refresh when declined"),
    });
    assert.equal(ran, false);
    assert.equal(called, false);
  });

  it("runReviewAction reports success and refreshes, or surfaces the API error", async () => {
    const notices: Array<string | null> = [];
    const pending: boolean[] = [];
    let refreshed = 0;
    assert.equal(
      await runReviewAction({
        confirm: () => true,
        action: async () => ({ message: "Merged shade 500 into 100" }),
        setPending: (value) => pending.push(value),
        setError: () => {},
        setNotice: (value) => notices.push(value),
        refresh: async () => {
          refreshed += 1;
        },
      }),
      true
    );
    assert.deepEqual(notices, [null, "Merged shade 500 into 100"]);
    assert.deepEqual(pending, [true, false]);
    assert.equal(refreshed, 1);

    const errors: Array<string | null> = [];
    assert.equal(
      await runReviewAction({
        action: async () => {
          throw new Error("An active shade with the same brand and name already exists; merge instead");
        },
        setPending: () => {},
        setError: (value) => errors.push(value),
        setNotice: () => {},
        refresh: async () => assert.fail("no refresh on failure"),
      }),
      false
    );
    assert.deepEqual(errors, [null, "An active shade with the same brand and name already exists; merge instead"]);
  });
});
