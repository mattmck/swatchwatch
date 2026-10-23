const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The Function App has no App Service platform CORS, so lib/http.ts `withCors` is the only CORS
// layer in Azure. The Functions host answers OPTIONS on a route whose `methods` omit it with a
// 404 (no CORS headers), which fails the browser's preflight for every request that sends
// Authorization or JSON. So every HTTP route must accept OPTIONS and run through withCors.

const FUNCTIONS_DIR = path.resolve(__dirname, "../src/functions");

// Handlers that call withCors inside their own body instead of being wrapped at registration.
const WRAPS_CORS_INTERNALLY = { "images.ts": ["imagesHandler"] };

function readRegistrations() {
  const registrations = [];
  for (const file of fs.readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const source = fs.readFileSync(path.join(FUNCTIONS_DIR, file), "utf8");
    const calls = source.match(/\bapp\.http\(/g)?.length ?? 0;
    const blocks = [...source.matchAll(/\bapp\.http\(\s*"([^"]+)",\s*\{([\s\S]*?)\n\}\);/g)];
    assert.equal(blocks.length, calls, `${file}: could not parse every app.http registration`);
    for (const [, name, body] of blocks) {
      registrations.push({
        file,
        source,
        name,
        methods: body.match(/methods:\s*\[([^\]]*)\]/)?.[1] ?? "",
        handler: body.match(/handler:\s*([^\n]*)/)?.[1]?.trim() ?? "",
      });
    }
  }
  return registrations;
}

describe("HTTP route registrations — app-owned CORS", () => {
  const registrations = readRegistrations();

  it("finds the HTTP routes", () => {
    assert.ok(registrations.length > 50, `only ${registrations.length} routes parsed`);
  });

  it("every route accepts OPTIONS so the host lets withCors answer the preflight", () => {
    const missing = registrations.filter((r) => !/"OPTIONS"/.test(r.methods));
    assert.deepEqual(
      missing.map((r) => `${r.file} ${r.name} [${r.methods}]`),
      [],
      "add \"OPTIONS\" to these routes' methods"
    );
  });

  it("every route handler runs through withCors", () => {
    const unwrapped = registrations.filter((r) => {
      if (r.handler.startsWith("withCors(")) return false;
      const internal = WRAPS_CORS_INTERNALLY[r.file] ?? [];
      const name = r.handler.replace(/,$/, "");
      return !(internal.includes(name) && r.source.includes("withCors("));
    });
    assert.deepEqual(
      unwrapped.map((r) => `${r.file} ${r.name}: ${r.handler}`),
      [],
      "wrap these handlers in withCors"
    );
  });
});
