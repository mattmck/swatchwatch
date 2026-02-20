const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { stripTypeScriptTypes } = require("node:module");

let ts = null;
try {
  ts = require("typescript");
} catch {
  // Optional in this test harness; fallback uses node:module stripTypeScriptTypes.
}

const FILTERS_TS_PATH = path.resolve(
  __dirname,
  "../../../apps/web/src/lib/polish-filters.ts"
);
const COLOR_UTILS_PATH = path.resolve(
  __dirname,
  "../../../apps/web/src/lib/color-utils.ts"
);

let importedFiltersPromise;

/**
 * Transpile a TypeScript source file (or provided source text) into a JS file.
 *
 * @param {object} options - Transpile options.
 * @param {string} options.sourcePath - Absolute path of the original TypeScript source.
 * @param {string} options.outputDir - Directory where the transpiled file is written.
 * @param {string} options.outputFileName - Output JavaScript filename.
 * @param {string} [options.sourceText] - Optional source text override.
 * @returns {Promise<string>} Absolute path to the written JavaScript file.
 */
async function transpileToJsFile({
  sourcePath,
  outputDir,
  outputFileName,
  sourceText,
}) {
  const text = sourceText ?? (await fs.readFile(sourcePath, "utf8"));
  const outputText = ts?.transpileModule
    ? ts.transpileModule(text, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: path.basename(sourcePath),
    }).outputText
    : stripTypeScriptTypes(text);

  const outputPath = path.join(outputDir, outputFileName);
  await fs.writeFile(outputPath, outputText, "utf8");
  return outputPath;
}

/**
 * Import polish filter helpers by transpiling source TS modules into temporary JS files.
 *
 * Uses a cached promise to avoid repeated transpilation, writes temporary files under `os.tmpdir()`,
 * and returns the imported module namespace (or default export for CommonJS interop).
 *
 * @returns {Promise<Record<string, unknown>>} Imported polish filter helper module.
 */
async function importFilters() {
  if (!importedFiltersPromise) {
    importedFiltersPromise = (async () => {
      // Transpile TS helpers to temporary JS so node --test can import them.
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "swatchwatch-polish-filters-")
      );

      await transpileToJsFile({
        sourcePath: COLOR_UTILS_PATH,
        outputDir: tempDir,
        outputFileName: "color-utils.js",
      });

      const filtersSource = await fs.readFile(FILTERS_TS_PATH, "utf8");
      const rewrittenFiltersSource = filtersSource
        .replace('from "@/lib/color-utils"', 'from "./color-utils.js"')
        .replace('from "./color-utils"', 'from "./color-utils.js"');

      const filtersJsPath = await transpileToJsFile({
        sourcePath: FILTERS_TS_PATH,
        outputDir: tempDir,
        outputFileName: "polish-filters.js",
        sourceText: rewrittenFiltersSource,
      });

      const imported = await import(pathToFileURL(filtersJsPath).href);
      return imported.default ?? imported;
    })();
  }

  return importedFiltersPromise;
}

/**
 * Build a minimal `Polish`-shaped test object with optional field overrides.
 *
 * @param {Record<string, unknown>} [overrides={}] - Partial values to override defaults.
 * @returns {Record<string, unknown>} Test polish object for filter scenarios.
 */
function createPolish(overrides = {}) {
  return {
    id: `id-${Math.random().toString(16).slice(2)}`,
    shadeId: "shade-1",
    userId: "1",
    brand: "Brand",
    name: "Name",
    color: "Color",
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

test("polish-filters: buildBrandOptions deduplicates case-insensitively and preserves first casing", async () => {
  const { buildBrandOptions } = await importFilters();
  const polishes = [
    createPolish({ brand: "  ILNP  " }),
    createPolish({ brand: "ilnp" }),
    createPolish({ brand: "Mooncat" }),
    createPolish({ brand: " mooncat " }),
  ];

  const options = buildBrandOptions(polishes);
  assert.deepEqual(options, ["ILNP", "Mooncat"]);
});

test("polish-filters: filterPolishesForList matches brand case-insensitively and trims whitespace", async () => {
  const { filterPolishesForList } = await importFilters();
  const polishes = [
    createPolish({ id: "a", brand: "  ILNP  ", quantity: 1 }),
    createPolish({ id: "b", brand: "ilnp", quantity: 0 }),
    createPolish({ id: "c", brand: "Mooncat", quantity: 1 }),
  ];

  const filtered = filterPolishesForList({
    polishes,
    search: "",
    includeAll: true,
    toneFilter: "all",
    brandFilter: " iLnP ",
    finishFilter: "all",
    availabilityFilter: "all",
  });

  assert.deepEqual(
    filtered.map((p) => p.id).sort(),
    ["a", "b"]
  );
});

test("polish-filters: filterPolishesForList composes brand + owned + tone filters correctly", async () => {
  const { filterPolishesForList } = await importFilters();
  const polishes = [
    createPolish({
      id: "owned-warm",
      brand: "ILNP",
      quantity: 1,
      vendorHex: "#FF0000",
    }),
    createPolish({
      id: "wishlist-cool",
      brand: "ilnp ",
      quantity: 0,
      detectedHex: "#0000FF",
    }),
    createPolish({
      id: "vendor-priority",
      brand: "ILNP",
      quantity: 0,
      vendorHex: "#FF0000",
      detectedHex: "#0000FF",
    }),
  ];

  const coolInBrand = filterPolishesForList({
    polishes,
    search: "",
    includeAll: true,
    toneFilter: "cool",
    brandFilter: "ilnp",
    finishFilter: "all",
    availabilityFilter: "all",
  });
  assert.deepEqual(coolInBrand.map((p) => p.id), ["wishlist-cool"]);

  const coolOwnedOnly = filterPolishesForList({
    polishes,
    search: "",
    includeAll: false,
    toneFilter: "cool",
    brandFilter: "ilnp",
    finishFilter: "all",
    availabilityFilter: "all",
  });
  assert.equal(coolOwnedOnly.length, 0);

  const coolWishlistOnly = filterPolishesForList({
    polishes,
    search: "",
    includeAll: true,
    toneFilter: "cool",
    brandFilter: "ilnp",
    finishFilter: "all",
    availabilityFilter: "wishlist",
  });
  assert.deepEqual(coolWishlistOnly.map((p) => p.id), ["wishlist-cool"]);
});
