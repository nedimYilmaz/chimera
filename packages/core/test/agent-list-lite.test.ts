import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// BOOT-LATENCY-AGENT-LIST: `agent.list {lite:true}` is what both UI stores poll/refetch. Unlike
// agent.listSummary (a 9-field projection) it is the SAME full record set minus four fields of
// pure bulk text — spec.instructions, spec.prompt, resultText, lastTurnBillableUsage — that no
// list view reads. It exists because a real fleet's full snapshot (980 records, 5.36MB) costs
// the daemon ~0.5s of blocked event loop per call, and the desktop app fetches it on every
// connect/reconnect while the TUI polls it every 2s.

const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const BIG = "x".repeat(20_000);

async function spawnAgents(e: Engine, n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, i) => e.handle("agent.spawn", {
    spec: {
      prompt: `${BIG} task ${i}`, cwd: "/tmp", isolation: "none", permissionProfile: "readOnly",
      instructions: BIG, model: "claude-sonnet-5", displayLabel: `worker-${i}`,
    },
  })));
}

describe("agent.list {lite:true}", () => {
  it("drops the bulk text fields and nothing else, shrinking the snapshot by an order of magnitude", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await spawnAgents(e, 10);

    const full = (await e.handle("agent.list", {})) as Array<Record<string, unknown>>;
    const lite = (await e.handle("agent.list", { lite: true })) as Array<Record<string, unknown>>;

    expect(lite.length).toBe(full.length);
    expect(lite.length).toBe(10);

    for (const r of lite) {
      expect(r).not.toHaveProperty("resultText");
      expect(r).not.toHaveProperty("lastTurnBillableUsage");
      const spec = r["spec"] as Record<string, unknown>;
      expect(spec).toBeTruthy();
      expect(spec).not.toHaveProperty("instructions");
      expect(spec).not.toHaveProperty("prompt");
    }

    // Everything else survives — a denylist, so a field added later keeps riding the snapshot
    // rather than silently disappearing from the UI.
    const dropped = new Set(["resultText", "lastTurnBillableUsage"]);
    for (let i = 0; i < full.length; i++) {
      const kept = Object.keys(full[i]!).filter((k) => !dropped.has(k)).sort();
      expect(Object.keys(lite[i]!).sort()).toEqual(kept);
    }

    const fullSize = JSON.stringify(full).length;
    const liteSize = JSON.stringify(lite).length;
    expect(fullSize).toBeGreaterThan(20_000 * 10);   // the instructions+prompt blobs ride every full record
    expect(liteSize).toBeLessThan(fullSize / 10);
  });

  it("keeps every field the UI reducer actually projects off the snapshot", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await spawnAgents(e, 1);

    const [r] = (await e.handle("agent.list", { lite: true })) as Array<Record<string, unknown>>;
    // AgentRecordLite's own declared shape (packages/ui-state/src/types.ts) — the contract the
    // reducer's `agentRecords` case reads. spec keeps the sub-fields it declares.
    for (const f of ["agentId", "state", "accountName", "provider", "costUsd", "createdAt", "spec", "treeId", "depth"]) {
      expect(r).toHaveProperty(f);
    }
    const spec = r!["spec"] as Record<string, unknown>;
    expect(spec["permissionProfile"]).toBe("readOnly");
    expect(spec["displayLabel"]).toBe("worker-0");
  });

  it("without the param the response is byte-identical to today's full record set", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await spawnAgents(e, 3);

    const full = (await e.handle("agent.list", {})) as Array<Record<string, unknown>>;
    for (const r of full) {
      expect((r["spec"] as Record<string, unknown>)["instructions"]).toBe(BIG);
      expect(String((r["spec"] as Record<string, unknown>)["prompt"])).toContain(BIG);
    }
    // lite must not mutate the live records it projects from
    await e.handle("agent.list", { lite: true });
    const again = (await e.handle("agent.list", {})) as Array<Record<string, unknown>>;
    expect(JSON.stringify(again)).toEqual(JSON.stringify(full));
  });
});

describe("agent.list {lite:true} carries F47 seen-state", () => {
  it("attentionAt/reviewedAt survive the lite projection — the badge must not vanish on the polled path", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: backends(new FakeAgentBackend([[{ end: { resultText: "r" } }]])),
    });
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 30));
    await e.handle("agent.markSeen", { agentIds: [rec.agentId] });

    const [lite] = (await e.handle("agent.list", { lite: true })) as Array<Record<string, unknown>>;
    expect(typeof lite!["attentionAt"]).toBe("number");
    expect(typeof lite!["reviewedAt"]).toBe("number");
  });
});
