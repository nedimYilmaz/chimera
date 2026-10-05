import { emptyCanvasLayout, type ContextLinkView, type ArtifactRecord } from "@chimera/protocol";
import type { ContractHandlers } from "@chimera/protocol/contract";
import { assembleCanvas, type CanvasAgent, type CanvasTask } from "../canvas.js";
import { CanvasStore } from "../canvas-store.js";
import { rpcError } from "../rpc-error.js";

type Deps = {
  store: CanvasStore; projectQueues(projectId: string): string[];
  agents(): CanvasAgent[]; tasks(): CanvasTask[]; artifacts(): ArtifactRecord[];
  links(callerAgentId?: string): ContextLinkView[];
  callerQueue(callerAgentId: string): string | null;
};
export class CanvasRpc {
  readonly handlers: Pick<ContractHandlers, "canvas.get" | "canvas.saveLayout">;
  constructor(private readonly deps: Deps) {
    this.handlers = {
      "canvas.get": p => this.get(p.projectId, p.callerAgentId),
      "canvas.saveLayout": () => { throw rpcError("forbidden", "Canvas layout changes require the trusted operator route"); },
    };
  }
  private graph(projectId: string, callerAgentId?: string) {
    const queues = this.deps.projectQueues(projectId);
    const all = this.deps.agents();
    const caller = callerAgentId ? all.find(a => a.agentId === callerAgentId) : null;
    if (callerAgentId && (!caller || caller.projectId !== projectId)) throw rpcError("forbidden", "Canvas is limited to your own project");
    const agents = all.filter(a => a.projectId === projectId && (!caller || a.principal === caller.principal && a.accountName === caller.accountName && (a.treeId === caller.treeId || !!caller.membership && a.membership?.team === caller.membership.team)));
    const ids = new Set(agents.map(a => a.agentId));
    const callerQueue = caller ? this.deps.callerQueue(caller.agentId) : null;
    const tasks = this.deps.tasks().filter(t => queues.includes(t.queue) && (!caller || t.queue === callerQueue));
    const taskIds = new Set(tasks.map(t => t.taskId));
    const artifacts = this.deps.artifacts().filter(a => (a.agentId && ids.has(a.agentId) || a.taskId && taskIds.has(a.taskId)) && (!caller || !a.agentId || ids.has(a.agentId)));
    const links = this.deps.links(callerAgentId).filter(l => ids.has(l.toAgentId));
    return assembleCanvas({ agents, tasks, artifacts, links });
  }
  private get(projectId: string, callerAgentId?: string) {
    if (!callerAgentId) throw rpcError("forbidden", "Canvas requires authenticated caller or trusted operator");
    const graph = this.graph(projectId, callerAgentId);
    // Operator layout, groups and text stickies are private cosmetic state.
    return { nodes: graph.nodes, edges: graph.edges, truncated: graph.truncated, revision: 0, layout: emptyCanvasLayout(), readOnly: true };
  }
  operator(method: string, p: { projectId: string; callerAgentId?: string; baseRevision?: number; layout?: Parameters<CanvasStore["save"]>[2] }) {
    if (p.callerAgentId) return this.handlers["canvas.get"](p);
    const graph = this.graph(p.projectId);
    if (method === "canvas.saveLayout") return this.deps.store.save(p.projectId, p.baseRevision!, p.layout!, graph.refs);
    return { nodes: graph.nodes, edges: graph.edges, truncated: graph.truncated, ...this.deps.store.get(p.projectId, graph.refs) };
  }
}
