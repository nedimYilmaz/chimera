import { describe, it, expect } from "vitest";
import { resolveModel } from "@chimera/core/usage";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// P0-2 MODEL-ATTR: engine.ts's resolveContext used to fall back to the literal string
// "default" for an unpinned spawn (`record.spec.model ?? "default"`), silently mislabeling
// 59% of ledger rows ($785.75) as unattributed. This file covers the fix's acceptance bar:
// a fresh unpinned spawn writes a CONCRETE model id, and the ledger hard-rejects "default"
// as a defensive backstop against the bug recurring.

describe("resolveModel invariant (P0-2)", () => {
  it("passes through any real model id unchanged", () => {
    expect(resolveModel("claude-opus-4-8", "a1")).toBe("claude-opus-4-8");
    expect(resolveModel("unknown", "a1")).toBe("unknown");
  });

  it("throws rather than let the literal string \"default\" reach the ledger", () => {
    expect(() => resolveModel("default", "a1")).toThrow(/default/);
  });
});

describe("engine.ts resolveContext never stamps \"default\" (P0-2)", () => {
  function engineOn(home: string, scenarios: FakeStep[][] = []): Engine {
    return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]) });
  }

  it("an unpinned spawn's agent_started model rides through to the usage row (never \"default\")", async () => {
    const home = makeEngineHome();
    const e = engineOn(home, [[
      { emit: { kind: "agent_started", data: { model: "claude-opus-4-8" } } },
      { emit: { kind: "result", data: { text: "ok", costUsd: 0.1, model: "claude-opus-4-8" } } },
    ]]);
    // No spec.model — an unpinned spawn (the exact case that used to fall back to "default").
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "job", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 2000 });

    const q = (await e.handle("usage.query", { from: 0, to: Date.now() + 1, groupBy: "model" })) as {
      groups: Array<{ key: string; costUsd: number }>;
    };
    expect(q.groups.map((g) => g.key)).not.toContain("default");
    expect(q.groups.find((g) => g.key === "claude-opus-4-8")?.costUsd).toBeCloseTo(0.1, 10);
  });

  it("with no model anywhere (no spec.model, no agent_started/result model), falls back to the provider default, still never \"default\"", async () => {
    const home = makeEngineHome();
    const e = engineOn(home, [[
      { emit: { kind: "agent_started", data: {} } },
      { end: { resultText: "ok", costUsd: 0.05 } },
    ]]);
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "job", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 2000 });

    const q = (await e.handle("usage.query", { from: 0, to: Date.now() + 1, groupBy: "model" })) as {
      groups: Array<{ key: string; costUsd: number }>;
    };
    expect(q.groups.map((g) => g.key)).not.toContain("default");
    // claude's catalog default (providers/catalog.ts) — a concrete id, not "unknown" either,
    // since the provider is known even though nothing echoed a model back.
    expect(q.groups.some((g) => g.key === "claude-opus-4-8")).toBe(true);
  });
});
