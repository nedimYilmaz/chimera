import type { ArtifactRecord, ContextLinkView, ForkLineage, CanvasNode, CanvasEdge } from "@chimera/protocol";
export type CanvasAgent = { agentId: string; projectId: string | null; state: string; principal: string; accountName: string; treeId: string; membership?: { team: string }; forkLineage?: ForkLineage; gitBranch?: string; spec: { isolation: string; title?: string | null } };
export type CanvasTask = { taskId: string; queue: string; prompt: string; state: string; agentId: string | null; dependsOn: string[]; issueLink?: { url: string; number: number } | null };
export type CanvasSources = { agents: CanvasAgent[]; tasks: CanvasTask[]; artifacts: ArtifactRecord[]; links: ContextLinkView[] };
const label = (text: string) => text.slice(0, 200);
export function assembleCanvas(sources: CanvasSources) {
  const nodes: CanvasNode[] = [], edges: CanvasEdge[] = [];
  const add = (kind: CanvasNode["kind"], entityId: string, text: string, status: string, extra: Partial<CanvasNode> = {}) => { const ref = `${kind}:${entityId}`; nodes.push({ ref, kind, entityId, label: label(text), status, ...extra }); return ref; };
  for (const a of sources.agents) {
    const ref = add("agent", a.agentId, a.spec.title || a.agentId, a.state, { agentId: a.agentId });
    if (a.forkLineage) edges.push({ from: `agent:${a.forkLineage.forkedFrom}`, to: ref, kind: "fork", label: `${a.forkLineage.mode} branch` });
    if (a.spec.isolation === "worktree" && a.gitBranch) { const tree = add("worktree", a.agentId, a.gitBranch, a.state, { agentId: a.agentId }); edges.push({ from: ref, to: tree, kind: "ownership" }); }
  }
  for (const t of sources.tasks) {
    const ref = add("task", t.taskId, t.prompt, t.state, { queue: t.queue, ...(t.agentId ? { agentId: t.agentId } : {}) });
    if (t.agentId) edges.push({ from: ref, to: `agent:${t.agentId}`, kind: "ownership" });
    for (const dep of t.dependsOn) edges.push({ from: `task:${dep}`, to: ref, kind: "dependsOn" });
    if (t.issueLink) { const issue = add("issue", t.taskId, `Issue #${t.issueLink.number}`, "linked", { queue: t.queue }); edges.push({ from: issue, to: ref, kind: "issue" }); }
  }
  for (const a of sources.artifacts) {
    const ref = add("artifact", a.id, a.label, a.kind, a.agentId ? { agentId: a.agentId } : {});
    if (a.taskId) edges.push({ from: `task:${a.taskId}`, to: ref, kind: "ownership" });
    else if (a.agentId) edges.push({ from: `agent:${a.agentId}`, to: ref, kind: "ownership" });
  }
  for (const l of sources.links) {
    const ref = add("context-link", l.id, l.snapshot.title, l.status, { agentId: l.toAgentId });
    // A private note is represented ONLY by an explicitly shared snapshot, never its source body.
    if (l.from.kind !== "note-snapshot") edges.push({ from: `${l.from.kind === "artifact" ? "artifact" : "agent"}:${l.from.ref}`, to: ref, kind: "context", label: "shared snapshot" });
    edges.push({ from: ref, to: `agent:${l.toAgentId}`, kind: "context", label: `${l.from.kind} · ${l.status}` });
  }
  nodes.sort((a, b) => a.ref.localeCompare(b.ref));
  const refs = new Set(nodes.map(n => n.ref));
  const visible = nodes.slice(0, nodes.length > 300 ? 299 : 300);
  if (nodes.length > 300) {
    const counts = new Map<string, number>(); for (const n of nodes.slice(299)) counts.set(n.status, (counts.get(n.status) ?? 0) + 1);
    visible.push({ ref: "cluster:more", kind: "cluster", entityId: "more", label: label(`+${nodes.length - 299} more · ${[...counts].map(([s, n]) => `${s}: ${n}`).join(", ")}`), status: "truncated", count: nodes.length - 299 });
  }
  const visibleRefs = new Set(visible.map(n => n.ref));
  const validEdges = edges.filter(e => visibleRefs.has(e.from) && visibleRefs.has(e.to));
  return { nodes: visible, edges: validEdges.slice(0, 1000), refs, truncated: nodes.length > 300 || validEdges.length > 1000 };
}
