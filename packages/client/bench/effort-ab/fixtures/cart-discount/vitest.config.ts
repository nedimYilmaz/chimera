import { defineConfig } from "vitest/config";

// Standalone config so this fixture never inherits the repo-root workspace's
// `projects: ["packages/*"]` — the effort-AB harness invokes vitest with
// `--config` pointed exactly here, scoped to this one fixture directory.
export default defineConfig({ test: { include: ["*.check.ts"] } });
