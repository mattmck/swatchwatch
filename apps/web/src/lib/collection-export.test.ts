import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CollectionExportError,
  buildCollectionExportUrl,
  fetchCollectionExport,
  filenameFromContentDisposition,
  saveBlobAsFile,
  type CollectionExportDeps,
} from "./collection-export";

const API = "https://api.swatchwatch.app/api";

function deps(response: Response, seen: Array<{ url: string; init?: RequestInit }> = []): CollectionExportDeps {
  return {
    apiBaseUrl: API,
    getAuthHeaders: async () => ({ Authorization: "Bearer token-123" }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return response;
    }) as typeof fetch,
    now: () => new Date("2026-10-17T08:00:00Z"),
  };
}

describe("buildCollectionExportUrl", () => {
  it("adds the format and an optional status filter", () => {
    assert.equal(buildCollectionExportUrl(API, "csv"), `${API}/polishes/export?format=csv`);
    assert.equal(
      buildCollectionExportUrl(`${API}/`, "json", { status: ["owned", "wishlist"] }),
      `${API}/polishes/export?format=json&status=owned%2Cwishlist`
    );
    assert.equal(buildCollectionExportUrl(API, "csv", { status: [] }), `${API}/polishes/export?format=csv`);
  });
});

describe("filenameFromContentDisposition", () => {
  it("reads quoted, bare and RFC 5987 filenames", () => {
    assert.equal(
      filenameFromContentDisposition('attachment; filename="swatchwatch-collection-2026-10-17.csv"'),
      "swatchwatch-collection-2026-10-17.csv"
    );
    assert.equal(filenameFromContentDisposition("attachment; filename=export.json"), "export.json");
    assert.equal(
      filenameFromContentDisposition(`attachment; filename="fallback.csv"; filename*=UTF-8''cr%C3%A8me.csv`),
      "crème.csv"
    );
  });

  it("returns null when absent and strips path separators", () => {
    assert.equal(filenameFromContentDisposition(null), null);
    assert.equal(filenameFromContentDisposition("attachment"), null);
    assert.equal(filenameFromContentDisposition('attachment; filename="../../etc/passwd"'), ".._.._etc_passwd");
    assert.equal(filenameFromContentDisposition('attachment; filename=".."'), null);
  });
});

describe("fetchCollectionExport", () => {
  it("sends the auth header and uses the server filename", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const response = new Response("\uFEFFBrand,Shade name\r\n", {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="swatchwatch-collection-2026-10-16.csv"',
      },
    });
    const result = await fetchCollectionExport("csv", deps(response, seen));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${API}/polishes/export?format=csv`);
    assert.deepEqual(seen[0].init?.headers, { Authorization: "Bearer token-123" });
    assert.equal(result.filename, "swatchwatch-collection-2026-10-16.csv");
    // The UTF-8 BOM bytes reach the saved file untouched (Blob.text() would strip them).
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), "\uFEFFBrand,Shade name\r\n");
  });

  it("falls back to a dated filename when the header is not readable", async () => {
    const response = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    const result = await fetchCollectionExport("json", deps(response));
    assert.equal(result.filename, "swatchwatch-collection-2026-10-17.json");
  });

  it("throws the API error message on failure", async () => {
    const response = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    await assert.rejects(fetchCollectionExport("csv", deps(response)), (error: unknown) => {
      assert.ok(error instanceof CollectionExportError);
      assert.equal(error.status, 401);
      assert.equal(error.message, "Unauthorized");
      return true;
    });
  });

  it("throws a generic message when the error body is not JSON", async () => {
    const response = new Response("boom", { status: 500 });
    await assert.rejects(fetchCollectionExport("csv", deps(response)), /Export failed \(HTTP 500\)/);
  });
});

describe("saveBlobAsFile", () => {
  it("clicks a temporary download link and revokes the object URL", () => {
    const events: string[] = [];
    const anchor = {
      href: "",
      download: "",
      rel: "",
      style: { display: "" },
      click: () => events.push(`click:${anchor.download}:${anchor.href}`),
      remove: () => events.push("remove"),
    };
    const env = {
      document: {
        createElement: () => anchor,
        body: { appendChild: () => events.push("append") },
      } as unknown as Pick<Document, "createElement" | "body">,
      createObjectURL: () => "blob:fake-1",
      revokeObjectURL: (url: string) => events.push(`revoke:${url}`),
      defer: (fn: () => void) => fn(),
    };
    saveBlobAsFile(new Blob(["x"]), "swatchwatch-collection-2026-10-17.csv", env);
    assert.deepEqual(events, [
      "append",
      "click:swatchwatch-collection-2026-10-17.csv:blob:fake-1",
      "remove",
      "revoke:blob:fake-1",
    ]);
  });
});
