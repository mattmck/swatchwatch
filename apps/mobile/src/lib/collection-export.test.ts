import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectionExportPath, exportFilename, exportShareType, filenameFromContentDisposition } from "./collection-export";

describe("collectionExportPath", () => {
  it("builds the export route with an optional status list", () => {
    assert.equal(collectionExportPath("csv"), "/polishes/export?format=csv");
    assert.equal(collectionExportPath("json", ["owned", "wishlist"]), "/polishes/export?format=json&status=owned%2Cwishlist");
  });
});

describe("filenameFromContentDisposition", () => {
  it("prefers the RFC 5987 name, then the quoted and bare forms", () => {
    assert.equal(
      filenameFromContentDisposition(`attachment; filename="a.csv"; filename*=UTF-8''swatch%20watch.csv`),
      "swatch watch.csv",
    );
    assert.equal(filenameFromContentDisposition(`attachment; filename="my \\"list\\".csv"`), 'my "list".csv');
    assert.equal(filenameFromContentDisposition("attachment; filename=list.json"), "list.json");
  });

  it("strips path separators and rejects unusable names", () => {
    assert.equal(filenameFromContentDisposition(`attachment; filename="../../etc/passwd"`), ".._.._etc_passwd");
    assert.equal(filenameFromContentDisposition(`attachment; filename=".."`), null);
    assert.equal(filenameFromContentDisposition("attachment"), null);
    assert.equal(filenameFromContentDisposition(null), null);
  });
});

describe("exportFilename", () => {
  const now = new Date("2026-10-23T15:00:00.000Z");

  it("uses the server name when it has the right extension", () => {
    assert.equal(exportFilename("csv", `attachment; filename="swatchwatch-collection-2026-10-22.csv"`, now), "swatchwatch-collection-2026-10-22.csv");
  });

  it("falls back to the dated default name", () => {
    assert.equal(exportFilename("json", null, now), "swatchwatch-collection-2026-10-23.json");
    assert.equal(exportFilename("json", `attachment; filename="weird.txt"`, now), "swatchwatch-collection-2026-10-23.json");
  });
});

describe("exportShareType", () => {
  it("maps formats to a MIME type and UTI", () => {
    assert.deepEqual(exportShareType("csv"), { mimeType: "text/csv", UTI: "public.comma-separated-values-text" });
    assert.deepEqual(exportShareType("json"), { mimeType: "application/json", UTI: "public.json" });
  });
});
