import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookSharePath, type PublicLookResponse } from "swatchwatch-shared";
import {
  buildLookShareUrl,
  LOOK_SHARE_PRIVACY_NOTE,
  publicLookDetailSteps,
  publicLookErrorMessage,
  publicLookName,
  publicLookOwnerLine,
  publicLookView,
  publicLookVibeLine,
  publicStepLabel,
  readShareToken,
} from "./look-share";
import { applicationOrder, finishNotes } from "./looks-detail";
import { LOOK_TEMPLATES } from "./looks";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
const TEMPLATE = LOOK_TEMPLATES[0];

const LOOK: PublicLookResponse = {
  displayName: "Sam",
  templateId: TEMPLATE.id,
  vibe: { occasion: "date", mood: "bold", finish: "matte" },
  steps: [
    { role: "base", brand: "Holo Taco", name: "Matte Black", finishes: ["matte"], hex: "#111111", imageUrl: null },
    { role: "accent", brand: null, name: null, finishes: [], hex: "#ABCDEF", imageUrl: null },
  ],
};

describe("public look page state", () => {
  it("shows 'not found' without fetching when the token is missing or malformed", () => {
    for (const params of [new URLSearchParams(), new URLSearchParams({ token: "short" }), null]) {
      const view = publicLookView(readShareToken(params), undefined);
      assert.equal(view.kind, "unavailable");
      assert.equal(view.kind === "unavailable" && view.reason, "missing");
      assert.equal(view.kind === "unavailable" && view.message, publicLookErrorMessage(404));
    }
  });

  it("is loading until the request settles", () => {
    assert.deepEqual(publicLookView(TOKEN, undefined), { kind: "loading" });
  });

  it("shows a revoked link (410) as no longer shared", () => {
    const view = publicLookView(TOKEN, { ok: false, status: 410 });
    assert.deepEqual(view, {
      kind: "unavailable",
      reason: "revoked",
      title: "No longer shared",
      message: "Its owner has stopped sharing this look.",
    });
  });

  it("separates not found, rate-limited and other errors", () => {
    const reasonOf = (status?: number) => {
      const view = publicLookView(TOKEN, { ok: false, status });
      return view.kind === "unavailable" ? view.reason : view.kind;
    };
    assert.equal(reasonOf(404), "not-found");
    assert.equal(reasonOf(429), "rate-limited");
    assert.equal(reasonOf(500), "error");
    assert.equal(reasonOf(undefined), "error");
    assert.match(publicLookErrorMessage(429), /Too many requests/);
    assert.match(publicLookErrorMessage(404), /doesn't exist/);
  });

  it("is ready with the look", () => {
    assert.deepEqual(publicLookView(TOKEN, { ok: true, look: LOOK }), { kind: "ready", look: LOOK });
  });
});

describe("public look content", () => {
  it("names the look and steps from the built-in template, not from saved text", () => {
    assert.equal(publicLookName(TEMPLATE.id), TEMPLATE.name);
    assert.equal(publicLookName("not-a-template"), "A nail look");
    const baseLabel = TEMPLATE.steps.find((s) => s.role === "base")?.label;
    assert.equal(publicStepLabel(TEMPLATE.id, "base"), baseLabel);
    assert.equal(publicStepLabel("not-a-template", "topper"), "Topper");
  });

  it("labels a look's two accents by position, not both with the first accent's label", () => {
    const template = LOOK_TEMPLATES.find((t) => t.id === "french-modern")!;
    const accentLabels = template.steps.filter((s) => s.role === "accent").map((s) => s.label);
    assert.equal(accentLabels.length, 2, "setup: two accents");
    const chip = { brand: null, name: null, finishes: [], imageUrl: null };
    const look: PublicLookResponse = {
      ...LOOK,
      templateId: template.id,
      steps: [
        { ...chip, role: "base", hex: "#F2DCD5" },
        { ...chip, role: "accent", hex: "#FFFFFF" },
        { ...chip, role: "accent", hex: "#D98A9E" },
      ],
    };
    assert.deepEqual(publicLookDetailSteps(look).map((s) => s.label), ["Base", ...accentLabels]);
    assert.equal(publicStepLabel(template.id, "accent", 1), accentLabels[1]);
    assert.equal(publicStepLabel(template.id, "accent", 2), "Accent");
  });

  it("shows the owner's display name or a generic line", () => {
    assert.equal(publicLookOwnerLine("Sam"), "Shared by Sam");
    assert.equal(publicLookOwnerLine("   "), "Shared from SwatchWatch");
    assert.equal(publicLookOwnerLine(null), "Shared from SwatchWatch");
  });

  it("describes the vibe", () => {
    const line = publicLookVibeLine(LOOK.vibe);
    assert.equal(line.split(" · ").length, 3);
    assert.equal(publicLookVibeLine({ ...LOOK.vibe, finish: null }).split(" · ").length, 2);
  });

  it("feeds the drawer's application order and finish notes, with chips as 'any shade close to'", () => {
    const steps = publicLookDetailSteps(LOOK);
    assert.equal(steps[0].polish?.name, "Matte Black");
    assert.equal(steps[1].polish, null);
    assert.equal(steps[1].targetHex, "#ABCDEF");
    const order = applicationOrder({ steps });
    assert.equal(order[0].kind, "base-coat");
    assert.match(order.find((s) => s.kind === "base")!.text, /Matte Black — Holo Taco/);
    assert.match(order.find((s) => s.kind === "accent")!.text, /any shade close to #ABCDEF/);
    assert.match(order.at(-1)!.text, /matte top coat/);
    assert.deepEqual(finishNotes({ steps }).map((n) => n.finish), ["matte"]);
  });
});

describe("owner share link", () => {
  it("builds an absolute static-export URL with the token in the query", () => {
    assert.equal(buildLookShareUrl("https://swatchwatch.app", lookSharePath(TOKEN)), `https://swatchwatch.app/l/?token=${TOKEN}`);
  });

  it("tells the owner what is and isn't shared", () => {
    for (const phrase of ["display name", "email", "own", "notes", "prices", "color only", "index", "deleting the saved look"]) {
      assert.ok(LOOK_SHARE_PRIVACY_NOTE.includes(phrase), phrase);
    }
  });
});
