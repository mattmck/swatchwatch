const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const layout = require("../dist/eval/bottle/import/layout");
const frames = require("../dist/eval/bottle/import/frames");
const manifest = require("../dist/eval/bottle/import/manifest");
const { parseArgs } = require("../dist/eval/bottle/import/cli");

describe("classifyFile / planTake", () => {
  it("accepts surface names in any case, with suffixes, images and clips", () => {
    assert.deepEqual(layout.classifyFile("Front.JPG"), { type: "media", surface: "front", kind: "image", file: "Front.JPG" });
    assert.equal(layout.classifyFile("front-2.heic").surface, "front");
    assert.equal(layout.classifyFile("glass (1).MOV").kind, "clip");
    assert.equal(layout.classifyFile("box_lid.webp").surface, "box");
    assert.equal(layout.classifyFile("bottom.jpeg").surface, "bottom");
  });

  it("rejects look-alike names, unknown types and quietly skips hidden files and the manifest", () => {
    assert.equal(layout.classifyFile("frontal.jpg").type, "ignored");
    assert.equal(layout.classifyFile("myfront.jpg").type, "ignored");
    assert.match(layout.classifyFile("front.txt").reason, /unsupported/);
    assert.equal(layout.classifyFile("front").type, "ignored");
    assert.equal(layout.classifyFile(".DS_Store").reason, "hidden");
    assert.equal(layout.classifyFile(".bottle-eval-import.json").reason, "manifest");
  });

  it("orders surfaces front, bottom, glass, box and prefers a photo over a clip", () => {
    const take = layout.planTake("warm", ["box.png", "glass.mov", "glass.jpg", "front 10.jpg", "front 2.jpg", "notes.txt", ".DS_Store"]);
    assert.equal(take.take, "warm");
    assert.deepEqual(
      take.surfaces.map((s) => `${s.surface}:${s.file}`),
      ["front:front 2.jpg", "glass:glass.jpg", "box:box.png"]
    );
    assert.deepEqual(take.ignored.map((i) => i.file).sort(), ["front 10.jpg", "glass.mov", "notes.txt"]);
  });
});

describe("parseFolderLabel", () => {
  it("splits on the first spaced hyphen or dash", () => {
    assert.deepEqual(layout.parseFolderLabel("Holo Taco - Up in Smoke"), { brand: "Holo Taco", shade: "Up in Smoke" });
    assert.deepEqual(layout.parseFolderLabel("Cirque-Colors - Kingdom"), { brand: "Cirque-Colors", shade: "Kingdom" });
    assert.deepEqual(layout.parseFolderLabel("ILNP – Mega - Bright"), { brand: "ILNP", shade: "Mega - Bright" });
    assert.deepEqual(layout.parseFolderLabel("  Zoya_—_Arizona  "), { brand: "Zoya", shade: "Arizona" });
  });

  it("returns null without a separator or with an empty side", () => {
    assert.equal(layout.parseFolderLabel("bottle-17"), null);
    assert.equal(layout.parseFolderLabel("Holo Taco -"), null);
    assert.equal(layout.parseFolderLabel(" - Shade"), null);
  });
});

describe("labels.csv", () => {
  const csv = 'Folder,ShadeID,Brand,Shade,Notes\nbottle-17,123,,,"warm, dim"\n"Holo Taco - Up In Smoke",,Holo Taco,Up in Smoke!,\nmystery,,Indie,,\n';

  it("parses rows keyed by a case/whitespace-insensitive folder", () => {
    const rows = layout.parseLabelsCsv(csv);
    assert.equal(rows.size, 3);
    assert.deepEqual(rows.get(layout.labelKey("BOTTLE-17")), {
      folder: "bottle-17",
      shadeId: "123",
      brand: null,
      shade: null,
      notes: "warm, dim",
    });
    assert.equal(rows.get(layout.labelKey("holo  taco - up in smoke")).shade, "Up in Smoke!");
  });

  it("rejects a missing folder column, a bad shadeId and duplicate folders", () => {
    assert.throws(() => layout.parseLabelsCsv("brand,shade\nA,B\n"), /folder/);
    assert.throws(() => layout.parseLabelsCsv("folder,shadeId\nx,abc\n"), /shadeId/);
    assert.throws(() => layout.parseLabelsCsv("folder\nX\n x \n"), /twice/);
    assert.throws(() => layout.parseLabelsCsv("folder,notes\nA,\"open quote\nB,x\n"), /never closed/);
  });

  it("resolveBottleLabel: shadeId wins, csv fields override the folder, else null", () => {
    const rows = layout.parseLabelsCsv(csv);
    assert.deepEqual(layout.resolveBottleLabel("bottle-17", rows.get("bottle-17")), {
      kind: "shadeId",
      shadeId: "123",
      notes: "warm, dim",
      source: "labels.csv",
    });
    const overridden = layout.resolveBottleLabel("Holo Taco - Up In Smoke", rows.get(layout.labelKey("Holo Taco - Up In Smoke")));
    assert.deepEqual(overridden, { kind: "text", brand: "Holo Taco", shade: "Up in Smoke!", notes: null, source: "labels.csv" });
    assert.deepEqual(layout.resolveBottleLabel("Zoya - Arizona", undefined), {
      kind: "text",
      brand: "Zoya",
      shade: "Arizona",
      notes: null,
      source: "folder",
    });
    assert.equal(layout.resolveBottleLabel("mystery", rows.get("mystery")), null);
    assert.equal(layout.resolveBottleLabel("bottle-18", undefined), null);
  });
});

describe("pickExactCatalogMatch", () => {
  const hits = [
    { shadeId: "1", brand: "Holo Taco", name: "Up in Smoke" },
    { shadeId: "2", brand: "Holo Taco", name: "Up in Smoke Topper" },
    { shadeId: "3", brand: "Holo  Tacos", name: "Up in Smoke" },
  ];

  it("accepts only an exact case- and whitespace-insensitive brand + name match", () => {
    assert.deepEqual(layout.pickExactCatalogMatch(hits, " holo taco ", "UP IN  SMOKE"), { kind: "match", hit: hits[0] });
    assert.deepEqual(layout.pickExactCatalogMatch(hits, "Holo Taco", "Up in Smok"), { kind: "none" });
    assert.deepEqual(layout.pickExactCatalogMatch([], "Holo Taco", "Up in Smoke"), { kind: "none" });
  });

  it("is ambiguous when several shade ids match exactly, not when one id repeats", () => {
    const twice = [...hits, { shadeId: "9", brand: "holo taco", name: "up in smoke" }];
    const result = layout.pickExactCatalogMatch(twice, "Holo Taco", "Up in Smoke");
    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.hits.map((h) => h.shadeId), ["1", "9"]);
    assert.equal(layout.pickExactCatalogMatch([hits[0], { ...hits[0] }], "Holo Taco", "Up in Smoke").kind, "match");
  });
});

describe("sampleNotes", () => {
  it("joins label notes, take and clip frame", () => {
    assert.equal(layout.sampleNotes({ labelNotes: null, take: null }), null);
    assert.equal(
      layout.sampleNotes({ labelNotes: "chipped", take: "warm", clipFrame: { index: 2, total: 3 } }),
      "chipped · take warm · clip frame 2/3"
    );
    assert.equal(layout.sampleNotes({ labelNotes: null, take: null, clipFrame: { index: 1, total: 1 } }), null);
  });
});

describe("sharpness", () => {
  it("laplacianVariance is 0 on a flat image and higher on edges", () => {
    const flat = new Uint8Array(16).fill(128);
    assert.equal(frames.laplacianVariance(flat, 4, 4), 0);
    const checker = Uint8Array.from({ length: 16 }, (_, i) => ((i % 4) + Math.floor(i / 4)) % 2 ? 255 : 0);
    assert.ok(frames.laplacianVariance(checker, 4, 4) > 0);
    assert.equal(frames.laplacianVariance(flat, 2, 8), 0);
  });

  it("ranks a blurred copy below the original (measured with sharp)", async () => {
    const width = 64;
    const pixels = Buffer.alloc(width * width * 3);
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 230 : 20;
        pixels.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    }
    const sharpImage = await sharp(pixels, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
    const blurred = await sharp(sharpImage).blur(3).png().toBuffer();
    const a = await frames.measureSharpness(sharpImage);
    const b = await frames.measureSharpness(blurred);
    assert.ok(a > b, `${a} > ${b}`);
    const ranked = frames.rankBySharpness([
      { time: 1, sharpness: b },
      { time: 2, sharpness: a },
    ]);
    assert.equal(ranked[0].time, 2);
  });

  it("rankBySharpness keeps clip order on ties", () => {
    const ranked = frames.rankBySharpness([
      { time: 3, sharpness: 5 },
      { time: 1, sharpness: 9 },
      { time: 2, sharpness: 5 },
    ]);
    assert.deepEqual(ranked.map((c) => c.time), [1, 3, 2]);
  });
});

describe("clip frame selection", () => {
  it("candidateTimestamps are slice centres", () => {
    assert.deepEqual(frames.candidateTimestamps(4, 4), [0.5, 1.5, 2.5, 3.5]);
    assert.deepEqual(frames.candidateTimestamps(0, 4), []);
    assert.deepEqual(frames.candidateTimestamps(5, 0), []);
    assert.equal(frames.candidateCount(1), 8);
    assert.equal(frames.candidateCount(3), 12);
  });

  it("pickClipFrames keeps the sharpest, then sharp frames spaced apart", () => {
    const c = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map((time, i) => ({ time, sharpness: [3, 9, 1, 4, 8, 2][i] }));
    assert.deepEqual(frames.pickClipFrames(c, 1).map((x) => x.time), [1.5]);
    assert.deepEqual(frames.pickClipFrames(c, 2).map((x) => x.time), [1.5, 4.5]);
    // gap = 6 / 6 = 1s: 1.5, 4.5, then 3.5 (4) beats 0.5 (3).
    assert.deepEqual(frames.pickClipFrames(c, 3).map((x) => x.time), [1.5, 3.5, 4.5]);
    assert.equal(frames.pickClipFrames(c.slice(0, 2), 5).length, 2);
    assert.deepEqual(frames.pickClipFrames([], 2), []);
  });

  it("pickClipFrames never keeps a blurred stretch over sharp neighbours that are far enough apart", () => {
    // 4 s clip, blurred until 2.5 s: candidate centres every 0.5 s.
    const c = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75].map((time) => ({ time, sharpness: time < 2.5 ? 2 : 500 + time }));
    assert.deepEqual(frames.pickClipFrames(c, 2).map((x) => x.time), [2.75, 3.75]);
  });

  it("pickClipFrames keeps every candidate when asked for all of them", () => {
    const c = [0, 1, 2].map((time) => ({ time, sharpness: [1, 10, 9][time] }));
    assert.deepEqual(frames.pickClipFrames(c, 3).map((x) => x.time), [0, 1, 2]);
  });

  it("parseFfmpegDuration reads the Duration line", () => {
    assert.equal(frames.parseFfmpegDuration("  Duration: 00:01:02.50, start: 0.000000, bitrate: 1 kb/s"), 62.5);
    assert.equal(frames.parseFfmpegDuration("Duration: N/A, bitrate: N/A"), null);
    assert.equal(frames.parseFfmpegDuration(""), null);
  });
});

describe("manifest", () => {
  it("tracks samples and frames per variant and lists missing surfaces", () => {
    let m = manifest.emptyManifest("Zoya - Arizona", "warm");
    assert.deepEqual(manifest.surfacesToUpload(m, 1, ["front", "glass"]), ["front", "glass"]);
    m = manifest.withSample(m, { variant: 1, sampleId: "10", label: "external", notes: "take warm" });
    m = manifest.withFrame(m, 1, { surface: "front", source: "front.jpg", frameId: "100" });
    assert.deepEqual(manifest.surfacesToUpload(m, 1, ["front", "glass"]), ["glass"]);
    assert.deepEqual(manifest.surfacesToUpload(m, 2, ["front"]), ["front"]);
    m = manifest.withFrame(m, 1, { surface: "front", source: "front2.jpg", frameId: "101" });
    assert.deepEqual(manifest.findSample(m, 1).frames, [{ surface: "front", source: "front2.jpg", frameId: "101" }]);
    assert.throws(() => manifest.withFrame(m, 2, { surface: "box", source: "box.jpg", frameId: "1" }), /variant 2/);
  });

  it("is immutable and keeps samples sorted by variant", () => {
    const empty = manifest.emptyManifest("b", null);
    const two = manifest.withSample(empty, { variant: 2, sampleId: "2", label: "", notes: null });
    const both = manifest.withSample(two, { variant: 1, sampleId: "1", label: "", notes: null });
    assert.equal(empty.samples.length, 0);
    assert.deepEqual(both.samples.map((s) => s.variant), [1, 2]);
  });

  it("parseManifest round-trips and drops malformed entries", () => {
    let m = manifest.withSample(manifest.emptyManifest("b", null), { variant: 1, sampleId: "7", label: "x", notes: null });
    m = manifest.withFrame(m, 1, { surface: "glass", source: "glass.mov@1.500s", frameId: "70" });
    assert.deepEqual(manifest.parseManifest(JSON.stringify(m), "b", null), m);
    const messy = {
      version: 1,
      samples: [
        { variant: 1, sampleId: "7", frames: [{ surface: "lid", source: "x", frameId: "1" }, { surface: "box", source: "box.jpg", frameId: "2" }] },
        { variant: 1, sampleId: "8", frames: [] },
        { variant: 0, sampleId: "9" },
        { variant: 2 },
      ],
    };
    const parsed = manifest.parseManifest(JSON.stringify(messy), "b", "dim");
    assert.equal(parsed.take, "dim");
    assert.deepEqual(parsed.samples, [
      { variant: 1, sampleId: "7", label: "", notes: null, frames: [{ surface: "box", source: "box.jpg", frameId: "2" }] },
    ]);
    assert.throws(() => manifest.parseManifest('{"version":2,"samples":[]}', "b", null), /version 1/);
    assert.throws(() => manifest.parseManifest("not json", "b", null));
  });
});

describe("parseArgs", () => {
  it("parses flags and validates --frames-per-clip", () => {
    const args = parseArgs(["--dir", "x", "--dry-run", "--frames-per-clip", "3", "--require-catalog", "--reset"]);
    assert.equal(args.dryRun, true);
    assert.equal(args.framesPerClip, 3);
    assert.equal(args.requireCatalog, true);
    assert.equal(args.reset, true);
    assert.ok(args.dir.endsWith("x"));
    assert.throws(() => parseArgs(["--frames-per-clip", "0"]), /frames-per-clip/);
    assert.throws(() => parseArgs(["--dir"]), /requires a value/);
    assert.throws(() => parseArgs(["--nope"]), /Unknown/);
  });
});
