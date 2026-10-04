import { describe, it, expect } from "vitest";
import { AgentSummarySchema } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

describe("AgentSummary.workdir", () => {
  it("accepts a string workdir", () => {
    const parsed = AgentSummarySchema.parse({
      id: "a1", name: "Work", role: null, status: "running", model: null,
      depth: 0, parentId: null, costUsd: 0, gitBranch: null,
      workdir: "/repo/.chimera/worktrees/a1",
    });
    expect(parsed.workdir).toBe("/repo/.chimera/worktrees/a1");
  });

  it("stays valid when workdir is omitted (pre-change client parity)", () => {
    const parsed = AgentSummarySchema.parse({
      id: "a1", name: "Work", role: null, status: "running", model: null,
      depth: 0, parentId: null, costUsd: 0, gitBranch: null,
    });
    expect(parsed.workdir).toBeUndefined();
  });
});

describe("AgentSummary.displayLabel", () => {
  it("accepts a displayLabel", () => {
    const parsed = AgentSummarySchema.parse({
      id: "a1", name: "claude", role: null, status: "running", model: null,
      depth: 0, parentId: null, costUsd: 0, gitBranch: null,
      displayLabel: "PROJ-1234 owner",
    });
    expect(parsed.displayLabel).toBe("PROJ-1234 owner");
  });

  it("stays valid when displayLabel is omitted (pre-change client parity)", () => {
    const parsed = AgentSummarySchema.parse({
      id: "a1", name: "claude", role: null, status: "running", model: null,
      depth: 0, parentId: null, costUsd: 0, gitBranch: null,
    });
    expect(parsed.displayLabel).toBeUndefined();
  });
});

describe("AgentSummary seen-state (F47, A9)", () => {
  const base = {
    id: "a1", name: "claude", role: null, status: "running", model: null,
    depth: 0, parentId: null, costUsd: 0, gitBranch: null,
  };

  it("all three fields are optional and omitted when absent (pre-F47 client parity)", () => {
    const parsed = AgentSummarySchema.parse(base);
    expect(parsed.attentionAt).toBeUndefined();
    expect(parsed.reviewedAt).toBeUndefined();
    expect(parsed.unseen).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("unseen");
  });

  it("agent.listSummary projects the stamps and the DERIVED unseen verdict, omitting them otherwise", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([
        [{ end: { resultText: "r" } }],   // attention-worthy
        [{ awaitSend: true }],            // merely busy
      ])]]),
    });
    const loud = await e.supervisor.spawn({ prompt: "a", cwd: "/tmp", isolation: "none" });
    const quiet = await e.supervisor.spawn({ prompt: "b", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 30));

    const rows = (await e.handle("agent.listSummary", {})) as Array<Record<string, unknown>>;
    const loudRow = rows.find((r) => r["id"] === loud.agentId)!;
    const quietRow = rows.find((r) => r["id"] === quiet.agentId)!;

    expect(typeof loudRow["attentionAt"]).toBe("number");
    expect(loudRow["unseen"]).toBe(true);
    // omit-when-absent: an agent nobody needs to look at costs zero extra bytes on the wire.
    expect(quietRow).not.toHaveProperty("attentionAt");
    expect(quietRow).not.toHaveProperty("reviewedAt");
    expect(quietRow).not.toHaveProperty("unseen");

    // ...and every row still parses as an AgentSummary.
    for (const r of rows) expect(AgentSummarySchema.safeParse(r).success).toBe(true);
  });
});
