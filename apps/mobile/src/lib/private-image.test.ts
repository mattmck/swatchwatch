import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bytesToBase64,
  classifyPrivateImageStatus,
  imageDataUri,
  MemoryImageCache,
  resolvePrivateImageUrl,
  urlOrigin,
} from "./private-image";

const API = "http://localhost:7071/api";

describe("resolvePrivateImageUrl", () => {
  it("resolves relative v3 ids against the API origin", () => {
    assert.equal(resolvePrivateImageUrl("/api/images/v3.abc.1.2.sig", API), "http://localhost:7071/api/images/v3.abc.1.2.sig");
  });

  it("accepts absolute v3 URLs only on the API origin", () => {
    assert.equal(resolvePrivateImageUrl("http://LOCALHOST:7071/api/images/v3.x", API), "http://LOCALHOST:7071/api/images/v3.x");
    assert.equal(resolvePrivateImageUrl("https://evil.example/api/images/v3.x", API), null);
    assert.equal(resolvePrivateImageUrl("http://localhost:7072/api/images/v3.x", API), null);
    assert.equal(resolvePrivateImageUrl("//evil.example/api/images/v3.x", API), null);
  });

  it("refuses public ids, data URIs and empty input", () => {
    assert.equal(resolvePrivateImageUrl("/api/images/v2.abc", API), null);
    assert.equal(resolvePrivateImageUrl("data:image/jpeg;base64,AAAA", API), null);
    assert.equal(resolvePrivateImageUrl("", API), null);
    assert.equal(resolvePrivateImageUrl(null, API), null);
    assert.equal(resolvePrivateImageUrl("/api/images/v3.x", "not a url"), null);
  });

  it("parses origins", () => {
    assert.equal(urlOrigin("https://Api.Example.com:8443/x?y"), "https://api.example.com:8443");
    assert.equal(urlOrigin("/relative"), null);
  });
});

describe("classifyPrivateImageStatus", () => {
  it("maps statuses", () => {
    assert.equal(classifyPrivateImageStatus(200), "ready");
    assert.equal(classifyPrivateImageStatus(401), "denied");
    assert.equal(classifyPrivateImageStatus(403), "denied");
    assert.equal(classifyPrivateImageStatus(404), "error");
    assert.equal(classifyPrivateImageStatus(500), "error");
  });
});

describe("bytesToBase64 / imageDataUri", () => {
  it("matches Node's base64 for every padding case", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      const bytes = new TextEncoder().encode(text);
      assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
    }
    const random = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37 + 11) % 256);
    assert.equal(bytesToBase64(random), Buffer.from(random).toString("base64"));
  });

  it("only labels image content types", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    assert.equal(imageDataUri("image/jpeg; charset=binary", bytes), "data:image/jpeg;base64,AQID");
    assert.equal(imageDataUri("text/html", bytes), "data:image/jpeg;base64,AQID");
    assert.equal(imageDataUri(null, bytes), "data:image/jpeg;base64,AQID");
  });
});

describe("MemoryImageCache", () => {
  it("evicts the least recently used entry and clears", () => {
    const cache = new MemoryImageCache(2);
    cache.set("a", "1");
    cache.set("b", "2");
    assert.equal(cache.get("a"), "1");
    cache.set("c", "3");
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), "1");
    assert.equal(cache.size, 2);
    cache.clear();
    assert.equal(cache.size, 0);
  });
});
