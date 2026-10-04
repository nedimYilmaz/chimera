import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChimeraClient } from "@chimera/client";
import { makeEngineHome } from "../../core/test/helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

// The terminal UI was retired in favour of the desktop app; `chimera tui` must fall through to the
// unknown-command usage path instead of spawning a launcher that no longer exists.
describe("chimera tui (retired)", () => {
  it("is an unknown command: exits 1 and the usage line no longer advertises it", async () => {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", CLI, "tui"], { env }, (err, _out, errOut) =>
        resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr: errOut }));
    });
    expect(code).toBe(1);
    expect(stderr).toContain("usage: chimera <");
    expect(stderr).not.toMatch(/\btui\b/);
  }, 20_000);
});
