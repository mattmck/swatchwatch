import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import {
  buildOwnershipSnapshot,
  candidateOptionLabel,
  deriveCaptureVerdict,
  ownedEntryAfterVerdict,
  readCaptureDisplay,
  readCaptureEvidence,
  resolveCaptureVerdict,
  withOwnedEntry,
  type CaptureOutcome,
  type CaptureVerdict,
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
  polish({ id: "10", inventoryItemId: "100", quantity: 2, vendorHex: "#C1121F" }),
  polish({ id: "11", inventoryItemId: "101", quantity: 0, name: "Wishlisted" }),
  polish({ id: "12", name: "Catalog only" }),
]);

function matched(metadata: Record<string, unknown>, entity?: Partial<CaptureOutcome>): CaptureOutcome {
  return { status: "matched", metadata, ...entity };
}

describe("buildOwnershipSnapshot", () => {
  it("keeps only owned rows (inventory item with quantity > 0)", () => {
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
