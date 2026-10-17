import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectInstallSurface,
  INSTALL_PROMPT_SNOOZE_MS,
  isInAppBrowser,
  isInstallPromptSnoozed,
  isIosDevice,
  type InstallEnvironment,
} from "./install-prompt";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPHONE_INSTAGRAM = `${IPHONE_SAFARI} Instagram 300.0.0`;

function env(overrides: Partial<InstallEnvironment>): InstallEnvironment {
  return {
    userAgent: ANDROID_CHROME,
    maxTouchPoints: 5,
    isStandalone: false,
    hasDeferredPrompt: false,
    isTouchDevice: true,
    ...overrides,
  };
}

describe("detectInstallSurface", () => {
  it("hides everything once installed", () => {
    assert.equal(detectInstallSurface(env({ isStandalone: true, hasDeferredPrompt: true })), "installed");
  });

  it("uses the deferred beforeinstallprompt on mobile Chromium", () => {
    assert.equal(detectInstallSurface(env({ hasDeferredPrompt: true })), "native-prompt");
    assert.equal(detectInstallSurface(env({})), "none");
  });

  it("shows the Share → Add to Home Screen hint on iPhone and iPad", () => {
    assert.equal(detectInstallSurface(env({ userAgent: IPHONE_SAFARI })), "ios-hint");
    assert.equal(detectInstallSurface(env({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 })), "ios-hint");
  });

  it("stays quiet on desktop, Macs, and in-app browsers", () => {
    assert.equal(detectInstallSurface(env({ isTouchDevice: false, hasDeferredPrompt: true })), "none");
    assert.equal(detectInstallSurface(env({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 })), "none");
    assert.equal(detectInstallSurface(env({ userAgent: IPHONE_INSTAGRAM })), "none");
  });
});

describe("platform helpers", () => {
  it("detects iOS including iPadOS desktop mode", () => {
    assert.equal(isIosDevice(IPHONE_SAFARI, 5), true);
    assert.equal(isIosDevice(IPAD_DESKTOP_UA, 5), true);
    assert.equal(isIosDevice(IPAD_DESKTOP_UA, 0), false);
    assert.equal(isIosDevice(ANDROID_CHROME, 5), false);
  });

  it("detects in-app browsers", () => {
    assert.equal(isInAppBrowser(IPHONE_INSTAGRAM), true);
    assert.equal(isInAppBrowser(IPHONE_SAFARI), false);
  });
});

describe("isInstallPromptSnoozed", () => {
  const now = 1_800_000_000_000;

  it("snoozes for the window after a dismissal", () => {
    assert.equal(isInstallPromptSnoozed(String(now - 1000), now), true);
    assert.equal(isInstallPromptSnoozed(String(now - INSTALL_PROMPT_SNOOZE_MS - 1), now), false);
  });

  it("ignores missing, malformed and future timestamps", () => {
    assert.equal(isInstallPromptSnoozed(null, now), false);
    assert.equal(isInstallPromptSnoozed("not-a-number", now), false);
    assert.equal(isInstallPromptSnoozed(String(now + 60_000), now), false);
  });
});
