const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  rankImagesForColorDetection,
  selectImageForColorDetection,
  scoreImageForColorDetection,
} = require("../dist/lib/image-selection");

const img = (url, alt = null, position = null) => ({ url, alt, position });

describe("lib/image-selection — scoreImageForColorDetection", () => {
  it("scores swatch/nail/hand/macro/close-up/finger alt text high", () => {
    for (const alt of ["Nail swatch", "on the nails", "Hand photo", "macro shot", "Close-up", "close up", "fingers", "two coats on the nail"]) {
      const score = scoreImageForColorDetection(img("https://cdn.example.com/1.jpg", alt));
      assert.ok(score.score > 0, `${alt} should score > 0, got ${score.score}`);
      assert.ok(score.altScore > 0, `${alt} should have a positive alt score`);
    }
  });

  it("scores bottle/cap/box/packaging/collection/set/lifestyle alt text low", () => {
    for (const alt of ["Bottle hero", "Cap detail", "Gift box", "Packaging", "Collection shot", "Sundog set", "Lifestyle"]) {
      const score = scoreImageForColorDetection(img("https://cdn.example.com/1.jpg", alt));
      assert.ok(score.score < 0, `${alt} should score < 0, got ${score.score}`);
    }
  });

  it("treats swatch/nail in the URL as a weak signal that alone is not confident", () => {
    const score = scoreImageForColorDetection(img("https://cdn.example.com/files/mc_pdp_swatch_nails.jpg"));
    assert.ok(score.score > 0);
    assert.equal(score.altScore, 0);
    assert.ok(score.urlScore > 0);
    assert.ok(score.urlScore < 3, "URL hits are weaker than alt hits");
  });

  it("matches keywords as whole words, so 'capsule' and 'nailed' do not count", () => {
    assert.equal(scoreImageForColorDetection(img("https://cdn.example.com/a.jpg", "capsule wardrobe")).score, 0);
    assert.equal(scoreImageForColorDetection(img("https://cdn.example.com/a.jpg", "nailed it")).score, 0);
    assert.equal(scoreImageForColorDetection(img("https://cdn.example.com/a.jpg", "upset")).score, 0);
  });

  it("records which keywords fired", () => {
    const score = scoreImageForColorDetection(img("https://cdn.example.com/hand_swatch.jpg", "Bottle next to nail swatch"));
    assert.deepEqual(score.altPositive, ["nail", "swatch"]);
    assert.deepEqual(score.altNegative, ["bottle"]);
    assert.deepEqual(score.urlPositive, ["hand", "swatch"]);
  });

  it("ignores missing alt text and query strings in the URL", () => {
    const score = scoreImageForColorDetection(img("https://cdn.example.com/a.jpg?v=swatch"));
    assert.equal(score.score, 0);
    assert.equal(scoreImageForColorDetection(img("https://cdn.example.com/a.jpg", undefined)).score, 0);
  });
});

describe("lib/image-selection — rankImagesForColorDetection", () => {
  it("returns an empty list for no images", () => {
    assert.deepEqual(rankImagesForColorDetection([]), []);
    assert.deepEqual(rankImagesForColorDetection(null), []);
  });

  it("orders the on-nail swatch ahead of the bottle shot and keeps every image", () => {
    const ranked = rankImagesForColorDetection([
      img("https://cdn.example.com/bottle.jpg", "Pier Pressure bottle hero", 1),
      img("https://cdn.example.com/hand2.jpg", "Pier Pressure swatch on nails", 2),
      img("https://cdn.example.com/box.jpg", "Coastal Cremes collection box", 3),
    ]);
    assert.deepEqual(ranked.map((r) => r.url), [
      "https://cdn.example.com/hand2.jpg",
      "https://cdn.example.com/bottle.jpg",
      "https://cdn.example.com/box.jpg",
    ]);
    assert.equal(ranked[0].index, 1);
    assert.equal(ranked[0].position, 2);
    assert.equal(ranked[0].confident, true);
    assert.match(ranked[0].reason, /alt/i);
    assert.match(ranked[0].reason, /swatch/);
    assert.equal(ranked[1].confident, false);
  });

  it("is stable: ties keep the original order (position, then index)", () => {
    const ranked = rankImagesForColorDetection([
      img("https://cdn.example.com/a.jpg", "Pier Pressure", 1),
      img("https://cdn.example.com/b.jpg", "Pier Pressure", 2),
      img("https://cdn.example.com/c.jpg", "Pier Pressure", 3),
    ]);
    assert.deepEqual(ranked.map((r) => r.url.slice(-5)), ["a.jpg", "b.jpg", "c.jpg"]);
    assert.ok(ranked.every((r) => r.confident === false));
  });

  it("uses position for ordering when present even if the array is shuffled", () => {
    const ranked = rankImagesForColorDetection([
      img("https://cdn.example.com/b.jpg", null, 2),
      img("https://cdn.example.com/a.jpg", null, 1),
    ]);
    assert.deepEqual(ranked.map((r) => r.url.slice(-5)), ["a.jpg", "b.jpg"]);
  });

  it("ranks a weak URL-only hit first but does not mark it confident", () => {
    const ranked = rankImagesForColorDetection([
      img("https://cdn.example.com/files/HT-Bottle-Heroes-PierPressure.jpg"),
      img("https://cdn.example.com/files/DSC_1441_hand2_PierPressure_sq.jpg"),
    ]);
    assert.equal(ranked[0].url, "https://cdn.example.com/files/DSC_1441_hand2_PierPressure_sq.jpg");
    assert.equal(ranked[0].confident, false);
    assert.match(ranked[0].reason, /url/i);
  });

  it("a positive alt that is outweighed by negative alt words is not confident", () => {
    const ranked = rankImagesForColorDetection([
      img("https://cdn.example.com/a.jpg", "Bottle and box set with nail"),
    ]);
    assert.ok(ranked[0].score < 0);
    assert.equal(ranked[0].confident, false);
  });

  it("drops entries without a usable URL", () => {
    const ranked = rankImagesForColorDetection([img("", "swatch"), img("   "), { alt: "swatch" }, img("https://cdn.example.com/a.jpg")]);
    assert.equal(ranked.length, 1);
  });
});

describe("lib/image-selection — selectImageForColorDetection", () => {
  const primary = "https://cdn.example.com/bottle.jpg";

  it("picks the top-ranked image when the alt text is confident", () => {
    const selection = selectImageForColorDetection(
      [img(primary, "Bottle hero", 1), img("https://cdn.example.com/hand.jpg", "Swatch on nails", 2)],
      primary
    );
    assert.equal(selection.url, "https://cdn.example.com/hand.jpg");
    assert.equal(selection.confident, true);
    assert.equal(selection.source, "ranked");
    assert.match(selection.reason, /swatch/);
    assert.equal(selection.ranked.length, 2);
  });

  it("falls back to the primary image when no alt text is confident", () => {
    const selection = selectImageForColorDetection(
      [img(primary, null, 1), img("https://cdn.example.com/files/hand2_x.jpg", null, 2)],
      primary
    );
    assert.equal(selection.url, primary);
    assert.equal(selection.confident, false);
    assert.equal(selection.source, "primary");
    assert.match(selection.reason, /fall(ing)? back|primary/i);
  });

  it("falls back to the primary image when there are no images at all", () => {
    const selection = selectImageForColorDetection([], primary);
    assert.equal(selection.url, primary);
    assert.equal(selection.source, "primary");
    assert.deepEqual(selection.ranked, []);
  });

  it("returns null url when nothing is available", () => {
    const selection = selectImageForColorDetection([], null);
    assert.equal(selection.url, null);
    assert.equal(selection.source, "none");
  });

  it("keeps the primary when it is itself the confident top choice", () => {
    const selection = selectImageForColorDetection(
      [img(primary, "Swatch on nails", 1), img("https://cdn.example.com/box.jpg", "Box", 2)],
      primary
    );
    assert.equal(selection.url, primary);
    assert.equal(selection.source, "ranked");
    assert.equal(selection.confident, true);
  });
});

const { parseProductImageCandidates, chooseUploadedImageForDetection } = require("../dist/lib/image-selection");

describe("lib/image-selection — parseProductImageCandidates", () => {
  it("reads url/alt/position rows from normalized.images", () => {
    const parsed = parseProductImageCandidates(
      [{ url: "https://cdn.example.com/a.jpg", alt: "Bottle", position: 1 }, { url: "https://cdn.example.com/b.jpg", alt: null, position: 2 }],
      []
    );
    assert.deepEqual(parsed, [
      { url: "https://cdn.example.com/a.jpg", alt: "Bottle", position: 1 },
      { url: "https://cdn.example.com/b.jpg", alt: null, position: 2 },
    ]);
  });

  it("falls back to bare imageUrls for records ingested before images existed", () => {
    assert.deepEqual(parseProductImageCandidates(undefined, ["https://cdn.example.com/a.jpg", " ", "https://cdn.example.com/b.jpg"]), [
      { url: "https://cdn.example.com/a.jpg", alt: null, position: 1 },
      { url: "https://cdn.example.com/b.jpg", alt: null, position: 2 },
    ]);
  });

  it("ignores malformed entries", () => {
    assert.deepEqual(parseProductImageCandidates([null, 3, { alt: "x" }, { url: "https://cdn.example.com/a.jpg", position: "nope" }], []), [
      { url: "https://cdn.example.com/a.jpg", alt: null, position: null },
    ]);
  });
});

describe("lib/image-selection — chooseUploadedImageForDetection", () => {
  const primary = "https://cdn.example.com/bottle.jpg";
  const hand = "https://cdn.example.com/hand.jpg";
  const images = [img(primary, "Bottle hero", 1), img(hand, "Swatch on nails", 2)];

  it("maps the confident top-ranked image to its uploaded blob", () => {
    const choice = chooseUploadedImageForDetection(images, primary, [
      { sourceUrl: primary, storageUrl: "https://blob/primary" },
      { sourceUrl: hand, storageUrl: "https://blob/hand" },
    ]);
    assert.equal(choice.sourceUrl, hand);
    assert.equal(choice.storageUrl, "https://blob/hand");
    assert.equal(choice.selection.source, "ranked");
    assert.equal(choice.uploadFallback, false);
  });

  it("uses the primary blob when the chosen image was not uploaded, and says so", () => {
    const choice = chooseUploadedImageForDetection(images, primary, [{ sourceUrl: primary, storageUrl: "https://blob/primary" }]);
    assert.equal(choice.sourceUrl, primary);
    assert.equal(choice.storageUrl, "https://blob/primary");
    assert.equal(choice.uploadFallback, true);
    assert.match(choice.reason, /not uploaded|upload/i);
    assert.equal(choice.selection.url, hand, "the ranking itself still names the swatch");
  });

  it("returns the primary blob when nothing is confident", () => {
    const choice = chooseUploadedImageForDetection([img(primary, null, 1), img(hand, null, 2)], primary, [
      { sourceUrl: primary, storageUrl: "https://blob/primary" },
      { sourceUrl: hand, storageUrl: "https://blob/hand" },
    ]);
    assert.equal(choice.storageUrl, "https://blob/primary");
    assert.equal(choice.selection.source, "primary");
    assert.equal(choice.uploadFallback, false);
  });

  it("returns a null storageUrl when no upload exists for the choice or the primary", () => {
    const choice = chooseUploadedImageForDetection(images, primary, []);
    assert.equal(choice.storageUrl, null);
    assert.equal(choice.sourceUrl, hand);
  });
});

describe("lib/image-selection — real vendor filenames (no alt text)", () => {
  // Holo Taco "Pier Pressure" products.json, 2026-10-16: no image has alt text.
  const holoTaco = [
    "HT-CoastalCremes-_0011_HT-CoastalCremes-BottleHeroes-PierPressure.jpg",
    "DSC_1441_hand2_PierPressure_sq.jpg",
    "PierPressure_yyulia_m4.jpg",
    "7_4792750b-95db-473e-8836-e933b1369a80.png",
    "0002_DSC_1342_macro2_PierPressure.jpg",
    "HT-CoastalCremes-_0003_HT-CoastalCremes-BottleMacro-PierPressure.jpg",
    "HT-CoastalCremes-BrushDrip-PierPressure.jpg",
  ].map((name, i) => img(`https://cdn.shopify.com/s/files/1/0050/3001/9162/files/${name}?v=1781152513`, null, i + 1));

  it("ranks the hand and macro nail shots first and the bottle hero last", () => {
    const ranked = rankImagesForColorDetection(holoTaco);
    assert.match(ranked[0].url, /hand2/);
    assert.match(ranked[1].url, /macro2/);
    assert.match(ranked[ranked.length - 1].url, /BottleHeroes/);
    assert.equal(ranked[0].confident, false, "filename hints alone are never confident");
  });

  it("splits camelCase so BottleMacro nets out to zero", () => {
    const score = scoreImageForColorDetection(holoTaco[5]);
    assert.deepEqual(score.urlPositive, ["macro"]);
    assert.deepEqual(score.urlNegative, ["bottle"]);
    assert.equal(score.score, 0);
  });

  it("production selection still falls back to the primary image without alt text", () => {
    const selection = selectImageForColorDetection(holoTaco, holoTaco[0].url);
    assert.equal(selection.url, holoTaco[0].url);
    assert.equal(selection.source, "primary");
    assert.match(selection.reason, /hand/);
  });
});

describe("lib/image-selection — chooseUploadedImageForDetection checksums", () => {
  const primary = "https://cdn.example.com/bottle.jpg";
  const hand = "https://cdn.example.com/hand.jpg";
  const uploaded = [
    { sourceUrl: primary, storageUrl: "https://blob/primary", checksumSha256: "aaa" },
    { sourceUrl: hand, storageUrl: "https://blob/hand", checksumSha256: "bbb" },
  ];

  it("returns the checksum of the image chosen for detection", () => {
    const choice = chooseUploadedImageForDetection([img(primary, "Bottle", 1), img(hand, "Swatch on nails", 2)], primary, uploaded);
    assert.equal(choice.checksumSha256, "bbb");
  });

  it("returns the primary checksum on the primary fallback and the upload fallback", () => {
    assert.equal(chooseUploadedImageForDetection([img(primary), img(hand)], primary, uploaded).checksumSha256, "aaa");
    assert.equal(
      chooseUploadedImageForDetection([img(primary, "Bottle", 1), img(hand, "Swatch on nails", 2)], primary, [uploaded[0]]).checksumSha256,
      "aaa"
    );
  });

  it("returns null when the chosen upload has no checksum or nothing was uploaded", () => {
    assert.equal(chooseUploadedImageForDetection([img(primary)], primary, [{ sourceUrl: primary, storageUrl: "x" }]).checksumSha256, null);
    assert.equal(chooseUploadedImageForDetection([img(primary)], primary, []).checksumSha256, null);
  });
});
