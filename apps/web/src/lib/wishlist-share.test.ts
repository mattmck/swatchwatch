import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wishlistSharePath } from "swatchwatch-shared";
import {
  buildWishlistShareUrl,
  publicWishlistErrorMessage,
  publicWishlistTitle,
  readShareToken,
  wishlistSharePrivacyNote,
} from "./wishlist-share";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

describe("readShareToken", () => {
  it("accepts a well-formed token", () => {
    assert.equal(readShareToken(new URLSearchParams({ token: TOKEN })), TOKEN);
  });

  it("rejects missing or malformed tokens", () => {
    assert.equal(readShareToken(new URLSearchParams()), null);
    assert.equal(readShareToken(null), null);
    assert.equal(readShareToken(new URLSearchParams({ token: "short" })), null);
    assert.equal(readShareToken(new URLSearchParams({ token: `${TOKEN}x` })), null);
    assert.equal(readShareToken(new URLSearchParams({ token: TOKEN.replace("A", "/") })), null);
  });
});

describe("share URL", () => {
  it("builds an absolute static-export URL with the token in the query", () => {
    const path = wishlistSharePath(TOKEN);
    assert.equal(path, `/w/?token=${TOKEN}`);
    assert.equal(buildWishlistShareUrl("https://swatchwatch.app", path), `https://swatchwatch.app/w/?token=${TOKEN}`);
  });
});

describe("public page copy", () => {
  it("uses the display name or a generic title", () => {
    assert.equal(publicWishlistTitle("Sam"), "Sam's wishlist");
    assert.equal(publicWishlistTitle(null), "A SwatchWatch wishlist");
    assert.equal(publicWishlistTitle("  "), "A SwatchWatch wishlist");
  });

  it("explains 404 and 429 without revealing why a link is gone", () => {
    assert.match(publicWishlistErrorMessage(404), /doesn't exist/);
    assert.match(publicWishlistErrorMessage(429), /Too many requests/);
    assert.match(publicWishlistErrorMessage(500), /couldn't load/);
  });

  it("privacy note states what is and is not shared", () => {
    const note = wishlistSharePrivacyNote(1, 0);
    assert.match(note, /1 polish on your wishlist/);
    assert.match(note, /can't see your email, notes, prices, quantities/);
    assert.doesNotMatch(note, /hidden/);
    assert.match(wishlistSharePrivacyNote(3, 2), /2 polishes you added that aren't in the shared catalog yet stay hidden/);
  });
});
