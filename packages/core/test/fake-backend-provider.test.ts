import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import {
  makeMultiProviderSupervisor, makeMultiProviderHome, MULTI_CFG, CLAUDE_HOME_B, CODEX_HOME_A,
} from "./helpers.js";

const HAPPY: FakeStep[] = [{ end: { resultText: "ok", costUsd: 0 } }];

describe("FakeAgentBackend provider parameter", () => {
  it("defaults to claude, accepts codex", () => {
    expect(new FakeAgentBackend([]).provider).toBe("claude");
    expect(new FakeAgentBackend([], "codex").provider).toBe("codex");
  });

  // Guards the implementation choice: a real defaulted parameter only substitutes
  // on `undefined`. If this were ever rewritten as `provider || "claude"`, an
  // explicit falsy-but-valid provider string would be silently coerced to "claude".
  it("treats an explicit empty-string provider literally, not as a fallback trigger", () => {
    expect(new FakeAgentBackend([], "").provider).toBe("");
  });

  it("accepts an explicitly-passed \"claude\" the same as the default", () => {
    expect(new FakeAgentBackend([], "claude").provider).toBe("claude");
  });

  it("supervisor routes a codex-account spawn to the codex backend with the injected key", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([], [HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "cx-main", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.provider).toBe("codex");
    expect(claude.spawns.length).toBe(0);
    expect(codex.spawns[0]!.accountName).toBe("cx-main");
    expect(codex.spawns[0]!.resolvedProvider).toBe("codex");
    expect(codex.spawns[0]!.env["OPENAI_API_KEY"]).toBe("sk-codex");
  });

  it("an auto-routed spawn (no explicit account) dispatches through the claude backend, not codex", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([HAPPY], []);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.provider).toBe("claude");
    expect(claude.spawns[0]!.accountName).toBe("cl-main");
    expect(codex.spawns.length).toBe(0);
  });

  it("accepts a custom cfg override instead of defaulting to MULTI_CFG", async () => {
    const soloCfg = ChimeraConfigSchema.parse({
      accounts: [{ name: "solo", provider: "codex", auth: { type: "env", var: "CODEX_KEY_SRC", injectAs: "OPENAI_API_KEY" } }],
      autoOrder: ["solo"],
    });
    const { sup, claude, codex } = makeMultiProviderSupervisor([], [HAPPY], soloCfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(codex.spawns[0]!.accountName).toBe("solo");
    expect(claude.spawns.length).toBe(0);
  });

  it("returns a real, existing scratch dir, freshly mkdtemp'd on every call", () => {
    const a = makeMultiProviderSupervisor([], []);
    const b = makeMultiProviderSupervisor([], []);
    expect(existsSync(a.dir)).toBe(true);
    expect(existsSync(b.dir)).toBe(true);
    expect(a.dir).not.toBe(b.dir);
  });
});

describe("makeMultiProviderHome", () => {
  it("writes a config.json with a claude + codex account pair in the documented autoOrder", () => {
    const home = makeMultiProviderHome();
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
      accounts: Array<{ name: string; provider: string }>; autoOrder: string[];
    };
    expect(cfg.accounts.map((a) => a.name)).toEqual(["cl", "cx"]);
    expect(cfg.accounts.map((a) => a.provider)).toEqual(["claude", "codex"]);
    expect(cfg.autoOrder).toEqual(["cl", "cx"]);
  });

  it("mkdtemp's a distinct home dir on every call, never a fixed shared path", () => {
    const h1 = makeMultiProviderHome();
    const h2 = makeMultiProviderHome();
    expect(existsSync(h1)).toBe(true);
    expect(existsSync(h2)).toBe(true);
    expect(h1).not.toBe(h2);
  });
});

describe("multi-provider test-rig constants", () => {
  it("MULTI_CFG has 2 claude accounts + 1 codex account in the documented autoOrder", () => {
    expect(MULTI_CFG.accounts.map((a) => a.name)).toEqual(["cl-main", "cl-second", "cx-main"]);
    expect(MULTI_CFG.accounts.map((a) => a.provider)).toEqual(["claude", "claude", "codex"]);
    expect(MULTI_CFG.autoOrder).toEqual(["cl-main", "cl-second", "cx-main"]);
  });

  it("CLAUDE_HOME_B and CODEX_HOME_A are distinct, existing, mkdtemp'd directories", () => {
    expect(existsSync(CLAUDE_HOME_B)).toBe(true);
    expect(existsSync(CODEX_HOME_A)).toBe(true);
    expect(CLAUDE_HOME_B).not.toBe(CODEX_HOME_A);
  });
});
