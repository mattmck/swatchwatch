// Copies MSAL's redirect bridge bundle into public/ so public/blank.html (the silent-renew
// redirect page, see SILENT_REDIRECT_PATH in src/lib/msal-config.ts) always runs the bridge from
// the installed @azure/msal-browser version. Runs before `dev` and `build`; the copy is gitignored.
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const msalRoot = dirname(require.resolve("@azure/msal-browser/package.json"));
const source = join(msalRoot, "lib", "redirect-bridge", "msal-redirect-bridge.min.js");
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "msal-redirect-bridge.min.js");

copyFileSync(source, target);
console.log(`Copied MSAL redirect bridge to ${target}`);
