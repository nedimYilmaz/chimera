import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

describe("Engine agent.spawn treeId plumbing", () => {
  it("forwards treeId to the supervisor and defaults roots to their own agentId", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
    });
    const child = (await e.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", isolation: "none" }, treeId: "tree-42",
    })) as { treeId: string };
    expect(child.treeId).toBe("tree-42");

    const root = (await e.handle("agent.spawn", {
      spec: { prompt: "p2", cwd: "/tmp", isolation: "none" },
    })) as { agentId: string; treeId: string };
    expect(root.treeId).toBe(root.agentId);
  });

  it("keeps enforcing the parent depth cap: maxDepthCap 1 with depth 2 rejects (guardrail)", async () => {
    const e = new Engine({
      home: makeEngineHome(),
      backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
    });
    // regression pin for the Phase 1 maxDepthCap plumbing: the child's own high maxDepth must NOT escape the parent's cap
    await expect(e.handle("agent.spawn", {
      spec: { prompt: "deep", cwd: "/tmp", isolation: "none", orchestration: { allow: false, maxDepth: 9 } },
      depth: 2, maxDepthCap: 1,
    })).rejects.toMatchObject({ code: "guardrail" });
  });
});
