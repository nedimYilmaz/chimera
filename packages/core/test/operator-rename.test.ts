import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// OPERATOR-RENAME: the one-shot on renameAgent protects the OPERATOR's choice FROM the agent —
// a name set at spawn, or the one free self-rename already spent. Neither reason is about the
// operator, and applying the guard to them meant a name once set could never be corrected: a
// quick-spawned agent was stuck with whatever it called itself, forever.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 6 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const spawn = async (e: Engine, spec: Record<string, unknown> = {}) =>
  (await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none", ...spec } })) as { agentId: string };

const labelOf = (e: Engine, id: string) => e.supervisor.status(id).displayLabel;

describe("an operator can rename an agent", () => {
  it("renames one the agent already named itself — the case that was impossible before", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "chose-its-own", self: true });
    expect(labelOf(e, a.agentId)).toBe("chose-its-own");

    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "what I actually call it" });
    expect(labelOf(e, a.agentId)).toBe("what I actually call it");
  });

  it("renames one that was named at spawn", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e, { displayLabel: "named-at-spawn" });
    await flush();
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "renamed" });
    expect(labelOf(e, a.agentId)).toBe("renamed");
  });

  it("renames REPEATEDLY — the one-shot was never about the operator", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    for (const n of ["one", "two", "three"]) await e.handle("agent.rename", { agentId: a.agentId, displayLabel: n });
    expect(labelOf(e, a.agentId)).toBe("three");
  });

  it("emits the new label so every connected client updates without a refetch", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "visible-now" });
    const seen = e.events.tail(a.agentId, 50).some((ev) => ev.data["displayLabel"] === "visible-now");
    expect(seen).toBe(true);
  });
});

describe("the agent's own one-shot is unchanged", () => {
  it("an agent gets exactly one free name", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "first", self: true });
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "second", self: true });
    expect(labelOf(e, a.agentId)).toBe("first");
  });

  it("and can never overwrite a name the OPERATOR chose — the reason the guard exists", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e);
    await flush();
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "operator's name" });
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "agent's idea", self: true });
    expect(labelOf(e, a.agentId)).toBe("operator's name");
  });

  it("a caller that omits `self` is treated as the operator, never silently denied", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const a = await spawn(e, { displayLabel: "pinned" });
    await flush();
    await e.handle("agent.rename", { agentId: a.agentId, displayLabel: "applied" });
    expect(labelOf(e, a.agentId)).toBe("applied");
  });
});
