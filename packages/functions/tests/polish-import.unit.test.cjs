/**
 * CSV / spreadsheet import (issue #263): the shared CSV parser and header detection, cell
 * value parsing, finish normalization, candidate ranking / classification, review decisions,
 * the upsert body, and the import handlers (batched matching, idempotent commit, and
 * per-user isolation of sessions). Runs without a database: the same require-interception
 * mocking as inventory-status.unit.test.cjs, with SQL routed by statement text.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

delete process.env.REDIS_URL;
delete process.env.REDIS_KEY;

const registeredRoutes = {};
const registeredTimers = {};
let queryMock = async () => ({ rows: [] });
let transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });

const mockModules = {};
function registerMock(id, exports) {
  mockModules[id] = exports;
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

registerMock("@azure/functions", {
  app: {
    http: (name, opts) => {
      registeredRoutes[name] = opts;
    },
    storageQueue: () => {},
    timer: (name, opts) => {
      registeredTimers[name] = opts;
    },
  },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", {
  errors: { JOSEError: class JOSEError extends Error {} },
  createRemoteJWKSet: () => {},
  jwtVerify: async () => ({ payload: {} }),
});
const dbMock = {
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);
registerMock("../lib/ai-color-detection", {
  detectHexWithAzureOpenAI: async () => ({ hex: "#ABCDEF", confidence: 0.9, finishes: [], provider: "azure-openai" }),
});
registerMock("../lib/blob-storage", {
  isCatalogStorageUrl: () => false,
  isUserMediaStorageUrl: () => false,
  readBlobFromStorageUrl: async () => {
    throw new Error("blob reads are not exercised here");
  },
});
for (const [id, exports] of Object.entries(mockModules)) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const shared = require("swatchwatch-shared");
const lib = require("../dist/lib/polish-import");
const finishes = require("../dist/lib/finishes");
require("../dist/functions/polish-imports");

afterEach(() => {
  queryMock = async () => ({ rows: [] });
  transactionMock = async (cb) => cb({ query: async () => ({ rows: [] }) });
  delete process.env.AUTH_DEV_BYPASS;
  finishes.resetFinishAliasCache();
});

// ═══════════════════════════════════════════════════════════════════════════
// Shared CSV parser
// ═══════════════════════════════════════════════════════════════════════════

describe("parseCsv", () => {
  const { parseCsv, detectCsvDelimiter } = shared;

  it("parses quoted fields with embedded commas, quotes and newlines", () => {
    const text = 'brand,name,notes\r\nEssie,"Ballet, Slippers","She said ""wow""\nsecond line"\r\nOPI,Funny Bunny,\r\n';
    const result = parseCsv(text);
    assert.deepEqual(result.records, [
      ["brand", "name", "notes"],
      ["Essie", "Ballet, Slippers", 'She said "wow"\nsecond line'],
      ["OPI", "Funny Bunny", ""],
    ]);
    // The OPI record starts on physical line 4 because the quoted note spans two lines.
    assert.deepEqual(result.lineNumbers, [1, 2, 4]);
    assert.equal(result.delimiter, ",");
    assert.equal(result.unterminatedQuote, false);
  });

  it("strips a UTF-8 BOM and handles LF, CR and CRLF line endings", () => {
    const result = parseCsv("﻿brand,name\rA,B\nC,D\r\nE,F");
    assert.deepEqual(result.records, [["brand", "name"], ["A", "B"], ["C", "D"], ["E", "F"]]);
  });

  it("detects ; and tab delimiters, and honors an Excel sep= line", () => {
    assert.equal(detectCsvDelimiter("brand;name;price\nEssie;Wicked;9,50\nOPI;Bunny;12,00"), ";");
    assert.deepEqual(parseCsv("brand;name;price\nEssie;Wicked;9,50").records[1], ["Essie", "Wicked", "9,50"]);
    assert.equal(detectCsvDelimiter("brand\tname\nEssie\tWicked"), "\t");
    const sep = parseCsv("sep=;\nbrand;name\nA;B");
    assert.equal(sep.delimiter, ";");
    assert.deepEqual(sep.records, [["brand", "name"], ["A", "B"]]);
    assert.deepEqual(sep.lineNumbers, [2, 3]);
  });

  it("does not pick , for a ; sheet whose quoted cells contain commas", () => {
    assert.equal(detectCsvDelimiter('brand;name;notes\n"A, B";X;"1,2,3"\nC;D;E'), ";");
  });

  it("drops blank records but keeps line numbers, and tolerates an unterminated quote", () => {
    const result = parseCsv('a,b\n\n , \nc,"d\n');
    assert.deepEqual(result.records, [["a", "b"], ["c", "d\n"]]);
    assert.deepEqual(result.lineNumbers, [1, 4]);
    assert.equal(result.unterminatedQuote, true);
  });

  it("treats a quote inside an unquoted field as a literal character", () => {
    assert.deepEqual(parseCsv('brand,size\nEssie,5" bottle').records[1], ["Essie", '5" bottle']);
  });

  it("stops at maxRecords and reports truncation only when content remains", () => {
    const text = "a\nb\nc\nd";
    assert.equal(parseCsv(text, { maxRecords: 2 }).truncated, true);
    assert.equal(parseCsv(text, { maxRecords: 4 }).truncated, false);
    assert.equal(parseCsv("a\nb\n\n", { maxRecords: 2 }).truncated, false);
  });

  it("returns no records for empty input", () => {
    assert.deepEqual(parseCsv("").records, []);
    assert.deepEqual(parseCsv("﻿\n\n").records, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Header detection
// ═══════════════════════════════════════════════════════════════════════════

describe("detectPolishImportHeader", () => {
  const { detectPolishImportHeader } = shared;

  it("maps common spreadsheet headers case- and space-insensitively", () => {
    const result = detectPolishImportHeader([
      ["  BRAND ", "Shade Name", "Finish", "Qty", "Price Paid", "Currency", "Date Purchased", "Status", "Tried?", "Notes"],
    ]);
    assert.equal(result.headerRowIndex, 0);
    assert.equal(result.confident, true);
    assert.deepEqual(result.mapping, {
      brand: 0, name: 1, finish: 2, quantity: 3, price: 4, currency: 5, purchaseDate: 6, status: 7, tried: 8, notes: 9,
    });
  });

  it("finds the header below a title block", () => {
    const result = detectPolishImportHeader([["My Polish Collection"], ["Updated Oct 2026", ""], ["Polish", "Brand", "Color"], ["Wicked", "Essie", "red"]]);
    assert.equal(result.headerRowIndex, 2);
    assert.equal(result.mapping.name, 0);
    assert.equal(result.mapping.brand, 1);
    assert.equal(result.mapping.finish, undefined);
  });

  it("accepts the collection export's headers (#264) and ignores its export-only columns", () => {
    const result = detectPolishImportHeader([
      [
        "brand", "name", "finish(es)", "quantity", "status", "tried date", "purchase price", "currency",
        "purchase/acquired date", "notes", "display hex", "color family", "shade id",
      ],
    ]);
    assert.equal(result.confident, true);
    assert.deepEqual(result.mapping, {
      brand: 0, name: 1, finish: 2, quantity: 3, status: 4, tried: 5, price: 6, currency: 7, purchaseDate: 8, notes: 9,
    });
  });

  it("round-trips the collection export's exact headers (#264, POLISH_CSV_COLUMNS) with high confidence", () => {
    const headers = [
      "Brand", "Shade name", "Finishes", "Quantity", "Status", "Date tried", "Purchase price", "Currency",
      "Purchase date", "Notes",
      // export-only columns
      "Display hex", "Collection", "Rating", "Tags", "Size", "Expiration date", "Last worn", "Wear count",
      "Shade ID", "Item ID", "Created at", "Updated at",
    ];
    for (const header of headers.slice(10)) {
      assert.equal(shared.matchImportHeader(header), null, `${header} must not map to an import field`);
    }
    const result = detectPolishImportHeader([headers]);
    assert.equal(result.headerRowIndex, 0);
    assert.equal(result.confident, true);
    assert.deepEqual(result.mapping, {
      brand: 0, name: 1, finish: 2, quantity: 3, status: 4, tried: 5, price: 6, currency: 7, purchaseDate: 8, notes: 9,
    });
    // "Shade ID" before "Shade name" still doesn't take the name field.
    assert.equal(detectPolishImportHeader([["Shade ID", "Brand", "Shade name"]]).mapping.name, 2);
    assert.equal(detectPolishImportHeader([["Shade ID", "Brand", "Shade name"]]).mapping.brand, 1);
  });

  it("parses an exported row: joined finishes, a tried date and formula-guarded cells", () => {
    const csv = [
      "Brand,Shade name,Finishes,Quantity,Status,Date tried,Purchase price,Currency,Purchase date,Notes,Shade ID",
      `Holo Taco,'-Minus Shade,"holographic, shimmer",1,owned,2026-02-01,12.5,USD,2026-01-15,'=not a formula,42`,
    ].join("\n");
    const [row] = lib.buildImportRows(csv, { now: new Date("2026-10-17T00:00:00Z") }).rows;
    assert.deepEqual(row.values, {
      brand: "Holo Taco",
      name: "-Minus Shade",
      finishes: ["holographic", "shimmer"],
      quantity: 1,
      status: "owned",
      tried: true,
      triedOn: "2026-02-01",
      purchasePrice: 12.5,
      purchaseCurrency: "USD",
      purchaseDate: "2026-01-15",
      notes: "=not a formula",
    });
    assert.deepEqual(row.warnings, []);
    assert.equal(shared.stripFormulaGuard("'@x"), "@x");
    assert.equal(shared.stripFormulaGuard("'quoted"), "'quoted");
  });

  it("understands camelCase headers", () => {
    const result = detectPolishImportHeader([["brand", "name", "purchaseDate", "purchasePrice", "triedAt"]]);
    assert.equal(result.mapping.purchaseDate, 2);
    assert.equal(result.mapping.price, 3);
    assert.equal(result.mapping.tried, 4);
  });

  it("prefers a strong column over a weak one for the same field", () => {
    const result = detectPolishImportHeader([["Color", "Brand", "Shade"]]);
    assert.equal(result.mapping.name, 2);
    assert.equal(result.confident, true);
  });

  it("is not confident when brand or name come from weak synonyms only", () => {
    const result = detectPolishImportHeader([["Company", "Color", "Qty"]]);
    assert.equal(result.headerRowIndex, 0);
    assert.equal(result.mapping.brand, 0);
    assert.equal(result.mapping.name, 1);
    assert.equal(result.confident, false);
  });

  it("reports no header for a headerless sheet", () => {
    const result = detectPolishImportHeader([["Essie", "Wicked", "creme"], ["OPI", "Funny Bunny", "sheer"]]);
    assert.equal(result.headerRowIndex, -1);
    assert.equal(result.confident, false);
  });

  it("validates explicit mappings", () => {
    const { validateImportMapping } = shared;
    assert.equal(validateImportMapping({ brand: 0, name: 1 }, 3), null);
    assert.match(validateImportMapping({ brand: 0 }, 3), /Shade name/);
    assert.match(validateImportMapping({ brand: 0, name: 0 }, 3), /both/);
    assert.match(validateImportMapping({ brand: 0, name: 5 }, 3), /out of range/);
    assert.match(validateImportMapping({ brand: 0, name: 1, color: 2 }, 3), /Unknown import field/);
    assert.match(validateImportMapping([], 3), /object/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cell values
// ═══════════════════════════════════════════════════════════════════════════

describe("import cell parsing", () => {
  it("parses quantities", () => {
    assert.deepEqual(shared.parseImportQuantity("2"), { value: 2 });
    assert.deepEqual(shared.parseImportQuantity(" 3 bottles "), { value: 3 });
    assert.deepEqual(shared.parseImportQuantity("1.0"), { value: 1 });
    assert.deepEqual(shared.parseImportQuantity(""), {});
    assert.ok(shared.parseImportQuantity("1.5").error);
    assert.ok(shared.parseImportQuantity("-1").error);
    assert.ok(shared.parseImportQuantity("lots").error);
  });

  it("parses prices in common formats and picks up unambiguous currencies", () => {
    assert.deepEqual(shared.parseImportPrice("$9.50"), { value: 9.5, currency: undefined });
    assert.deepEqual(shared.parseImportPrice("12,50 €"), { value: 12.5, currency: "EUR" });
    assert.deepEqual(shared.parseImportPrice("£8"), { value: 8, currency: "GBP" });
    assert.deepEqual(shared.parseImportPrice("USD 1,234.50"), { value: 1234.5, currency: "USD" });
    assert.deepEqual(shared.parseImportPrice("1.234,50"), { value: 1234.5, currency: undefined });
    assert.deepEqual(shared.parseImportPrice(""), {});
    assert.ok(shared.parseImportPrice("free").error);
    assert.ok(shared.parseImportPrice("1.2.3").error);
  });

  it("parses currencies", () => {
    assert.deepEqual(shared.parseImportCurrency("usd"), { value: "USD" });
    assert.deepEqual(shared.parseImportCurrency("€"), { value: "EUR" });
    assert.ok(shared.parseImportCurrency("dollars").error);
  });

  it("parses dates and detects the column's day order", () => {
    const { parseImportDate, detectImportDateOrder } = shared;
    assert.deepEqual(parseImportDate("2026-03-15"), { value: "2026-03-15" });
    assert.deepEqual(parseImportDate("2026/3/5"), { value: "2026-03-05" });
    assert.deepEqual(parseImportDate("2026-03-15T10:00:00Z"), { value: "2026-03-15" });
    assert.deepEqual(parseImportDate("03/04/2026"), { value: "2026-03-04" });
    assert.deepEqual(parseImportDate("03/04/2026", "dmy"), { value: "2026-04-03" });
    assert.deepEqual(parseImportDate("3/4/26"), { value: "2026-03-04" });
    assert.deepEqual(parseImportDate("Oct 17, 2026"), { value: "2026-10-17" });
    assert.deepEqual(parseImportDate("17th September 2026"), { value: "2026-09-17" });
    assert.deepEqual(parseImportDate("October 2026"), { value: "2026-10-01" });
    assert.ok(parseImportDate("2026-02-30").error);
    assert.ok(parseImportDate("someday").error);
    assert.equal(detectImportDateOrder(["03/04/2026", "25/12/2025"]), "dmy");
    assert.equal(detectImportDateOrder(["03/04/2026", "12/25/2025"]), "mdy");
    assert.equal(detectImportDateOrder(["03/04/2026"]), "mdy");
  });

  it("maps status synonyms onto the #261 statuses", () => {
    assert.deepEqual(shared.parseImportStatus("Owned"), { value: "owned" });
    assert.deepEqual(shared.parseImportStatus("Wish List"), { value: "wishlist" });
    assert.deepEqual(shared.parseImportStatus("for sale"), { value: "destash" });
    assert.deepEqual(shared.parseImportStatus("Used up!"), { value: "archived" });
    assert.deepEqual(shared.parseImportStatus(""), {});
    assert.ok(shared.parseImportStatus("maybe").error);
  });

  it("parses tried as yes/no or a date", () => {
    assert.deepEqual(shared.parseImportTried("Yes"), { value: true });
    assert.deepEqual(shared.parseImportTried("✓"), { value: true });
    assert.deepEqual(shared.parseImportTried("no"), { value: false });
    assert.deepEqual(shared.parseImportTried("2026-05-01"), { value: true, date: "2026-05-01" });
    assert.deepEqual(shared.parseImportTried(""), {});
    assert.ok(shared.parseImportTried("kinda").error);
  });

  it("splits multi-finish cells", () => {
    assert.deepEqual(shared.splitImportFinishes("Holo / Shimmer"), ["Holo", "Shimmer"]);
    assert.deepEqual(shared.splitImportFinishes("jelly, glitter + flakies"), ["jelly", "glitter", "flakies"]);
    assert.deepEqual(shared.splitImportFinishes(""), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildImportRows (parse + map + validate + finish normalization)
// ═══════════════════════════════════════════════════════════════════════════

describe("buildImportRows", () => {
  const NOW = new Date("2026-10-17T12:00:00Z");

  it("builds validated rows with warnings for unusable cells", () => {
    const csv = [
      "Brand,Shade,Finish,Qty,Price,Currency,Purchased,Status,Tried,Notes",
      'Essie,Wicked,"cream / holo",2,$9.50,usd,10/01/2026,owned,yes,"great, red"',
      "OPI,Funny Bunny,sparkly-ish,many,free,dollars,someday,maybe,kinda,",
      ",No Brand,,,,,,,,",
    ].join("\n");
    const parsed = lib.buildImportRows(csv, { now: NOW });
    assert.equal(parsed.headerRowIndex, 0);
    assert.equal(parsed.confident, true);
    const [good, messy, invalid] = parsed.rows;
    assert.equal(good.rowNumber, 2);
    assert.deepEqual(good.values, {
      brand: "Essie",
      name: "Wicked",
      finishes: ["creme", "holographic"],
      quantity: 2,
      purchasePrice: 9.5,
      purchaseCurrency: "USD",
      purchaseDate: "2026-10-01",
      status: "owned",
      tried: true,
      notes: "great, red",
    });
    assert.deepEqual(good.warnings, []);
    assert.equal(good.action, "pending");

    assert.deepEqual(messy.values, { brand: "OPI", name: "Funny Bunny", finishes: [] });
    assert.equal(messy.warnings.length, 7, messy.warnings.join("\n"));
    assert.equal(messy.matchState, "unmatched");

    assert.equal(invalid.matchState, "invalid");
    assert.equal(invalid.action, "skip");
    assert.deepEqual(invalid.errors, ["Brand is missing"]);
  });

  it("normalizes finishes through the finish catalog, including admin-created finish types", () => {
    const catalog = {
      validNames: new Set(["creme", "holographic", "aurora"]),
      aliases: new Map([["holo", "holographic"], ["northern lights", "aurora"]]),
    };
    const parsed = lib.buildImportRows("brand,name,finish\nA,B,Northern Lights / HOLO / creme\nA,C,shimmer", {
      finishCatalog: catalog,
      now: NOW,
    });
    assert.deepEqual(parsed.rows[0].values.finishes, ["aurora", "holographic", "creme"]);
    assert.deepEqual(parsed.rows[1].values.finishes, []);
    assert.deepEqual(parsed.rows[1].warnings, ['Unknown finish "shimmer" ignored']);
  });

  it("runs inventory validation (#261) on prices and dates", () => {
    const parsed = lib.buildImportRows("brand,name,price,purchase date,tried\nA,B,123456789,2027-01-01,2027-01-01", { now: NOW });
    const row = parsed.rows[0];
    assert.equal(row.values.purchasePrice, undefined);
    assert.equal(row.values.purchaseDate, undefined);
    assert.equal(row.values.triedOn, undefined);
    assert.equal(row.values.tried, true);
    assert.equal(row.warnings.length, 3, row.warnings.join("\n"));
  });

  it("uses an explicit mapping and header row (including headerless sheets)", () => {
    const parsed = lib.buildImportRows("Essie;Wicked;2\nOPI;Funny Bunny;1", {
      mapping: { brand: 0, name: 1, quantity: 2 },
      headerRowIndex: -1,
      now: NOW,
    });
    assert.equal(parsed.delimiter, ";");
    assert.deepEqual(parsed.headers, []);
    assert.equal(parsed.rows.length, 2);
    assert.deepEqual(parsed.rows[1].values, { brand: "OPI", name: "Funny Bunny", finishes: [], quantity: 1 });
    assert.equal(parsed.rows[0].rowNumber, 1);
  });

  it("detects the day order across the date column", () => {
    const parsed = lib.buildImportRows("brand,name,date bought\nA,B,03/04/2026\nA,C,25/12/2025", { now: NOW });
    assert.equal(parsed.rows[0].values.purchaseDate, "2026-04-03");
    assert.equal(parsed.rows[1].values.purchaseDate, "2025-12-25");
  });

  it("rejects files without usable columns, without rows, or over the row cap", () => {
    assert.throws(() => lib.buildImportRows(""), /no rows/);
    assert.throws(() => lib.buildImportRows("foo,bar\n1,2"), (error) => error.status === 422);
    assert.throws(() => lib.buildImportRows("brand,name\n"), /no data rows/);
    assert.throws(() => lib.buildImportRows("a,b\n1,2", { mapping: { brand: 0 } }), /Shade name/);
    assert.throws(() => lib.buildImportRows("a,b\n1,2", { mapping: { brand: 0, name: 1 }, headerRowIndex: 7 }), /out of range/);
    const rows = ["brand,name"];
    for (let i = 0; i <= shared.POLISH_IMPORT_MAX_ROWS; i += 1) rows.push(`A,Shade ${i}`);
    assert.throws(() => lib.buildImportRows(rows.join("\n")), /limited to 1000 rows/);
    rows.pop();
    assert.equal(lib.buildImportRows(rows.join("\n")).rows.length, shared.POLISH_IMPORT_MAX_ROWS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Matching
// ═══════════════════════════════════════════════════════════════════════════

function hit(overrides) {
  return {
    shadeId: "1",
    brand: "Essie",
    name: "Wicked",
    finishes: ["creme"],
    hex: "#880011",
    brandSimilarity: 1,
    nameSimilarity: 1,
    inCollection: false,
    userSubmitted: false,
    ...overrides,
  };
}

describe("candidate ranking and classification", () => {
  const values = { brand: "Essie", name: "Wicked", finishes: [] };

  it("scores exact brand + name as 1 and weights brand vs name", () => {
    assert.equal(lib.scoreCandidate(values, hit({ brandSimilarity: 0.2, nameSimilarity: 0.3 })), 1);
    assert.equal(
      lib.scoreCandidate({ brand: "Esie", name: "Wiked", finishes: [] }, hit({ brandSimilarity: 0.5, nameSimilarity: 0.6 })),
      Math.round((0.35 * 0.5 + 0.65 * 0.6) * 1000) / 1000
    );
  });

  it("nudges by finish agreement", () => {
    const row = { brand: "Essie", name: "Wiked", finishes: ["creme"] };
    const base = lib.scoreCandidate({ ...row, finishes: [] }, hit({ name: "Wicked", nameSimilarity: 0.6 }));
    assert.equal(lib.scoreCandidate(row, hit({ nameSimilarity: 0.6 })), Math.round((base + 0.05) * 1000) / 1000);
    assert.equal(lib.scoreCandidate(row, hit({ nameSimilarity: 0.6, finishes: ["glitter"] })), Math.round((base - 0.05) * 1000) / 1000);
  });

  it("matches a single exact candidate even when near-duplicates score close", () => {
    const row = { brand: "Indie", name: "Shade 1", finishes: [] };
    const candidates = lib.rankCandidates(row, [
      hit({ shadeId: "10", brand: "Indie", name: "Shade 10", nameSimilarity: 0.85 }),
      hit({ shadeId: "1", brand: "Indie", name: "Shade 1" }),
    ]);
    assert.equal(candidates[0].shadeId, "1");
    assert.equal(candidates[0].exactMatch, true);
    assert.deepEqual(lib.classifyMatch(candidates), { state: "matched", shadeId: "1" });
  });

  it("uses the row's finish to choose between exact same-name shades, else ambiguous", () => {
    const hits = [hit({ shadeId: "1", finishes: ["creme"] }), hit({ shadeId: "2", finishes: ["holographic"] })];
    const withFinish = lib.rankCandidates({ ...values, finishes: ["holographic"] }, hits);
    assert.deepEqual(lib.classifyMatch(withFinish, ["holographic"]), { state: "matched", shadeId: "2" });
    const without = lib.rankCandidates(values, hits);
    assert.deepEqual(lib.classifyMatch(without, []), { state: "ambiguous", shadeId: null });
  });

  it("classifies by score and margin when nothing is exact", () => {
    const row = { brand: "Essie", name: "Wiked", finishes: [] };
    const clear = lib.rankCandidates(row, [hit({ nameSimilarity: 0.9 }), hit({ shadeId: "2", name: "Wild", nameSimilarity: 0.3 })]);
    assert.equal(clear[0].confidence >= lib.MATCHED_MIN_CONFIDENCE, true);
    assert.equal(lib.classifyMatch(clear).state, "matched");
    const close = lib.rankCandidates(row, [hit({ nameSimilarity: 0.9 }), hit({ shadeId: "2", name: "Wicked Wine", nameSimilarity: 0.88 })]);
    assert.equal(lib.classifyMatch(close).state, "ambiguous");
    const weak = lib.rankCandidates(row, [hit({ brand: "Other", brandSimilarity: 0, nameSimilarity: 0.75 })]);
    assert.equal(lib.classifyMatch(weak).state, "ambiguous");
    const none = lib.rankCandidates(row, [hit({ brand: "Other", brandSimilarity: 0, nameSimilarity: 0.6 })]);
    assert.equal(lib.classifyMatch(none).state, "unmatched");
    assert.equal(lib.classifyMatch([]).state, "unmatched");
  });

  it("merges duplicate hits, prefers shades already in the collection on ties, and caps at 5", () => {
    const hits = [
      hit({ shadeId: "3", nameSimilarity: 0.7, name: "Wick" }),
      hit({ shadeId: "3", nameSimilarity: 0.8, name: "Wick" }),
      hit({ shadeId: "4", nameSimilarity: 0.8, name: "Wick", inCollection: true }),
      ...[5, 6, 7, 8, 9].map((n) => hit({ shadeId: String(n), name: `X${n}`, nameSimilarity: 0.4 })),
    ];
    const ranked = lib.rankCandidates({ brand: "Essie", name: "Wiced", finishes: [] }, hits);
    assert.equal(ranked.length, 5);
    assert.deepEqual(ranked.slice(0, 2).map((c) => c.shadeId), ["4", "3"]);
  });

  it("withMatchResult pre-selects matched rows and leaves the rest pending", () => {
    const [row] = lib.buildImportRows("brand,name\nEssie,Wicked").rows;
    const matched = lib.withMatchResult(row, [hit({})]);
    assert.equal(matched.matchState, "matched");
    assert.equal(matched.action, "match");
    assert.equal(matched.shadeId, "1");
    const unmatched = lib.withMatchResult(row, []);
    assert.equal(unmatched.action, "pending");
    assert.equal(unmatched.shadeId, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Decisions + upsert body
// ═══════════════════════════════════════════════════════════════════════════

describe("review decisions", () => {
  const rows = lib.buildImportRows("brand,name\nEssie,Wicked\n,Nameless").rows.map((row) =>
    row.matchState === "invalid" ? row : lib.withMatchResult(row, [hit({ nameSimilarity: 0.9, name: "Wickd" })])
  );

  it("validates the decisions body", () => {
    assert.deepEqual(lib.parseDecisions(undefined), []);
    assert.throws(() => lib.parseDecisions({}), /decisions must be an array/);
    assert.throws(() => lib.parseDecisions({ decisions: [{ rowNumber: 0, action: "skip" }] }), /rowNumber/);
    assert.throws(() => lib.parseDecisions({ decisions: [{ rowNumber: 2, action: "delete" }] }), /action/);
    assert.throws(() => lib.parseDecisions({ decisions: [{ rowNumber: 2, action: "match", shadeId: "12abc" }] }), /shadeId/);
    assert.deepEqual(lib.parseDecisions({ decisions: [{ rowNumber: 2, action: "match", shadeId: 7 }] }), [
      { rowNumber: 2, action: "match", shadeId: "7" },
    ]);
  });

  it("applies decisions and lists picked shades that need a visibility check", () => {
    const applied = lib.applyDecisions(rows, [
      { rowNumber: 2, action: "match", shadeId: "99" },
      { rowNumber: 3, action: "skip" },
    ]);
    assert.equal(applied.rows[0].action, "match");
    assert.equal(applied.rows[0].shadeId, "99");
    assert.deepEqual(applied.shadeIdsToVerify, ["99"]);
    assert.deepEqual(lib.applyDecisions(rows, [{ rowNumber: 2, action: "match", shadeId: "1" }]).shadeIdsToVerify, []);
    assert.equal(lib.applyDecisions(rows, [{ rowNumber: 2, action: "create" }]).rows[0].shadeId, null);
  });

  it("rejects unknown rows and non-skip decisions on invalid rows", () => {
    assert.throws(() => lib.applyDecisions(rows, [{ rowNumber: 40, action: "skip" }]), /not in this import/);
    assert.throws(() => lib.applyDecisions(rows, [{ rowNumber: 3, action: "create" }]), /only be skipped/);
  });
});

describe("buildUpsertRequest", () => {
  const NOW = new Date("2026-10-17T12:00:00Z");
  const fresh = { inCollection: false, triedAt: null };

  it("defaults a new row to owned, or wishlist for quantity 0, and keeps an existing row's status", () => {
    assert.equal(lib.buildUpsertRequest({ brand: "A", name: "B", finishes: [] }, fresh, NOW).body.status, "owned");
    assert.equal(lib.buildUpsertRequest({ brand: "A", name: "B", finishes: [], quantity: 0 }, fresh, NOW).body.status, "wishlist");
    const existing = lib.buildUpsertRequest({ brand: "A", name: "B", finishes: [] }, { inCollection: true, triedAt: null }, NOW);
    assert.equal(existing.body.status, undefined);
    assert.equal(existing.fields.status, undefined);
  });

  it("omits blank cells so re-imports never clear stored values", () => {
    const { body, fields } = lib.buildUpsertRequest({ brand: "A", name: "B", finishes: [] }, { inCollection: true, triedAt: null }, NOW);
    assert.deepEqual(body, {});
    assert.deepEqual(fields, { status: undefined, triedAt: undefined, purchasePrice: undefined, purchaseCurrency: undefined });
  });

  it("maps tried onto triedAt without overwriting an existing tried date", () => {
    const values = { brand: "A", name: "B", finishes: [], tried: true, purchaseDate: "2026-03-01" };
    assert.equal(lib.buildUpsertRequest(values, fresh, NOW).fields.triedAt, "2026-03-01T00:00:00.000Z");
    assert.equal(lib.buildUpsertRequest({ ...values, purchaseDate: undefined }, fresh, NOW).fields.triedAt, "2026-10-17T00:00:00.000Z");
    assert.equal(
      lib.buildUpsertRequest(values, { inCollection: true, triedAt: "2025-01-01T00:00:00.000Z" }, NOW).fields.triedAt,
      undefined
    );
    assert.equal(lib.buildUpsertRequest({ ...values, triedOn: "2026-05-05" }, fresh, NOW).fields.triedAt, "2026-05-05T00:00:00.000Z");
    assert.equal(lib.buildUpsertRequest({ ...values, tried: false }, fresh, NOW).fields.triedAt, null);
  });

  it("passes prices and currencies through the #261 validation", () => {
    const { fields } = lib.buildUpsertRequest(
      { brand: "A", name: "B", finishes: [], purchasePrice: 9.5, purchaseCurrency: "EUR" },
      fresh,
      NOW
    );
    assert.equal(fields.purchasePrice, 9.5);
    assert.equal(fields.purchaseCurrency, "EUR");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_ID = "7f0c9a52-8a1e-4c55-9a43-2f4f1d3b6c11";

function fakeRequest({ method = "GET", params = {}, body, user = 1, auth = true } = {}) {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    method,
    url: "http://localhost:7071/api/polish-imports",
    headers: {
      get: (name) => {
        const lower = name.toLowerCase();
        if (lower === "authorization") return auth ? `Bearer dev:${user}` : null;
        if (lower === "content-length") return String(Buffer.byteLength(text));
        return null;
      },
    },
    params,
    text: async () => text,
  };
}

function fakeContext() {
  return { log: () => {}, error: () => {}, warn: () => {}, invocationId: "test" };
}

/** Dev-bypass auth resolves `dev:<n>` to user n; every other statement is recorded. */
function authQuery(text, params) {
  if (/FROM\s+app_user/i.test(text)) {
    return { rows: [{ user_id: Number(params?.[0] ?? 1), external_id: `ext-${params?.[0]}`, email: null, role: "user" }] };
  }
  return null;
}

function storedSession(overrides = {}) {
  const rows = overrides.rows ?? [];
  return {
    id: SESSION_ID,
    fileName: "list.csv",
    status: "review",
    payload: { delimiter: ",", headers: ["brand", "name"], headerRowIndex: 0, mapping: { brand: 0, name: 1 }, rows },
    result: null,
    createdAt: new Date("2026-10-17T00:00:00Z"),
    expiresAt: new Date("2026-10-18T00:00:00Z"),
    committedAt: null,
    ...overrides,
    rows: undefined,
  };
}

/** A user-scoped session store: lookups only return the session for its owner. */
function sessionStore(owner, session) {
  return (text, params) => {
    if (/FROM polish_import_session/.test(text) && /SELECT/.test(text)) {
      const [id, userId] = params;
      return { rows: id === SESSION_ID && userId === owner ? [session] : [] };
    }
    return null;
  };
}

function baseRow(rowNumber, overrides = {}) {
  return {
    rowNumber,
    values: { brand: "Essie", name: `Shade ${rowNumber}`, finishes: [] },
    matchState: "matched",
    confidence: 1,
    candidates: [],
    action: "match",
    shadeId: String(100 + rowNumber),
    warnings: [],
    errors: [],
    ...overrides,
  };
}

describe("polish-imports routes", () => {
  it("registers the routes with auth-wrapped handlers and a cleanup timer", () => {
    assert.deepEqual(registeredRoutes["polish-imports-create"].methods, ["POST", "OPTIONS"]);
    assert.equal(registeredRoutes["polish-imports-create"].route, "polish-imports");
    assert.deepEqual(registeredRoutes["polish-imports-session"].methods, ["GET", "PATCH", "DELETE", "OPTIONS"]);
    assert.equal(registeredRoutes["polish-imports-commit"].route, "polish-imports/{id}/commit");
    assert.ok(registeredTimers["polish-import-session-cleanup"]);
  });

  for (const [name, method, params] of [
    ["polish-imports-create", "POST", {}],
    ["polish-imports-session", "GET", { id: SESSION_ID }],
    ["polish-imports-session", "PATCH", { id: SESSION_ID }],
    ["polish-imports-session", "DELETE", { id: SESSION_ID }],
    ["polish-imports-commit", "POST", { id: SESSION_ID }],
  ]) {
    it(`${method} ${name} → 401 without credentials`, async () => {
      const res = await registeredRoutes[name].handler(fakeRequest({ method, params, auth: false }), fakeContext());
      assert.equal(res.status, 401);
    });
  }
});

describe("POST /api/polish-imports", () => {
  const create = (body) => registeredRoutes["polish-imports-create"].handler(fakeRequest({ method: "POST", body }), fakeContext());

  it("validates the body and file size", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    assert.equal((await create({})).status, 400);
    assert.equal((await create("not json")).status, 400);
    assert.equal((await create({ csv: "brand,name\nA,B", mapping: [1] })).status, 400);
    assert.equal((await create({ csv: "x".repeat(shared.POLISH_IMPORT_MAX_BYTES + 1) })).status, 413);
    const noColumns = await create({ csv: "foo,bar\n1,2" });
    assert.equal(noColumns.status, 422);
  });

  it("matches the whole sheet in batched queries scoped to the caller and stores the session", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = [];
    queryMock = async (text, params) => {
      const auth = authQuery(text, params);
      if (auth) return auth;
      calls.push({ text: String(text), params });
      if (/FROM finish_normalization/.test(text)) return { rows: [] };
      if (/FROM brand b/.test(text) && /WITH ORDINALITY/.test(text)) {
        // Only "Essie" resolves to a brand.
        return { rows: params[0].includes("Essie") ? [{ ord: params[0].indexOf("Essie") + 1, brandId: "5", name: "Essie", similarity: 1 }] : [] };
      }
      if (/unnest\(\$2::int\[\], \$3::bigint\[\], \$4::text\[\]\)/.test(text)) {
        return {
          rows: params[1].map((idx) => ({
            idx,
            shadeId: "11",
            brandId: "5",
            brand: "Essie",
            name: "Wicked",
            finishes: ["creme"],
            vendorHex: "#880011",
            detectedHex: null,
            nameHex: null,
            userSubmitted: false,
            inCollection: true,
            nameSimilarity: 1,
          })),
        };
      }
      if (/unnest\(\$2::int\[\], \$3::text\[\]\)/.test(text)) return { rows: [] };
      if (/INSERT INTO polish_import_session/.test(text)) {
        return {
          rows: [
            {
              id: params[0],
              fileName: params[2],
              status: "review",
              payload: JSON.parse(params[4]),
              result: null,
              createdAt: new Date(),
              expiresAt: new Date(),
              committedAt: null,
            },
          ],
        };
      }
      return { rows: [] };
    };
    const rows = ["Brand,Shade"];
    for (let i = 0; i < 100; i += 1) rows.push(i % 2 ? "Essie,Wicked" : `Unknown Brand ${i},Thing ${i}`);
    const res = await create({ csv: rows.join("\n"), fileName: "sheet.csv" });
    assert.equal(res.status, 201, JSON.stringify(res.jsonBody));
    assert.equal(res.jsonBody.fileName, "sheet.csv");
    assert.deepEqual(res.jsonBody.counts, { total: 100, matched: 50, ambiguous: 0, unmatched: 50, invalid: 0 });
    const matched = res.jsonBody.rows[1];
    assert.equal(matched.shadeId, "11");
    assert.equal(matched.candidates[0].hex, "#880011");
    assert.equal(matched.candidates[0].inCollection, true);

    // finish catalog + brands + brand-bound shades + brand-less shades: never one query per row.
    const matching = calls.filter((c) => /similarity\(/.test(c.text));
    assert.equal(matching.length, 3);
    for (const call of matching.filter((c) => /FROM shade s/.test(c.text))) {
      assert.equal(call.params[0], 1, "shade matching is scoped to the caller");
      assert.match(call.text, /ui\.user_id = \$1/);
      assert.match(call.text, /s\.status <> 'user_submitted' OR s\.created_by_user_id = \$1/);
    }
    const cleanup = calls.find((c) => /DELETE FROM polish_import_session/.test(c.text));
    assert.ok(cleanup && /WHERE user_id = \$1/.test(cleanup.text) && cleanup.params[0] === 1);
    const insert = calls.find((c) => /INSERT INTO polish_import_session/.test(c.text));
    assert.equal(insert.params[1], 1, "the session belongs to the caller");
  });
});

describe("polish import sessions are scoped to their owner", () => {
  it("GET returns the owner's session and 404 for anyone else", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const store = sessionStore(1, storedSession({ rows: [baseRow(2)] }));
    queryMock = async (text, params) => authQuery(text, params) ?? store(text, params) ?? { rows: [] };
    const get = (user) =>
      registeredRoutes["polish-imports-session"].handler(fakeRequest({ params: { id: SESSION_ID }, user }), fakeContext());
    const own = await get(1);
    assert.equal(own.status, 200);
    assert.equal(own.jsonBody.id, SESSION_ID);
    assert.equal(own.jsonBody.counts.matched, 1);
    assert.equal((await get(2)).status, 404);
    const bad = await registeredRoutes["polish-imports-session"].handler(fakeRequest({ params: { id: "1 OR 1=1" } }), fakeContext());
    assert.equal(bad.status, 404);
  });

  it("DELETE only removes the caller's own session", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    const calls = [];
    queryMock = async (text, params) => {
      const auth = authQuery(text, params);
      if (auth) return auth;
      calls.push({ text, params });
      return { rows: params[1] === 1 ? [{ import_session_id: SESSION_ID }] : [] };
    };
    const del = (user) =>
      registeredRoutes["polish-imports-session"].handler(fakeRequest({ method: "DELETE", params: { id: SESSION_ID }, user }), fakeContext());
    assert.equal((await del(2)).status, 404);
    assert.equal((await del(1)).status, 200);
    for (const call of calls) assert.match(call.text, /user_id = \$2/);
  });

  it("another user cannot commit into the session: 404 and no inventory writes", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const store = sessionStore(1, storedSession({ rows: [baseRow(2)] }));
    const txCalls = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          txCalls.push({ text: String(text), params });
          return store(String(text), params) ?? { rows: [] };
        },
      });
    const res = await registeredRoutes["polish-imports-commit"].handler(
      fakeRequest({ method: "POST", params: { id: SESSION_ID }, user: 2 }),
      fakeContext()
    );
    assert.equal(res.status, 404);
    assert.ok(!txCalls.some((c) => /user_inventory_item\s*\(/.test(c.text) || /INSERT INTO/.test(c.text)));
    assert.ok(txCalls.some((c) => /FOR UPDATE/.test(c.text) && c.params[1] === 2));
  });

  it("another user cannot save decisions into the session", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const store = sessionStore(1, storedSession({ rows: [baseRow(2)] }));
    const writes = [];
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (/UPDATE polish_import_session/.test(text)) writes.push(params);
          return store(String(text), params) ?? { rows: [] };
        },
      });
    const res = await registeredRoutes["polish-imports-session"].handler(
      fakeRequest({ method: "PATCH", params: { id: SESSION_ID }, user: 2, body: { decisions: [{ rowNumber: 2, action: "skip" }] } }),
      fakeContext()
    );
    assert.equal(res.status, 404);
    assert.equal(writes.length, 0);
  });

  it("PATCH refuses a picked shade the caller cannot see (another user's private shade)", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const store = sessionStore(1, storedSession({ rows: [baseRow(2, { matchState: "ambiguous", action: "pending", shadeId: null })] }));
    let visibilityParams = null;
    transactionMock = async (cb) =>
      cb({
        query: async (text, params) => {
          if (/shade_id = ANY/.test(text)) {
            visibilityParams = params;
            assert.match(text, /s\.status <> 'user_submitted' OR s\.created_by_user_id = \$1/);
            return { rows: [] };
          }
          return store(String(text), params) ?? { rows: [] };
        },
      });
    const res = await registeredRoutes["polish-imports-session"].handler(
      fakeRequest({
        method: "PATCH",
        params: { id: SESSION_ID },
        body: { decisions: [{ rowNumber: 2, action: "match", shadeId: "999" }] },
      }),
      fakeContext()
    );
    assert.equal(res.status, 404);
    assert.deepEqual(visibilityParams, [1, ["999"]]);
  });

  it("PATCH validates decisions before touching the DB", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    let touched = false;
    transactionMock = async () => {
      touched = true;
      return { status: 200 };
    };
    const res = await registeredRoutes["polish-imports-session"].handler(
      fakeRequest({ method: "PATCH", params: { id: SESSION_ID }, body: { decisions: [{ rowNumber: 1, action: "nope" }] } }),
      fakeContext()
    );
    assert.equal(res.status, 400);
    assert.equal(touched, false);
  });
});

describe("POST /api/polish-imports/{id}/commit", () => {
  /** Transaction client for a commit: visible shades + existing inventory are configurable. */
  function commitClient({ session, existing = {}, failShade = null, createdShadeId = "500" }) {
    const store = sessionStore(1, session);
    const calls = [];
    let saved = null;
    const client = {
      query: async (text, params) => {
        text = String(text);
        calls.push({ text, params });
        const stored = store(text, params);
        if (stored) return stored;
        if (/shade_id = ANY/.test(text)) {
          return {
            rows: params[1].map((shadeId) => ({
              idx: 0,
              shadeId,
              brandId: "5",
              brand: "Essie",
              name: `Shade ${shadeId}`,
              finishes: [],
              vendorHex: null,
              detectedHex: null,
              nameHex: null,
              userSubmitted: false,
              inCollection: Boolean(existing[shadeId]),
              nameSimilarity: 0,
              triedAt: existing[shadeId]?.triedAt ?? null,
            })),
          };
        }
        if (/INSERT INTO brand/.test(text)) return { rows: [] };
        if (/SELECT brand_id FROM brand/.test(text)) return { rows: [{ brand_id: 5 }] };
        if (/FROM shade s\s+WHERE s\.brand_id = \$1/.test(text)) return { rows: [] };
        if (/INSERT INTO shade/.test(text)) return { rows: [{ shade_id: Number(createdShadeId) }] };
        if (/AS "shadeCreated"/.test(text)) return { rows: [{ shadeCreated: true, inCollection: false, triedAt: null }] };
        if (/INSERT INTO user_inventory_item/.test(text)) {
          if (failShade && String(params[1]) === failShade) throw new Error("boom");
          return { rows: [{ inventoryItemId: `inv-${params[1]}` }] };
        }
        if (/UPDATE polish_import_session/.test(text)) {
          saved = { payload: JSON.parse(params[2]), result: JSON.parse(params[3]) };
          return {
            rows: [{ ...session, status: "committed", payload: saved.payload, result: saved.result, committedAt: new Date() }],
          };
        }
        return { rows: [] };
      },
    };
    return { client, calls, getSaved: () => saved };
  }

  function commit(body) {
    return registeredRoutes["polish-imports-commit"].handler(
      fakeRequest({ method: "POST", params: { id: SESSION_ID }, body }),
      fakeContext()
    );
  }

  it("upserts through the #261 helper, counts created vs updated, and skips undecided/duplicate rows", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const rows = [
      baseRow(2), // shade 102, new → created
      baseRow(3), // shade 103, existing → updated
      baseRow(4, { shadeId: "102" }), // same shade as row 2 → skipped
      baseRow(5, { matchState: "ambiguous", action: "pending", shadeId: null }), // undecided → skipped
      baseRow(6, { matchState: "unmatched", action: "pending", shadeId: null, values: { brand: "Indie", name: "New One", finishes: ["jelly"] } }),
      baseRow(7, { matchState: "invalid", action: "skip", shadeId: null, errors: ["Brand is missing"] }),
    ];
    const { client, calls, getSaved } = commitClient({
      session: storedSession({ rows }),
      existing: { 103: { triedAt: null } },
    });
    transactionMock = async (cb) => cb(client);
    const res = await commit({ decisions: [{ rowNumber: 6, action: "create" }] });
    assert.equal(res.status, 200, JSON.stringify(res.jsonBody));
    assert.deepEqual(res.jsonBody.result, { created: 2, updated: 1, skipped: 3, failed: 0, shadesCreated: 1 });
    assert.equal(res.jsonBody.alreadyCommitted, false);

    const upserts = calls.filter((c) => /INSERT INTO user_inventory_item/.test(c.text));
    assert.deepEqual(upserts.map((c) => String(c.params[1])), ["102", "103", "500"]);
    for (const call of upserts) assert.equal(call.params[0], 1, "inventory rows belong to the caller");
    // New row without a status column → owned; existing row keeps its status ($10 null).
    assert.equal(upserts[0].params[9], "owned");
    assert.equal(upserts[1].params[9], null);
    // The created shade is the caller's private submission with the normalized finish.
    const shadeInsert = calls.find((c) => /INSERT INTO shade/.test(c.text));
    assert.match(shadeInsert.text, /'user_submitted'/);
    assert.equal(shadeInsert.params[4], 1);
    assert.deepEqual(shadeInsert.params[9], ["jelly"]);

    const saved = getSaved();
    const outcomes = Object.fromEntries(saved.payload.rows.map((r) => [r.rowNumber, [r.outcome, r.outcomeMessage]]));
    assert.deepEqual(outcomes[4], ["skipped", "Same polish as row 2"]);
    assert.deepEqual(outcomes[5], ["skipped", "Not reviewed"]);
    assert.deepEqual(outcomes[7], ["skipped", "Brand is missing"]);
    assert.equal(outcomes[6][0], "created");
    // Every row runs inside its own savepoint.
    assert.equal(calls.filter((c) => /^SAVEPOINT/.test(c.text)).length, 3);
  });

  it("re-importing the same sheet updates instead of duplicating", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const rows = [baseRow(2), baseRow(3)];
    const { client, calls } = commitClient({
      session: storedSession({ rows }),
      existing: { 102: { triedAt: null }, 103: { triedAt: "2026-01-01T00:00:00.000Z" } },
    });
    transactionMock = async (cb) => cb(client);
    const res = await commit(undefined);
    assert.deepEqual(res.jsonBody.result, { created: 0, updated: 2, skipped: 0, failed: 0, shadesCreated: 0 });
    // The upsert is keyed on (user_id, shade_id): ON CONFLICT updates the existing row.
    const upserts = calls.filter((c) => /INSERT INTO user_inventory_item/.test(c.text));
    assert.equal(upserts.length, 2);
    assert.match(upserts[0].text, /ON CONFLICT \(user_id, shade_id\) DO UPDATE/);
  });

  it("returns the stored result for an already committed session without writing again", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const result = { created: 3, updated: 1, skipped: 0, failed: 0, shadesCreated: 0 };
    const { client, calls } = commitClient({ session: storedSession({ status: "committed", result, rows: [baseRow(2)] }) });
    transactionMock = async (cb) => cb(client);
    const res = await commit(undefined);
    assert.equal(res.status, 200);
    assert.equal(res.jsonBody.alreadyCommitted, true);
    assert.deepEqual(res.jsonBody.result, result);
    assert.ok(!calls.some((c) => /INSERT INTO user_inventory_item|UPDATE polish_import_session/.test(c.text)));
  });

  it("reports a failing row and still commits the others", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const { client, calls, getSaved } = commitClient({ session: storedSession({ rows: [baseRow(2), baseRow(3)] }), failShade: "102" });
    transactionMock = async (cb) => cb(client);
    const res = await commit(undefined);
    assert.deepEqual(res.jsonBody.result, { created: 1, updated: 0, skipped: 0, failed: 1, shadesCreated: 0 });
    assert.ok(calls.some((c) => /ROLLBACK TO SAVEPOINT/.test(c.text)));
    assert.equal(getSaved().payload.rows[0].outcomeMessage, "Could not save this row");
  });

  it("fails rows whose matched shade is no longer visible to the caller", async () => {
    process.env.AUTH_DEV_BYPASS = "true";
    queryMock = async (text, params) => authQuery(text, params) ?? { rows: [] };
    const { client } = commitClient({ session: storedSession({ rows: [baseRow(2)] }) });
    const original = client.query;
    client.query = async (text, params) => (/shade_id = ANY/.test(text) ? { rows: [] } : original(text, params));
    transactionMock = async (cb) => cb(client);
    const res = await commit(undefined);
    assert.deepEqual(res.jsonBody.result, { created: 0, updated: 0, skipped: 0, failed: 1, shadesCreated: 0 });
  });
});
