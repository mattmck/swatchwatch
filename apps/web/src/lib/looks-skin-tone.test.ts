import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStoredSkinTone, skinToneStorageKey } from "./looks-skin-tone";

describe("looks skin-tone storage", () => {
  it("keys per user", () => {
    assert.equal(skinToneStorageKey("7"), "swatchwatch-looks-skin-tone:7");
    assert.equal(skinToneStorageKey(null), "swatchwatch-looks-skin-tone");
  });

  it("parses a stored choice and treats junk as none", () => {
    assert.deepEqual(parseStoredSkinTone('{"undertone":"warm","depth":"tan"}'), { undertone: "warm", depth: "tan" });
    assert.deepEqual(parseStoredSkinTone('{"undertone":"cool"}'), { undertone: "cool", depth: "medium" });
    assert.equal(parseStoredSkinTone(null), null);
    assert.equal(parseStoredSkinTone("not json"), null);
    assert.equal(parseStoredSkinTone('{"undertone":"x","depth":"y"}'), null);
    assert.equal(parseStoredSkinTone("5"), null);
  });
});
