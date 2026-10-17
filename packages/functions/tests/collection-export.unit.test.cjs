/**
 * Collection export (issue #264): RFC 4180 CSV encoding, formula-injection guard, column
 * order/headers (the round-trip contract with the CSV import, #263), keyset paging and the
 * JSON envelope. Pure functions only; handler/access-control behaviour is covered in
 * access-control.unit.test.cjs.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  CSV_UTF8_BOM,
  encodeCsvCell,
  encodeCsvRecord,
  neutralizeCsvFormula,
} = require("../dist/lib/csv");
const {
  COLLECTION_EXPORT_SQL,
  CollectionExportRequestError,
  buildCollectionExport,
  collectionCsvCells,
  collectionCsvHeader,
  iterateCollectionExportPages,
  parseExportFormat,
  toCollectionExportItem,
} = require("../dist/lib/collection-export");
const {
  COLLECTION_EXPORT_VERSION,
  POLISH_CSV_COLUMNS,
  POLISH_CSV_HEADERS,
  collectionExportFilename,
} = require("swatchwatch-shared");

function dbRow(overrides = {}) {
  return {
    inventoryItemId: "11",
    shadeId: "500",
    brand: "Holo Taco",
    name: "One Coat Black",
    color: "black",
    legacyFinish: "creme",
    finishes: ["creme"],
    collection: null,
    quantity: 2,
    status: "owned",
    isUntried: false,
    triedAt: "2026-03-04T05:06:07.000Z",
    lastWornAt: null,
    wearCount: 3,
    purchasePrice: 12.5,
    purchaseCurrency: "USD",
    purchaseDate: "2026-01-02",
    expirationDate: null,
    size: "15 ml",
    rating: 4,
    notes: "fave",
    tags: ["winter", "work"],
    vendorHex: null,
    detectedHex: "#111111",
    nameHex: "#000000",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-02-03T04:05:06.000Z",
    ...overrides,
  };
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF/LF inside quotes). */
function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += 1;
    } else field += ch;
  }
  assert.equal(quoted, false, "unterminated quoted field");
  assert.equal(field, "", "file must end with CRLF");
  assert.equal(record.length, 0, "file must end with CRLF");
  return records;
}

describe("CSV cell encoding (RFC 4180)", () => {
  it("leaves plain values unquoted", () => {
    assert.equal(encodeCsvCell("Holo Taco"), "Holo Taco");
    assert.equal(encodeCsvCell(12), "12");
    assert.equal(encodeCsvCell(null), "");
    assert.equal(encodeCsvCell(undefined), "");
    assert.equal(encodeCsvCell(""), "");
  });

  it("quotes commas, quotes, CR and LF and doubles embedded quotes", () => {
    assert.equal(encodeCsvCell("a,b"), '"a,b"');
    assert.equal(encodeCsvCell('say "hi"'), '"say ""hi"""');
    assert.equal(encodeCsvCell("line1\nline2"), '"line1\nline2"');
    assert.equal(encodeCsvCell("line1\r\nline2"), '"line1\r\nline2"');
    assert.equal(encodeCsvCell('"'), '""""');
  });

  it("quotes leading/trailing whitespace so it survives a round trip", () => {
    assert.equal(encodeCsvCell(" padded "), '" padded "');
  });

  it("keeps non-ASCII text as-is", () => {
    assert.equal(encodeCsvCell("Crème brûlée 💅"), "Crème brûlée 💅");
  });

  it("encodes a record with CRLF termination", () => {
    assert.equal(encodeCsvRecord(["a", "b,c", null, 3]), 'a,"b,c",,3\r\n');
  });
});

describe("CSV formula-injection guard", () => {
  for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
    it(`prefixes a cell starting with ${JSON.stringify(trigger)}`, () => {
      assert.equal(neutralizeCsvFormula(`${trigger}SUM(A1)`), `'${trigger}SUM(A1)`);
    });
  }

  it("leaves safe cells alone (including formula chars later in the text)", () => {
    for (const value of ["#FF00AA", "12.50", "a=b", "x+y", "2026-01-02", "'quoted"]) {
      assert.equal(neutralizeCsvFormula(value), value);
    }
  });

  it("guards before quoting", () => {
    assert.equal(encodeCsvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
    assert.equal(encodeCsvCell("=1+1"), "'=1+1");
    assert.equal(encodeCsvCell("@cmd"), "'@cmd");
    assert.equal(encodeCsvCell("\tTAB"), "'\tTAB");
    assert.equal(encodeCsvCell("\rCR"), `"'\rCR"`);
  });
});

describe("CSV columns (round-trip contract with the import, #263)", () => {
  it("has the documented order and headers", () => {
    assert.deepEqual(POLISH_CSV_HEADERS, [
      "Brand",
      "Shade name",
      "Finishes",
      "Quantity",
      "Status",
      "Date tried",
      "Purchase price",
      "Currency",
      "Purchase date",
      "Notes",
      "Display hex",
      "Collection",
      "Rating",
      "Tags",
      "Size",
      "Expiration date",
      "Last worn",
      "Wear count",
      "Shade ID",
      "Item ID",
      "Created at",
      "Updated at",
    ]);
  });

  it("puts every round-trip column before the export-only extras", () => {
    const firstExtra = POLISH_CSV_COLUMNS.findIndex((column) => column.importField === null);
    assert.ok(firstExtra > 0);
    assert.ok(POLISH_CSV_COLUMNS.slice(firstExtra).every((column) => column.importField === null));
    assert.deepEqual(
      POLISH_CSV_COLUMNS.slice(0, firstExtra).map((column) => column.importField),
      ["brand", "name", "finish", "quantity", "status", "tried", "price", "currency", "purchaseDate", "notes"]
    );
  });

  it("has unique keys and headers", () => {
    assert.equal(new Set(POLISH_CSV_COLUMNS.map((c) => c.key)).size, POLISH_CSV_COLUMNS.length);
    assert.equal(new Set(POLISH_CSV_HEADERS.map((h) => h.toLowerCase())).size, POLISH_CSV_HEADERS.length);
  });

  it("starts with the UTF-8 BOM and a CRLF-terminated header record", () => {
    const header = collectionCsvHeader();
    assert.ok(header.startsWith(CSV_UTF8_BOM));
    assert.equal(header, `${CSV_UTF8_BOM}${POLISH_CSV_HEADERS.join(",")}\r\n`);
  });

  it("formats an item's cells in column order", () => {
    const cells = collectionCsvCells(toCollectionExportItem(dbRow()));
    assert.equal(cells.length, POLISH_CSV_COLUMNS.length);
    const byHeader = Object.fromEntries(POLISH_CSV_HEADERS.map((h, i) => [h, cells[i]]));
    assert.deepEqual(byHeader, {
      Brand: "Holo Taco",
      "Shade name": "One Coat Black",
      Finishes: "creme",
      Quantity: "2",
      Status: "owned",
      "Date tried": "2026-03-04",
      "Purchase price": "12.50",
      Currency: "USD",
      "Purchase date": "2026-01-02",
      Notes: "fave",
      "Display hex": "#111111",
      Collection: "",
      Rating: "4",
      Tags: "winter, work",
      Size: "15 ml",
      "Expiration date": "",
      "Last worn": "",
      "Wear count": "3",
      "Shade ID": "500",
      "Item ID": "11",
      "Created at": "2026-01-02T03:04:05.000Z",
      "Updated at": "2026-02-03T04:05:06.000Z",
    });
  });

  it("joins multiple finishes and falls back to the legacy finish", () => {
    const multi = collectionCsvCells(toCollectionExportItem(dbRow({ finishes: ["shimmer", "holographic"] })));
    assert.equal(multi[2], "shimmer, holographic");
    const legacy = collectionCsvCells(toCollectionExportItem(dbRow({ finishes: [], legacyFinish: "jelly" })));
    assert.equal(legacy[2], "jelly");
  });

  it("leaves empty cells for missing optional values", () => {
    const cells = collectionCsvCells(
      toCollectionExportItem(
        dbRow({
          triedAt: null,
          purchasePrice: null,
          purchaseCurrency: null,
          purchaseDate: null,
          notes: null,
          quantity: null,
          rating: null,
          tags: null,
          detectedHex: null,
          nameHex: null,
        })
      )
    );
    assert.deepEqual(
      [cells[3], cells[5], cells[6], cells[7], cells[8], cells[9], cells[10], cells[12], cells[13]],
      ["", "", "", "", "", "", "", "", ""]
    );
  });

  it("prefers vendor > detected > name hex for Display hex", () => {
    const item = toCollectionExportItem(dbRow({ vendorHex: "#ABCDEF" }));
    assert.equal(item.displayHex, "#ABCDEF");
    assert.equal(toCollectionExportItem(dbRow({ detectedHex: null })).displayHex, "#000000");
    assert.equal(toCollectionExportItem(dbRow({ detectedHex: null, nameHex: null })).displayHex, null);
  });
});

describe("export request parsing", () => {
  it("defaults to csv and is case-insensitive", () => {
    assert.equal(parseExportFormat(null), "csv");
    assert.equal(parseExportFormat(""), "csv");
    assert.equal(parseExportFormat("JSON"), "json");
    assert.equal(parseExportFormat(" csv "), "csv");
  });

  it("rejects unknown formats", () => {
    assert.throws(() => parseExportFormat("xlsx"), CollectionExportRequestError);
  });

  it("builds a dated attachment filename", () => {
    const at = new Date("2026-10-17T23:59:00Z");
    assert.equal(collectionExportFilename("csv", at), "swatchwatch-collection-2026-10-17.csv");
    assert.equal(collectionExportFilename("json", at), "swatchwatch-collection-2026-10-17.json");
  });
});

describe("export SQL and paging", () => {
  it("is scoped to the caller by user_id = $1 and covers every status by default", () => {
    assert.match(COLLECTION_EXPORT_SQL, /WHERE ui\.user_id = \$1/);
    assert.match(COLLECTION_EXPORT_SQL, /\$2::text\[\] IS NULL OR ui\.status = ANY\(\$2::text\[\]\)/);
    assert.match(COLLECTION_EXPORT_SQL, /LIMIT \$6/);
  });

  it("walks keyset pages until a short page, passing the last row as the cursor", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      dbRow({ inventoryItemId: String(i + 1), brand: `B${i}`, name: `N${i}` })
    );
    const calls = [];
    const queryFn = async (sql, params) => {
      calls.push(params);
      const [, , , , afterId, limit] = params;
      const start = afterId === null ? 0 : rows.findIndex((r) => r.inventoryItemId === afterId) + 1;
      return { rows: rows.slice(start, start + limit) };
    };
    const pages = [];
    for await (const page of iterateCollectionExportPages(queryFn, 7, [], 2)) pages.push(page);
    assert.deepEqual(
      pages.map((page) => page.map((item) => item.inventoryItemId)),
      [["1", "2"], ["3", "4"], ["5"]]
    );
    assert.deepEqual(calls[0], [7, null, null, null, null, 2]);
    assert.deepEqual(calls[1], [7, null, "B1", "N1", "2", 2]);
    assert.deepEqual(calls[2], [7, null, "B3", "N3", "4", 2]);
    assert.ok(calls.every((params) => params[0] === 7), "every page is bound to the caller");
  });

  it("stops after an exactly-full last page with one empty query", async () => {
    const rows = [dbRow({ inventoryItemId: "1" }), dbRow({ inventoryItemId: "2" })];
    let callCount = 0;
    const queryFn = async (_sql, params) => {
      callCount += 1;
      return { rows: params[4] === null ? rows : [] };
    };
    const pages = [];
    for await (const page of iterateCollectionExportPages(queryFn, 1, [], 2)) pages.push(page);
    assert.equal(pages.length, 1);
    assert.equal(callCount, 2);
  });

  it("passes a status filter as a text[] parameter", async () => {
    const seen = [];
    const queryFn = async (_sql, params) => {
      seen.push(params[1]);
      return { rows: [] };
    };
    for await (const _page of iterateCollectionExportPages(queryFn, 1, ["wishlist", "destash"])) {
      // no rows
    }
    assert.deepEqual(seen, [["wishlist", "destash"]]);
  });
});

describe("buildCollectionExport", () => {
  const now = new Date("2026-10-17T12:00:00.000Z");
  const tricky = dbRow({
    inventoryItemId: "2",
    brand: "Brand, Inc.",
    name: '=cmd|" /C calc"!A0',
    notes: 'line one\nline "two", three',
    tags: ["-dash", "@at"],
  });
  const queryFn = async (_sql, params) => ({ rows: params[4] === null ? [dbRow(), tricky] : [] });

  it("produces a parseable CSV that round-trips cell values (with guarded formulas)", async () => {
    const built = await buildCollectionExport({ queryFn, userId: 1, format: "csv", statusFilter: [], now });
    assert.equal(built.contentType, "text/csv; charset=utf-8");
    assert.equal(built.filename, "swatchwatch-collection-2026-10-17.csv");
    assert.equal(built.itemCount, 2);
    assert.ok(built.body.startsWith(CSV_UTF8_BOM));
    const records = parseCsv(built.body.slice(CSV_UTF8_BOM.length));
    assert.equal(records.length, 3);
    assert.deepEqual(records[0], [...POLISH_CSV_HEADERS]);
    assert.ok(records.every((record) => record.length === POLISH_CSV_HEADERS.length));
    const row = Object.fromEntries(POLISH_CSV_HEADERS.map((h, i) => [h, records[2][i]]));
    assert.equal(row.Brand, "Brand, Inc.");
    assert.equal(row["Shade name"], `'=cmd|" /C calc"!A0`);
    assert.equal(row.Notes, 'line one\nline "two", three');
    assert.equal(row.Tags, "'-dash, @at", "multi-value cells are guarded as a whole");
  });

  it("produces the versioned JSON envelope", async () => {
    const built = await buildCollectionExport({
      queryFn,
      userId: 1,
      format: "json",
      statusFilter: ["owned"],
      now,
    });
    assert.equal(built.contentType, "application/json; charset=utf-8");
    assert.equal(built.filename, "swatchwatch-collection-2026-10-17.json");
    const body = JSON.parse(built.body);
    assert.equal(body.version, COLLECTION_EXPORT_VERSION);
    assert.equal(body.version, 1);
    assert.equal(body.exportedAt, "2026-10-17T12:00:00.000Z");
    assert.deepEqual(body.statusFilter, ["owned"]);
    assert.equal(body.itemCount, 2);
    assert.equal(body.items.length, 2);
    // JSON keeps raw values (no formula guard, full timestamps).
    assert.equal(body.items[1].name, '=cmd|" /C calc"!A0');
    assert.equal(body.items[0].triedAt, "2026-03-04T05:06:07.000Z");
    assert.deepEqual(body.items[0].finishes, ["creme"]);
    assert.equal(body.items[0].displayHex, "#111111");
    assert.equal(body.items[0].swatchImageUrl, undefined, "image URLs are not exported");
  });

  it("exports an empty collection as a header-only CSV and an empty JSON list", async () => {
    const empty = async () => ({ rows: [] });
    const csv = await buildCollectionExport({ queryFn: empty, userId: 1, format: "csv", statusFilter: [], now });
    assert.equal(csv.body, collectionCsvHeader());
    assert.equal(csv.itemCount, 0);
    const json = JSON.parse(
      (await buildCollectionExport({ queryFn: empty, userId: 1, format: "json", statusFilter: [], now })).body
    );
    assert.deepEqual(json.items, []);
    assert.equal(json.statusFilter, null);
  });
});
