import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PolishDupe, PolishDupesResponse, PolishImportCommitResult } from "swatchwatch-shared";
import {
  METRIC_EVENTS,
  bestDupeGrade,
  dupeSurfaceForIntent,
  dupeWarningOutcomeEvent,
  dupeWarningShownEvent,
  importCompletedEvent,
  looksGeneratedEvent,
  looksWearClickedEvent,
  looksColorLabOpenedEvent,
  maniLoggedEvent,
  trackLooksWearClicked,
  onboardingStepClickedEvent,
  trackOnboardingStepClicked,
  matchImageProcessedEvent,
  matchResultActionEvent,
  trackMatchResultAction,
  trackDupeWarningOutcome,
  trackDupeWarningShown,
  trackImportCompleted,
  trackManiLogged,
  type MetricProperties,
} from "./metrics-events";

function dupe(grade: PolishDupe["grade"]): PolishDupe {
  return {
    shadeId: "7",
    brand: "Holo Taco",
    name: "Red Velvet",
    finishes: ["creme"],
    displayHex: "#B0303A",
    displayHexSource: "vendor",
    distance: 0.012,
    colorGrade: grade,
    grade,
    finishCompatibility: "same",
  };
}

function response(dupes: PolishDupe[]): Pick<PolishDupesResponse, "dupes" | "dupeCount"> {
  return { dupes, dupeCount: dupes.length };
}

const IMPORT_RESULT: PolishImportCommitResult = {
  created: 12,
  updated: 3,
  skipped: 4,
  failed: 1,
  shadesCreated: 2,
};

function recorder() {
  const calls: Array<{ name: string; properties: MetricProperties }> = [];
  return { calls, track: (name: string, properties: MetricProperties) => calls.push({ name, properties }) };
}

describe("metrics events: no-op path", () => {
  it("never throws when telemetry is off (no connection string in tests)", () => {
    assert.doesNotThrow(() => {
      trackDupeWarningShown({ surface: "add_form", response: response([dupe("high")]) });
      trackDupeWarningOutcome({ surface: "wishlist", response: response([]), outcome: "cancel" });
      trackManiLogged({ polishCount: 2, via: "form" });
      trackImportCompleted({ result: IMPORT_RESULT, alreadyCommitted: false });
    });
  });
});

describe("metrics events: dupe warning funnel", () => {
  it("maps the add-guard intent to the funnel surface", () => {
    assert.equal(dupeSurfaceForIntent("own"), "add_form");
    assert.equal(dupeSurfaceForIntent("wishlist"), "wishlist");
  });

  it("reports the best grade in upper case, or none", () => {
    assert.equal(bestDupeGrade(response([dupe("high"), dupe("medium")])), "HIGH");
    assert.equal(bestDupeGrade(response([dupe("medium")])), "MEDIUM");
    assert.equal(bestDupeGrade(response([])), null);
    assert.equal(bestDupeGrade(null), null);
  });

  it("dupe.warning_shown carries surface, dupe count and best grade", () => {
    assert.deepEqual(dupeWarningShownEvent({ surface: "rapid_add", response: response([dupe("medium")]) }), {
      name: "dupe.warning_shown",
      properties: { surface: "rapid_add", dupeCount: 1, bestGrade: "MEDIUM" },
    });
  });

  it("keeps details but never lets them override the funnel keys", () => {
    const event = dupeWarningShownEvent({
      surface: "add_form",
      response: { dupes: [dupe("high")], dupeCount: 5 },
      details: { page: "polishes-list", shade: "42", surface: "bogus", dupeCount: 99, bestGrade: "high" },
    });
    assert.deepEqual(event.properties, {
      page: "polishes-list",
      shade: "42",
      surface: "add_form",
      dupeCount: 5,
      bestGrade: "HIGH",
    });
  });

  it("drops a stale bestGrade detail when there is no best dupe", () => {
    const event = dupeWarningShownEvent({
      surface: "wishlist",
      response: response([]),
      details: { bestGrade: "high" },
    });
    assert.deepEqual(event.properties, { surface: "wishlist", dupeCount: 0 });
  });

  it("dupe.warning_outcome adds the outcome to the same properties", () => {
    for (const outcome of ["cancel", "wishlist_instead", "add_anyway"] as const) {
      assert.deepEqual(
        dupeWarningOutcomeEvent({ surface: "wishlist", response: response([dupe("high")]), outcome }),
        {
          name: "dupe.warning_outcome",
          properties: { surface: "wishlist", dupeCount: 1, bestGrade: "HIGH", outcome },
        }
      );
    }
  });

  it("track helpers send the built event to the tracker", () => {
    const { calls, track } = recorder();
    trackDupeWarningShown({ surface: "add_form", response: response([dupe("high")]) }, track);
    trackDupeWarningOutcome({ surface: "add_form", response: response([dupe("high")]), outcome: "add_anyway" }, track);
    assert.deepEqual(
      calls.map((call) => call.name),
      [METRIC_EVENTS.dupeWarningShown, METRIC_EVENTS.dupeWarningOutcome]
    );
    assert.equal(calls[1].properties.outcome, "add_anyway");
  });
});

describe("metrics events: mani and import", () => {
  it("mani.logged is counts only", () => {
    assert.deepEqual(maniLoggedEvent({ polishCount: 3, via: "quick" }), {
      name: "mani.logged",
      properties: { polishCount: 3, via: "quick" },
    });
  });

  it("import.completed reports committed, created, updated, skipped, failed and new shades", () => {
    assert.deepEqual(importCompletedEvent(IMPORT_RESULT), {
      name: "import.completed",
      properties: { rowsCommitted: 15, created: 12, updated: 3, skipped: 4, failed: 1, shadesCreated: 2 },
    });
  });

  it("import.completed skips an already-committed session", () => {
    const { calls, track } = recorder();
    trackImportCompleted({ result: IMPORT_RESULT, alreadyCommitted: true }, track);
    assert.equal(calls.length, 0);
    trackImportCompleted({ result: IMPORT_RESULT, alreadyCommitted: false }, track);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "import.completed");
  });

  it("sends only numbers, booleans and enum strings", () => {
    const events = [
      dupeWarningShownEvent({ surface: "add_form", response: response([dupe("high")]) }),
      dupeWarningOutcomeEvent({ surface: "add_form", response: response([dupe("high")]), outcome: "cancel" }),
      maniLoggedEvent({ polishCount: 1, via: "form" }),
      importCompletedEvent(IMPORT_RESULT),
    ];
    const allowedStrings = new Set([
      "add_form", "wishlist", "rapid_add", "HIGH", "MEDIUM",
      "cancel", "wishlist_instead", "add_anyway", "quick", "form",
    ]);
    for (const event of events) {
      for (const value of Object.values(event.properties)) {
        if (typeof value === "string") assert.ok(allowedStrings.has(value), `${event.name}: ${value}`);
      }
    }
  });
});

describe("looks events", () => {
  const look = {
    templateId: "french-modern",
    steps: [
      { role: "base", source: "owned" },
      { role: "accent", source: "catalog" },
    ],
    ownedSteps: 1,
    missingSteps: 1,
  } as const;

  it("looks.generated carries the vibe and counts only", () => {
    const event = looksGeneratedEvent({
      vibe: { occasion: "work", mood: "soft", finish: null, ownedOnly: false },
      looks: [look],
      shortfall: true,
      ownedCount: 4,
      trigger: "shuffle",
    });
    assert.equal(event.name, METRIC_EVENTS.looksGenerated);
    assert.equal(event.name, "looks.generated");
    assert.deepEqual(event.properties, {
      occasion: "work",
      mood: "soft",
      finish: "any",
      ownedOnly: false,
      includeToppers: true,
      undertone: "none",
      depth: "none",
      trigger: "shuffle",
      lookCount: 1,
      ownedSteps: 1,
      missingSteps: 1,
      fullyOwnedLooks: 0,
      ownedCount: 4,
      shortfall: true,
      templates: "french-modern",
    });
  });

  it("looks.generated reports the skin-tone dimensions, 'none' when unset", () => {
    const event = looksGeneratedEvent({
      vibe: { occasion: "work", mood: "soft", finish: null, ownedOnly: false, skinTone: { undertone: "warm", depth: "tan" } },
      looks: [look],
      shortfall: false,
      ownedCount: 4,
      trigger: "vibe",
    });
    assert.equal(event.properties.undertone, "warm");
    assert.equal(event.properties.depth, "tan");
  });

  it("looks.wear_clicked carries the template and step counts", () => {
    const calls: Array<[string, MetricProperties]> = [];
    trackLooksWearClicked({ look, swapped: true, position: 2 }, (name, properties) => calls.push([name, properties]));
    assert.deepEqual(calls, [
      [
        "looks.wear_clicked",
        { template: "french-modern", position: 2, ownedSteps: 1, missingSteps: 1, swapped: true, surface: "card" },
      ],
    ]);
    assert.equal(looksWearClickedEvent({ look, swapped: false, position: 0 }).properties.swapped, false);
    assert.equal(looksWearClickedEvent({ look, swapped: false, position: 1, surface: "saved" }).properties.surface, "saved");
  });

  it("looks.generated reports the Include toppers toggle (#386)", () => {
    const event = looksGeneratedEvent({
      vibe: { occasion: "work", mood: "soft", finish: null, ownedOnly: false },
      looks: [look],
      shortfall: false,
      ownedCount: 4,
      trigger: "vibe",
      includeToppers: false,
    });
    assert.equal(event.properties.includeToppers, false);
  });

  it("looks.color_lab_opened carries the template, surface and step counts (#386)", () => {
    assert.deepEqual(looksColorLabOpenedEvent({ look, surface: "drawer", position: 1 }), {
      name: "looks.color_lab_opened",
      properties: { template: "french-modern", surface: "drawer", position: 1, ownedSteps: 1, missingSteps: 1 },
    });
  });
});

describe("metrics events: onboarding", () => {
  it("names the step, the surface and the owned count", () => {
    assert.deepEqual(onboardingStepClickedEvent({ step: "import", surface: "dashboard_checklist", ownedCount: 3 }), {
      name: "onboarding.step_clicked",
      properties: { step: "import", surface: "dashboard_checklist", ownedCount: 3 },
    });
    assert.equal(METRIC_EVENTS.onboardingStepClicked, "onboarding.step_clicked");
  });

  it("clamps a bad owned count to a non-negative integer", () => {
    const event = onboardingStepClickedEvent({ step: "scan", surface: "polishes_empty", ownedCount: -1 });
    assert.equal(event.properties.ownedCount, 0);
  });

  it("sends through the injected tracker", () => {
    const { calls, track } = recorder();
    trackOnboardingStepClicked({ step: "search", surface: "gaps_empty", ownedCount: 0 }, track);
    assert.deepEqual(calls, [
      { name: "onboarding.step_clicked", properties: { step: "search", surface: "gaps_empty", ownedCount: 0 } },
    ]);
  });

  it("never throws when telemetry is off", () => {
    assert.doesNotThrow(() => trackOnboardingStepClicked({ step: "import", surface: "match_empty", ownedCount: 0 }));
  });
});

describe("metrics events: photo match (#105)", () => {
  it("builds match.image_processed with counts only", () => {
    const event = matchImageProcessedEvent({
      trigger: "upload",
      scope: "catalog",
      finishFiltered: true,
      familyFilterCount: 2,
      extractedColorCount: 6,
      hiddenColorCount: 2,
      candidateCount: 120,
      matchCount: 20,
      highCount: 3,
      mediumCount: 8,
      durationMs: 412.6,
      cached: false,
    });
    assert.equal(event.name, "match.image_processed");
    assert.equal(event.name, METRIC_EVENTS.matchImageProcessed);
    assert.equal(event.properties.durationMs, 413);
    assert.equal(event.properties.scope, "catalog");
    assert.equal(event.properties.hiddenColorCount, 2);
  });

  it("omits the duration for a cached response", () => {
    const event = matchImageProcessedEvent({
      trigger: "filters",
      scope: "owned",
      finishFiltered: false,
      familyFilterCount: 0,
      extractedColorCount: 4,
      hiddenColorCount: 0,
      candidateCount: 10,
      matchCount: 10,
      highCount: 0,
      mediumCount: 1,
      cached: true,
    });
    assert.equal("durationMs" in event.properties, false);
  });

  it("builds match.result_action and tracks through the injected tracker", () => {
    const calls: Array<[string, unknown]> = [];
    trackMatchResultAction(
      { action: "wishlist", scope: "catalog", view: "colors", confidence: "high", rank: 2, fromStatus: null },
      (name, properties) => calls.push([name, properties])
    );
    assert.deepEqual(calls, [
      [
        "match.result_action",
        { action: "wishlist", scope: "catalog", view: "colors", confidence: "high", rank: 2, fromStatus: "none" },
      ],
    ]);
    assert.equal(matchResultActionEvent({ action: "own", scope: "wishlist", view: "list", confidence: "medium", rank: 1, fromStatus: "wishlist" }).properties.fromStatus, "wishlist");
  });
});
