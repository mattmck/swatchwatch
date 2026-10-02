import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Relax rules for shadcn/ui generated components
  {
    files: ["src/components/ui/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // eslint-plugin-react-hooks 7.1 enabled stricter, opt-in React Compiler rules
  // (set-state-in-effect, use-memo) that flag pre-existing patterns. Downgrade
  // to warnings so this dependency refresh stays non-breaking; adopting the
  // rules (and fixing the ~11 surfaced sites) is tracked as a separate follow-up.
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/use-memo": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
