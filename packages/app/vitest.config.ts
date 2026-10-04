import { defineConfig } from "vitest/config";

// W3: pure-function tests only (selectors, keymap table/dispatch) — node env,
// no DOM. The oxc jsx block: vitest 4 sets
// `oxc` in test mode, so JSX must be configured oxc-natively (keymap.ts is
// plain TS today, but the config is future-proof for .tsx test subjects).
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {},
});
