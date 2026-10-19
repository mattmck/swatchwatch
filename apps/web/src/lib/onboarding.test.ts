import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PolishStatus } from "swatchwatch-shared";
import {
  CATALOG_SEARCH_HREF,
  GETTING_STARTED_STEPS,
  ONBOARDING_GOAL,
  ONBOARDING_SHOW_BELOW,
  dismissGettingStarted,
  gettingStartedStorageKey,
  gettingStartedView,
  markGettingStartedStarted,
  markStepVisited,
  onboardingProgress,
  parseGettingStartedState,
  polishesEmptyStateKind,
  serializeGettingStartedState,
  shouldFocusSearch,
  type GettingStartedState,
} from "./onboarding";

const FRESH: GettingStartedState = { started: false, dismissed: false, visited: [] };

describe("onboarding constants", () => {
  it("aims at the M2 goal of 20 polishes and shows the checklist below 5", () => {
    assert.equal(ONBOARDING_GOAL, 20);
    assert.equal(ONBOARDING_SHOW_BELOW, 5);
  });

  it("orders the three ways in by speed: import, scan, search", () => {
    assert.deepEqual(
      GETTING_STARTED_STEPS.map((step) => step.id),
      ["import", "scan", "search"]
    );
    assert.deepEqual(
      GETTING_STARTED_STEPS.map((step) => step.href),
      ["/polishes/import", "/rapid-add", CATALOG_SEARCH_HREF]
    );
  });

  it("links catalog search to every polish with the search box focused", () => {
    const params = new URLSearchParams(CATALOG_SEARCH_HREF.split("?")[1]);
    assert.equal(new URL(CATALOG_SEARCH_HREF, "https://x").pathname, "/polishes");
    assert.equal(shouldFocusSearch(params), true);
  });
});

describe("onboardingProgress", () => {
  it("counts owned polishes toward the goal", () => {
    assert.deepEqual(onboardingProgress(3), { count: 3, goal: 20, percent: 15, label: "3 of 20 polishes" });
  });

  it("caps at the goal", () => {
    assert.deepEqual(onboardingProgress(57), { count: 20, goal: 20, percent: 100, label: "20 of 20 polishes" });
  });

  it("treats negative or fractional counts safely", () => {
    assert.equal(onboardingProgress(-2).count, 0);
    assert.equal(onboardingProgress(Number.NaN).count, 0);
    assert.equal(onboardingProgress(4.7).count, 4);
  });
});

describe("parseGettingStartedState", () => {
  it("defaults to a fresh state for missing or broken storage", () => {
    assert.deepEqual(parseGettingStartedState(null), FRESH);
    assert.deepEqual(parseGettingStartedState(""), FRESH);
    assert.deepEqual(parseGettingStartedState("{not json"), FRESH);
    assert.deepEqual(parseGettingStartedState("42"), FRESH);
    assert.deepEqual(parseGettingStartedState("null"), FRESH);
  });

  it("round-trips through serialize", () => {
    const state: GettingStartedState = { started: true, dismissed: false, visited: ["scan", "import"] };
    assert.deepEqual(parseGettingStartedState(serializeGettingStartedState(state)), {
      started: true,
      dismissed: false,
      visited: ["import", "scan"],
    });
  });

  it("drops unknown or duplicate step ids and non-boolean flags", () => {
    assert.deepEqual(
      parseGettingStartedState(JSON.stringify({ started: "yes", dismissed: 1, visited: ["search", "nope", "search", 3] })),
      { started: false, dismissed: false, visited: ["search"] }
    );
  });
});

describe("gettingStartedView", () => {
  it("shows the checklist to a new user who owns fewer than 5", () => {
    assert.equal(gettingStartedView(0, FRESH), "active");
    assert.equal(gettingStartedView(4, FRESH), "active");
  });

  it("stays hidden for an existing user who never saw it and already owns 5 or more", () => {
    assert.equal(gettingStartedView(5, FRESH), "hidden");
    assert.equal(gettingStartedView(12, FRESH), "hidden");
  });

  it("keeps showing progress until 20 once the user started onboarding", () => {
    const started = { ...FRESH, started: true };
    assert.equal(gettingStartedView(5, started), "active");
    assert.equal(gettingStartedView(19, started), "active");
  });

  it("switches to the completed card at the goal so the user can dismiss it", () => {
    assert.equal(gettingStartedView(20, { ...FRESH, started: true }), "complete");
    assert.equal(gettingStartedView(20, FRESH), "hidden");
  });

  it("never shows again after the user closes it", () => {
    const dismissed = { ...FRESH, started: true, dismissed: true };
    assert.equal(gettingStartedView(0, dismissed), "hidden");
    assert.equal(gettingStartedView(10, dismissed), "hidden");
    assert.equal(gettingStartedView(25, dismissed), "hidden");
  });
});

describe("state transitions", () => {
  it("marks onboarding started only while the user owns fewer than 5", () => {
    assert.deepEqual(markGettingStartedStarted(FRESH, 2), { ...FRESH, started: true });
    assert.equal(markGettingStartedStarted(FRESH, 5), FRESH);
    const started = { ...FRESH, started: true };
    assert.equal(markGettingStartedStarted(started, 0), started);
  });

  it("dismisses without losing visited steps", () => {
    assert.deepEqual(dismissGettingStarted({ started: true, dismissed: false, visited: ["scan"] }), {
      started: true,
      dismissed: true,
      visited: ["scan"],
    });
  });

  it("records each visited step once, in step order", () => {
    const once = markStepVisited(FRESH, "search");
    const twice = markStepVisited(markStepVisited(once, "import"), "search");
    assert.deepEqual(twice.visited, ["import", "search"]);
  });
});

describe("gettingStartedStorageKey", () => {
  it("is per user so a shared browser keeps each user's choice", () => {
    assert.equal(gettingStartedStorageKey("42"), "swatchwatch-getting-started:42");
    assert.equal(gettingStartedStorageKey(null), "swatchwatch-getting-started");
  });
});

describe("shouldFocusSearch", () => {
  it("is true only for focus=search", () => {
    assert.equal(shouldFocusSearch(new URLSearchParams("focus=search")), true);
    assert.equal(shouldFocusSearch(new URLSearchParams("focus=other")), false);
    assert.equal(shouldFocusSearch(new URLSearchParams("")), false);
  });
});

describe("polishesEmptyStateKind", () => {
  const base: Parameters<typeof polishesEmptyStateKind>[0] = {
    search: "",
    statuses: [] as PolishStatus[],
    untried: false,
    toneFilter: "all",
    finishFilter: "all",
    familyFilter: "",
  };

  it("explains an empty collection when My Collection has no rows", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"] }), "collection");
  });

  it("explains an empty wishlist", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["wishlist"] }), "wishlist");
  });

  it("covers other status combinations such as destash + archived", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["destash", "archived"] }), "status");
  });

  it("says the filters matched nothing once any non-status filter is on", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"], search: "holo" }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"], untried: true }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, toneFilter: "warm" }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, finishFilter: "holo" }), "filtered");
    assert.equal(polishesEmptyStateKind({ ...base, familyFilter: "red" }), "filtered");
  });

  it("ignores a whitespace-only search", () => {
    assert.equal(polishesEmptyStateKind({ ...base, statuses: ["owned"], search: "  " }), "collection");
  });

  it("falls back to an empty catalog when nothing is filtered", () => {
    assert.equal(polishesEmptyStateKind(base), "catalog");
  });
});
