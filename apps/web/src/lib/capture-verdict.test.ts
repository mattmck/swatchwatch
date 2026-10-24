import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaptureCheckCandidate, CaptureCheckResponse, Polish, PolishDupe, PolishDupesResponse } from "swatchwatch-shared";
import {
  NEAR_DUPE_OUTCOMES,
  buildOwnershipSnapshot,
  checkedFromNearDupe,
  resolveNearDupeVerdict,
  verdictFromBottleCheck,
  withNearDupes,
  candidateOptionLabel,
  deriveCaptureVerdict,
  ownedEntryAfterVerdict,
  readCaptureDisplay,
  readCaptureEvidence,
  resolveCaptureVerdict,
  withOwnedEntry,
  type CaptureOutcome,
  type CaptureVerdict,
  type CheckedVerdict,
  type VerdictResolver,
} from "./capture-verdict";

function polish(overrides: Partial<Polish>): Polish {
  return {
    id: "10",
    shadeId: "10",
    userId: "1",
    brand: "OPI",
    name: "Big Apple Red",
    color: "Red",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const snapshot = buildOwnershipSnapshot([
  polish({ id: "10", inventoryItemId: "100", quantity: 2, status: "owned", vendorHex: "#C1121F" }),
  polish({ id: "11", inventoryItemId: "101", quantity: 0, status: "wishlist", name: "Wishlisted" }),
  polish({ id: "12", name: "Catalog only" }),
  polish({ id: "13", inventoryItemId: "103", quantity: 1, status: "destash", name: "Destashing" }),
  polish({ id: "14", inventoryItemId: "104", quantity: 1, status: "wishlist", name: "Wishlist with a count" }),
]);

function matched(metadata: Record<string, unknown>, entity?: Partial<CaptureOutcome>): CaptureOutcome {
  return { status: "matched", metadata, ...entity };
}

describe("buildOwnershipSnapshot", () => {
  it("keeps only owned rows (status 'owned' with quantity > 0)", () => {
    assert.deepEqual([...snapshot.keys()], ["100"]);
    assert.deepEqual(snapshot.get("100"), {
      inventoryItemId: "100",
      shadeId: "10",
      brand: "OPI",
      name: "Big Apple Red",
      quantity: 2,
      hex: "#C1121F",
    });
  });

  it("withOwnedEntry adds, updates and removes without mutating", () => {
    const added = withOwnedEntry(snapshot, { inventoryItemId: "200", brand: "", name: "New", quantity: 1 });
    assert.equal(added.size, 2);
    assert.equal(snapshot.size, 1);
    const removed = withOwnedEntry(added, { inventoryItemId: "200", brand: "", name: "New", quantity: 0 });
    assert.equal(removed.has("200"), false);
  });
});

describe("deriveCaptureVerdict", () => {
  it("says 'owned' when the matched inventory row was already owned", () => {
    const verdict = deriveCaptureVerdict(
      matched({ inventoryItemId: 100, resolver: { display: "OPI — SKU 7" } }, { acceptedEntityType: "sku", acceptedEntityId: "7" }),
      snapshot,
    );
    assert.deepEqual(verdict, {
      kind: "owned",
      display: "OPI — Big Apple Red",
      inventoryItemId: "100",
      shadeId: "10",
      previousQuantity: 2,
      quantity: 3,
      hex: "#C1121F",
    });
  });

  it("says 'added' for a match that wasn't owned (wishlist rows don't count as owned)", () => {
    const verdict = deriveCaptureVerdict(
      matched(
        { inventoryItemId: "101", resolver: { topCandidate: "OPI — Wishlisted" } },
        { acceptedEntityType: "shade", acceptedEntityId: "11" },
      ),
      snapshot,
    );
    assert.deepEqual(verdict, {
      kind: "added",
      display: "OPI — Wishlisted",
      inventoryItemId: "101",
      shadeId: "11",
      priorOwnership: "none",
    });
  });

  it("marks prior ownership unknown when the snapshot failed to load", () => {
    const verdict = deriveCaptureVerdict(
      matched({ inventoryItemId: "100" }, { acceptedEntityType: "sku", acceptedEntityId: "7" }),
      null,
      { displayHint: "OPI — Big Apple Red" },
    );
    assert.equal(verdict?.kind, "added");
    assert.equal(verdict?.kind === "added" && verdict.priorOwnership, "unknown");
    assert.equal(verdict?.display, "OPI — Big Apple Red");
    // SKU matches carry no shade id.
    assert.equal(verdict?.kind === "added" && verdict.shadeId, undefined);
  });

  it("says 'add' for an unmatched session, carrying the evidence", () => {
    const verdict = deriveCaptureVerdict(
      {
        status: "unmatched",
        metadata: {
          gtin: "4006381333931",
          resolver: {
            step: "unmatched_after_resolver",
            brand: "Indie Co",
            shadeName: "Galaxy",
            audit: { evidence: { gtin: "4006381333931", brand: "Indie Co", shadeName: "Galaxy" } },
          },
        },
      },
      snapshot,
    );
    assert.deepEqual(verdict, {
      kind: "add",
      display: "Indie Co — Galaxy",
      evidence: { gtin: "4006381333931", brand: "Indie Co", shadeName: "Galaxy" },
    });
  });

  it("returns null while the session is still in progress", () => {
    assert.equal(deriveCaptureVerdict({ status: "processing" }, snapshot), null);
    assert.equal(deriveCaptureVerdict({ status: "needs_question" }, snapshot), null);
    assert.equal(deriveCaptureVerdict({ status: "cancelled" }, snapshot), null);
  });
});

describe("resolveCaptureVerdict (extension point)", () => {
  const outcome = matched({ inventoryItemId: "555", resolver: { display: "Zoya — Pixie" } });

  it("returns the base verdict with no resolvers", async () => {
    const verdict = await resolveCaptureVerdict(outcome, snapshot, { resolvers: [] });
    assert.equal(verdict?.kind, "added");
  });

  it("lets resolvers upgrade the verdict in order and ignores failures", async () => {
    const seen: string[] = [];
    const failing: VerdictResolver = () => {
      throw new Error("dupe service down");
    };
    const rename: VerdictResolver = (verdict) => {
      seen.push(verdict.kind);
      return { ...verdict, display: `${verdict.display} (checked)` } as CaptureVerdict;
    };
    const passThrough: VerdictResolver = async (verdict) => {
      seen.push(verdict.display ?? "");
      return null;
    };
    const verdict = await resolveCaptureVerdict(outcome, snapshot, {
      resolvers: [failing, rename, passThrough],
    });
    assert.equal(verdict?.display, "Zoya — Pixie (checked)");
    assert.deepEqual(seen, ["added", "Zoya — Pixie (checked)"]);
  });

  it("does not run resolvers for unfinished sessions", async () => {
    let called = false;
    const verdict = await resolveCaptureVerdict({ status: "processing" }, snapshot, {
      resolvers: [() => {
        called = true;
        return null;
      }],
    });
    assert.equal(verdict, null);
    assert.equal(called, false);
  });
});

describe("metadata readers", () => {
  it("prefers the resolver display, then the top candidate, then evidence", () => {
    assert.equal(readCaptureDisplay({ resolver: { display: "A", topCandidate: "B" } }), "A");
    assert.equal(readCaptureDisplay({ resolver: { topCandidate: "B" } }), "B");
    assert.equal(readCaptureDisplay({ brand: "OPI", shadeName: "Red" }), "OPI — Red");
    assert.equal(readCaptureDisplay(undefined), undefined);
  });

  it("falls back to session hints for evidence", () => {
    assert.deepEqual(readCaptureEvidence({ brand: "OPI", gtin: "123" }), {
      gtin: "123",
      brand: "OPI",
      shadeName: undefined,
    });
  });

  it("strips the id from candidate options", () => {
    assert.equal(candidateOptionLabel("42: OPI — Big Apple Red"), "OPI — Big Apple Red");
    assert.equal(candidateOptionLabel("skip"), "skip");
  });
});

describe("ownedEntryAfterVerdict", () => {
  it("records owned and added verdicts so a re-scan says 'owned'", () => {
    const owned = deriveCaptureVerdict(matched({ inventoryItemId: "100" }), snapshot)!;
    assert.equal(ownedEntryAfterVerdict(owned)?.quantity, 3);

    const added = deriveCaptureVerdict(matched({ inventoryItemId: "300", resolver: { display: "New" } }), snapshot)!;
    const entry = ownedEntryAfterVerdict(added)!;
    assert.equal(entry.quantity, 1);
    const rescan = deriveCaptureVerdict(matched({ inventoryItemId: "300" }), withOwnedEntry(snapshot, entry));
    assert.equal(rescan?.kind, "owned");
    assert.equal(rescan?.display, "New");
  });

  it("records nothing for an unmatched verdict", () => {
    assert.equal(ownedEntryAfterVerdict({ kind: "add", evidence: {} }), null);
  });
});

describe("near-dupe verdict (#265)", () => {
  const dupe = (grade: "high" | "medium", shadeId = "7"): PolishDupe => ({
    shadeId,
    brand: "OPI",
    name: "Big Apple Red",
    finishes: ["creme"],
    displayHex: "#C1121F",
    displayHexSource: "vendor",
    distance: grade === "high" ? 0.02 : 0.08,
    colorGrade: grade,
    grade,
    finishCompatibility: "same",
  });
  const response = (dupes: PolishDupe[]): PolishDupesResponse => ({
    target: { shadeId: "5", displayHex: "#C0101E", displayHexSource: "vendor", finishes: ["creme"] },
    dupes,
    dupeCount: dupes.length,
    highCount: dupes.filter((d) => d.grade === "high").length,
    candidateCount: 10,
  });
  const checked = (overrides: Partial<CheckedVerdict> = {}): CheckedVerdict => ({
    kind: "checked",
    relationship: "notOwned",
    display: "Zoya — Pixie",
    shadeId: "5",
    gtin: "111",
    hex: "#C0101E",
    ...overrides,
  });

  it("upgrades a not-owned catalog shade with owned dupes", () => {
    const verdict = withNearDupes(checked(), response([dupe("high"), dupe("medium", "8")]));
    assert.equal(verdict.kind, "near_dupe");
    if (verdict.kind !== "near_dupe") return;
    assert.equal(verdict.dupeKind, "dupe-owned");
    assert.equal(verdict.shadeId, "5");
    assert.equal(verdict.hex, "#C0101E");
    assert.equal(verdict.dupes.dupeCount, 2);
    assert.equal(checkedFromNearDupe(verdict).relationship, "notOwned");
  });

  it("grades a MEDIUM-only match as near-dupe-owned", () => {
    const verdict = withNearDupes(checked(), response([dupe("medium")]));
    assert.equal(verdict.kind === "near_dupe" && verdict.dupeKind, "near-dupe-owned");
  });

  it("leaves everything else unchanged", () => {
    assert.equal(withNearDupes(checked(), response([])).kind, "checked");
    assert.equal(withNearDupes(checked(), null).kind, "checked");
    assert.equal(withNearDupes(checked({ relationship: "owned" }), response([dupe("high")])).kind, "checked");
    assert.equal(withNearDupes(checked({ relationship: "wishlisted" }), response([dupe("high")])).kind, "checked");
    assert.equal(withNearDupes(checked({ shadeId: undefined }), response([dupe("high")])).kind, "checked");
    assert.equal(withNearDupes({ kind: "unknown_barcode", gtin: "1" }, response([dupe("high")])).kind, "unknown_barcode");
  });

  it("maps the card choices to the funnel outcomes", () => {
    assert.deepEqual(NEAR_DUPE_OUTCOMES, { cancel: "cancel", wishlist: "wishlist_instead", add_anyway: "add_anyway" });
  });

  it("resolveNearDupeVerdict makes one call and upgrades", async () => {
    let calls = 0;
    const result = await resolveNearDupeVerdict(checked(), {
      suppressed: new Set(),
      loadDupes: async () => {
        calls += 1;
        return response([dupe("high")]);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.verdict.kind, "near_dupe");
    assert.equal(result.answered, true);
  });

  it("resolveNearDupeVerdict marks a no-dupe answer as answered", async () => {
    const result = await resolveNearDupeVerdict(checked(), { suppressed: new Set(), loadDupes: async () => response([]) });
    assert.equal(result.verdict.kind, "checked");
    assert.equal(result.answered, true);
  });

  it("resolveNearDupeVerdict skips owned, wishlisted and suppressed shades without a call", async () => {
    const loadDupes = async (): Promise<PolishDupesResponse> => {
      throw new Error("should not be called");
    };
    const cases: Array<[CheckedVerdict, Set<string>]> = [
      [checked({ relationship: "owned" }), new Set()],
      [checked({ relationship: "wishlisted" }), new Set()],
      [checked(), new Set(["shade:5"])],
    ];
    for (const [verdict, suppressed] of cases) {
      const result = await resolveNearDupeVerdict(verdict, { suppressed, loadDupes });
      assert.equal(result.verdict.kind, "checked");
      assert.equal(result.answered, false);
      assert.equal(result.failure, undefined);
    }
  });

  it("resolveNearDupeVerdict never blocks on a failed or slow lookup", async () => {
    const failed = await resolveNearDupeVerdict(checked(), {
      suppressed: new Set(),
      loadDupes: async () => {
        throw new Error("500");
      },
    });
    assert.equal(failed.verdict.kind, "checked");
    assert.equal(failed.failure?.reason, "error");
    assert.equal(failed.answered, false);
    const slow = await resolveNearDupeVerdict(checked(), {
      suppressed: new Set(),
      timeoutMs: 5,
      loadDupes: () => new Promise<PolishDupesResponse>(() => undefined),
    });
    assert.equal(slow.failure?.reason, "timeout");
  });
});

describe("verdictFromBottleCheck", () => {
  function candidate(id: string, overrides: Partial<CaptureCheckCandidate> = {}): CaptureCheckCandidate {
    return {
      entityType: "shade",
      entityId: id,
      shadeId: id,
      display: `Brand — Shade ${id}`,
      confidence: 0.6,
      ownership: { relationship: "notOwned" },
      ...overrides,
    };
  }
  function check(overrides: Partial<CaptureCheckResponse>): CaptureCheckResponse {
    return {
      captureId: "cap-1",
      status: "processing",
      outcome: "unmatched",
      confidence: 0,
      candidates: [],
      ...overrides,
    };
  }
  const evidence = { brand: "Loud Lacquer", shadeName: "Mango" };

  it("turns an owned match into a checked verdict with no barcode", () => {
    const match = candidate("7", { ownership: { relationship: "owned", quantity: 2 }, hex: "#ff8800" });
    const verdict = verdictFromBottleCheck(
      check({ outcome: "matched", match, candidates: [match] }),
      { afterNoneOfThese: false, evidence },
    );
    assert.equal(verdict.kind, "checked");
    if (verdict.kind !== "checked") return;
    assert.equal(verdict.relationship, "owned");
    assert.equal(verdict.quantity, 2);
    assert.equal(verdict.hex, "#ff8800");
    assert.equal(verdict.shadeId, "7");
    assert.equal(verdict.display, "Brand — Shade 7");
    assert.equal(verdict.gtin, "");
  });

  it("offers a pick of up to five candidates with a shade and copies the brand conflict", () => {
    const brandConflict = {
      hinted: { brandId: null, name: "Loud", source: "hint" as const },
      read: { brandId: "9", name: "Loud Lacquer", source: "read" as const },
    };
    const candidates = [
      candidate("1"),
      candidate("2"),
      candidate("3"),
      candidate("4", { shadeId: null, entityType: "sku" }),
    ];
    const verdict = verdictFromBottleCheck(
      check({ outcome: "needs_question", questionKey: "candidate_select", candidates, brandConflict }),
      { afterNoneOfThese: false, evidence },
    );
    assert.equal(verdict.kind, "pick");
    if (verdict.kind !== "pick") return;
    assert.deepEqual(verdict.candidates.map((c) => c.entityId), ["1", "2", "3"]);
    assert.deepEqual(verdict.brandConflict, brandConflict);

    const many = Array.from({ length: 8 }, (_, i) => candidate(String(i + 1)));
    const capped = verdictFromBottleCheck(
      check({ outcome: "needs_question", questionKey: "candidate_select", candidates: many }),
      { afterNoneOfThese: false, evidence },
    );
    assert.equal(capped.kind === "pick" && capped.candidates.length, 5);
  });

  it("a brand + shade question with weak candidates is no pick list", () => {
    const verdict = verdictFromBottleCheck(
      check({ outcome: "needs_question", questionKey: "brand_shade", candidates: [candidate("1"), candidate("2")] }),
      { afterNoneOfThese: false, evidence },
    );
    assert.deepEqual(verdict, { kind: "add", evidence });
  });

  it("goes to the create card after None of these", () => {
    const suggestedShade = {
      brandId: null,
      brandName: "Loud Lacquer",
      brandSource: "hint" as const,
      shadeName: "Mango",
      hex: "#ff8800",
      finish: "creme",
      gtin: null,
    };
    const verdict = verdictFromBottleCheck(
      check({ outcome: "needs_question", candidates: [candidate("1"), candidate("2")], suggestedShade }),
      { afterNoneOfThese: true, evidence },
    );
    assert.equal(verdict.kind, "create_card");
    if (verdict.kind !== "create_card") return;
    assert.equal(verdict.card.shadeName, "Mango");
    assert.equal(verdict.brandConflict, null);
  });

  it("asks to confirm a brand that was only read off the bottle", () => {
    const verdict = verdictFromBottleCheck(
      check({
        suggestedShade: {
          brandId: "9",
          brandName: "Loud Lacquer",
          brandSource: "read",
          shadeName: "Mango",
          hex: null,
          finish: null,
          gtin: null,
        },
      }),
      { afterNoneOfThese: false, evidence },
    );
    assert.equal(verdict.kind, "create_card");
    assert.equal(verdict.kind === "create_card" && verdict.card.brandNeedsConfirm, true);
  });

  it("falls back to add with the evidence when nothing was suggested", () => {
    const verdict = verdictFromBottleCheck(check({}), { afterNoneOfThese: false, evidence });
    assert.deepEqual(verdict, { kind: "add", evidence });
  });
});
