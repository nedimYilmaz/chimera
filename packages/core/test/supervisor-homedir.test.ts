import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { CLAUDE_HOME_B, CODEX_HOME_A, makeMultiProviderSupervisor } from "./helpers.js";

const HAPPY: FakeStep[] = [{ end: { resultText: "ok" } }];

describe("AgentSupervisor homeDir injection", () => {
  it("codex account homeDir becomes CODEX_HOME in the child env", async () => {
    const { sup, codex } = makeMultiProviderSupervisor([], [HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx-main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    expect(codex.spawns[0]!.env["CODEX_HOME"]).toBe(CODEX_HOME_A);
    expect(codex.spawns[0]!.env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
  });

  it("claude account homeDir becomes CLAUDE_CONFIG_DIR", async () => {
    const { sup, claude } = makeMultiProviderSupervisor([HAPPY], []);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "cl-second", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    expect(claude.spawns[0]!.env["CLAUDE_CONFIG_DIR"]).toBe(CLAUDE_HOME_B);
    expect(claude.spawns[0]!.env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-second");   // credential still injected
  });

  it("accounts without homeDir inject neither variable", async () => {
    const { sup, claude } = makeMultiProviderSupervisor([HAPPY], []);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "cl-main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    expect(claude.spawns[0]!.env["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(claude.spawns[0]!.env["CODEX_HOME"]).toBeUndefined();
  });

  it("pre-creates the homeDir directory before spawn (codex requires CODEX_HOME to exist)", async () => {
    const freshHome = join(mkdtempSync(join(tmpdir(), "chimera-cxfresh-")), "not-created-yet");
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "cl-main", provider: "claude", auth: { type: "subscription" } },
        { name: "cx-fresh", provider: "codex", auth: { type: "env", var: "CODEX_KEY_SRC", injectAs: "OPENAI_API_KEY", homeDir: freshHome } },
      ],
      autoOrder: ["cl-main", "cx-fresh"],
      caps: { maxAgentsTotal: 6, perAccount: {} },
    });
    expect(existsSync(freshHome)).toBe(false);
    const { sup, codex } = makeMultiProviderSupervisor([], [HAPPY], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx-fresh", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    expect(existsSync(freshHome)).toBe(true);            // mkdirSync recursive ran before backend.spawn
    expect(codex.spawns[0]!.env["CODEX_HOME"]).toBe(freshHome);
  });

  // Edge case beyond the brief: mkdirSync(homeDir, { recursive: true }) throws when a path
  // segment already exists as a non-directory (ENOTDIR) — e.g. homeDir itself collides with a
  // plain file. This must propagate out of launch() and hit spawn()'s existing catch, which
  // deletes the just-created agent record, rather than leaving a "running" ghost with no handle.
  it("mkdirSync failure (homeDir collides with an existing file) propagates and leaves no dangling agent record", async () => {
    expect.assertions(2);
    const collidingPath = join(mkdtempSync(join(tmpdir(), "chimera-cxcollide-")), "blocked-by-file");
    writeFileSync(collidingPath, "not a directory");
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "cl-main", provider: "claude", auth: { type: "subscription" } },
        { name: "cx-collide", provider: "codex", auth: { type: "env", var: "CODEX_KEY_SRC", injectAs: "OPENAI_API_KEY", homeDir: collidingPath } },
      ],
      autoOrder: ["cl-main", "cx-collide"],
      caps: { maxAgentsTotal: 6, perAccount: {} },
    });
    const { sup } = makeMultiProviderSupervisor([], [HAPPY], cfg);
    try {
      await sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx-collide", isolation: "none" });
      expect.unreachable("spawn should have rejected on mkdirSync ENOTDIR");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
    expect(sup.list()).toHaveLength(0);                   // spawn()'s catch deleted the record — no ghost left running
  });
});
