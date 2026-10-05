import { describe, it, expect } from "vitest";
import { assembleCanvas, type CanvasAgent } from "../src/canvas.js";
const agent = (id: string): CanvasAgent => ({ agentId: id, projectId: "p", state: "idle", principal: "local", accountName: "a", treeId: "tree", spec: { isolation: "none" } });
describe("bounded entity canvas", () => {
  it("projects fork, dependency, worktree and issue relationships from existing entities", () => {
    const graph = assembleCanvas({ agents: [agent("a"), { ...agent("b"), spec: { isolation: "worktree" }, gitBranch: "branch", forkLineage: { forkedFrom: "a", mode: "snapshot", atSeq: 2 } }], tasks: [{ taskId: "t", queue: "q", prompt: "Review", state: "pending", agentId: "b", dependsOn: ["before"], issueLink: { url: "https://example.com", number: 4 } }, { taskId: "before", queue: "q", prompt: "first", state: "done", agentId: null, dependsOn: [] }], artifacts: [], links: [] });
    expect(graph.edges).toEqual(expect.arrayContaining([{ from: "agent:a", to: "agent:b", kind: "fork", label: "snapshot branch" }, { from: "task:before", to: "task:t", kind: "dependsOn" }, { from: "issue:t", to: "task:t", kind: "issue" }]));
    expect(graph.nodes.find(n => n.ref === "worktree:b")?.label).toBe("branch");
  });
  it("caps a representative 3000-agent graph and keeps only edges with visible endpoints", () => {
    const agents = Array.from({ length: 3000 }, (_, i) => agent(String(i)));
    const graph = assembleCanvas({ agents, tasks: [], artifacts: [], links: [] });
    expect(graph.nodes).toHaveLength(300); expect(graph.nodes.at(-1)?.count).toBe(2701); expect(graph.refs.size).toBe(3000); expect(graph.truncated).toBe(true);
    expect(assembleCanvas({ agents: [...agents].reverse(), tasks: [], artifacts: [], links: [] }).nodes).toEqual(graph.nodes);
  });
});
it("renders explicit shared-note metadata only and keeps active/revoked context provenance", () => {
  const link = { id: "shared", from: { kind: "note-snapshot" as const, ref: "a" }, toAgentId: "b", createdBy: "operator", createdAt: 1, expiresAt: null, revokedAt: null, snapshot: { title: "Shared note", bytes: 7, sha256: "0".repeat(64), text: "PRIVATE BODY" }, status: "active" as const, semantics: "snapshot" as const, untrusted: false };
  const graph = assembleCanvas({ agents: [agent("a"), agent("b")], tasks: [], artifacts: [], links: [link] });
  expect(JSON.stringify(graph.nodes)).not.toContain("PRIVATE BODY");
  expect(graph.edges).toContainEqual({ from: "context-link:shared", to: "agent:b", kind: "context", label: "note-snapshot · active" });
  const revoked = assembleCanvas({ agents: [agent("b")], tasks: [], artifacts: [], links: [{ ...link, status: "revoked", revokedAt: 2 }] });
  expect(revoked.nodes.find(n => n.kind === "context-link")?.status).toBe("revoked");
});
