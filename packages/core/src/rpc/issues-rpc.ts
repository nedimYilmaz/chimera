import type { ContractHandlers } from "@chimera/protocol/contract";
import type { IssuesBoard } from "../issues-board.js";
import type { QueueStore } from "../queues.js";
import { rpcError } from "../rpc-error.js";

type Methods = "issues.sourceList" | "issues.sourceUpsert" | "issues.sourceRemove" | "issues.sync" | "issues.linkList" | "issues.postComment";
export class IssuesRpc {
  readonly handlers: Pick<ContractHandlers, Methods>;
  constructor(deps: {
    board: IssuesBoard; queues: QueueStore;
    projectExists: (id: string) => boolean;
    scope: (caller: string) => { projectId: string | null; queue: string | null; conductor: boolean; projectQueues: string[] };
    origin: (queue: string, caller: string | null) => Promise<string | null>;
    tick: () => Promise<void>;
  }) {
    const allowed = (caller: string | undefined, projectId: string, queue?: string): boolean => {
      if (!caller) return true;
      const scope = deps.scope(caller);
      return scope.projectId === projectId && (queue ? scope.queue === queue || (scope.conductor && scope.projectQueues.includes(queue)) : scope.conductor);
    };
    const check = (caller: string | undefined, projectId: string, queue?: string) => {
      if (!deps.projectExists(projectId)) throw rpcError("protocol", "Unknown project");
      if (!allowed(caller, projectId, queue)) throw rpcError("permission", "Issue source is outside your project/queue authority");
    };
    const source = (id: string, caller?: string) => { const s = deps.board.source(id); check(caller, s.projectId, s.queue); return s; };
    this.handlers = {
      "issues.sourceList": p => deps.board.sourceList().filter(s => (!p.projectId || s.projectId === p.projectId) && (!p.queue || s.queue === p.queue) && allowed(p.callerAgentId, s.projectId, s.queue)),
      "issues.sourceUpsert": p => {
        if (p.id) source(p.id, p.callerAgentId);
        check(p.callerAgentId, p.projectId, p.queue);
        // Agents use their own existing paused queue; creating an unbound queue would widen authority.
        if (p.callerAgentId && !p.queue) throw rpcError("permission", "Agents must bind their authorized paused queue");
        return deps.board.upsert(p);
      },
      "issues.sourceRemove": p => { source(p.sourceId, p.callerAgentId); return { removed: deps.board.remove(p.sourceId) }; },
      "issues.sync": async p => {
        const s = source(p.sourceId, p.callerAgentId);
        if (p.callerAgentId && !deps.queues.get(s.queue).paused) throw rpcError("permission", "Agent imports require a paused queue");
        const origin = await deps.origin(s.queue, p.callerAgentId ?? null);
        const result = await deps.board.sync(s.id, p.callerAgentId ?? null, origin);
        await deps.tick(); return result;
      },
      "issues.linkList": p => deps.board.linkList().filter(l => {
        const scope = deps.board.importScope(l.taskId);
        return !!scope && (!p.taskId || l.taskId === p.taskId) && (!p.sourceId || l.sourceId === p.sourceId) && (!p.queue || scope.queue === p.queue) && allowed(p.callerAgentId, scope.projectId, scope.queue);
      }),
      "issues.postComment": p => {
        const scope = deps.board.importScope(p.taskId); if (!scope) throw rpcError("protocol", "Task has no issue link");
        check(p.callerAgentId, scope.projectId, scope.queue); return deps.board.postComment(p);
      },
    };
  }
}
