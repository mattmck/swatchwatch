// Writes out/sw.js after `next build`: the worker template + sw-core.mjs inlined + the precache
// list of the static export. Run from the `build` script. Never part of `next dev`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrecache } from "./sw-precache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : join(here, "..", "out");

if (!existsSync(join(outDir, "index.html"))) {
  console.error(`build-sw: ${outDir} has no index.html; run next build first`);
  process.exit(1);
}

const { urls, version, skipped } = buildPrecache(outDir);
for (const required of ["/blank.html", "/polishes/", "/polishes/detail/", "/rapid-add/", "/dashboard/"]) {
  if (!urls.includes(required)) {
    console.error(`build-sw: ${required} is missing from the precache list`);
    process.exit(1);
  }
}

const core = readFileSync(join(here, "sw-core.mjs"), "utf8").replace(/^export /gm, "");
const source = readFileSync(join(here, "sw-template.js"), "utf8")
  .replace("__SW_CORE__", () => core)
  .replace("__SW_VERSION__", version)
  .replace("__SW_PRECACHE__", () => JSON.stringify(urls, null, 2));

writeFileSync(join(outDir, "sw.js"), source);
const tooLarge = skipped.length ? `, ${skipped.length} too large: ${skipped.join(", ")}` : "";
console.log(`build-sw: wrote sw.js (version ${version}, ${urls.length} precached URLs${tooLarge})`);
