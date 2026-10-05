import { emptyCanvasLayout, type CanvasGraph, type CanvasLayout } from "@chimera/protocol";
export const canvasFixture = {
  active: false, mode: "ok", large: false, revision: 0, layout: emptyCanvasLayout(), calls: [] as { method: string; params: Record<string, unknown> }[], removed: false,
  reset() { this.active = true; this.mode = "ok"; this.large = false; this.revision = 0; this.layout = emptyCanvasLayout(); this.calls = []; this.removed = false; },
  graph(): CanvasGraph {
    const nodes: CanvasGraph["nodes"] = [
      { ref: "agent:canvas-a", entityId: "canvas-a", agentId: "canvas-a", kind: "agent", label: "Canvas source", status: "idle" },
      { ref: "agent:canvas-b", entityId: "canvas-b", agentId: "canvas-b", kind: "agent", label: "Snapshot branch", status: "idle" },
      { ref: "context-link:canvas-link", entityId: "canvas-link", agentId: "canvas-b", kind: "context-link", label: "Explicitly shared note snapshot", status: "active" },
      { ref: "artifact:canvas-artifact", entityId: "canvas-artifact", kind: "artifact", label: "Existing artifact", status: "link" },
      { ref: "task:canvas-task", entityId: "canvas-task", queue: "canvas-q", kind: "task", label: "Existing task", status: "pending" },
    ];
    if (this.removed) nodes.splice(0, 1);
    if (this.large) { while (nodes.length < 299) { const id = `fleet-${nodes.length}`; nodes.push({ ref: `agent:${id}`, entityId: id, kind: "agent", label: id, status: "done" }); } nodes.push({ ref: "cluster:more", entityId: "more", kind: "cluster", label: "+151 more · done: 151", status: "truncated", count: 151 }); }
    return { revision: this.revision, layout: this.layout, nodes, edges: this.removed ? [] : [{ from: "agent:canvas-a", to: "agent:canvas-b", kind: "fork", label: "snapshot branch" }, { from: "context-link:canvas-link", to: "agent:canvas-b", kind: "context", label: "note-snapshot · active" }], truncated: this.large, readOnly: false };
  },
  rpc(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params });
    if (method === "canvas.get" && params.projectId === "canvas-second") return { ...this.graph(), layout: emptyCanvasLayout(), revision: 0, truncated: false, edges: [], nodes: [{ ref: "agent:second-owner", entityId: "second-owner", kind: "agent", label: "Other project owner", status: "idle" }] };
    if (method === "canvas.get") {
      if (this.mode === "error") throw new Error("Synthetic canvas outage");
      if (this.mode === "unsupported") throw new Error("unknown method canvas.get");
      return this.graph();
    }
    if (this.mode === "conflict") { this.mode = "ok"; this.revision++; throw new Error("stale_revision"); }
    if (params.baseRevision !== this.revision) throw new Error("stale_revision");
    this.layout = params.layout as CanvasLayout; return { revision: ++this.revision };
  },
};
