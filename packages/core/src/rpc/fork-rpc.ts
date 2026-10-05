import type { ContractHandlers } from "@chimera/protocol/contract";
import { ConversationForks } from "../fork.js";
import { rpcError } from "../rpc-error.js";

export class ForkRpc {
  readonly handlers: Pick<ContractHandlers, "agent.forkCapabilities" | "agent.fork">;
  constructor(private readonly forks: ConversationForks) {
    const authority = (p: { callerAgentId?: string }) => {
      if (!p.callerAgentId) throw rpcError("forbidden", "Branching requires an authenticated agent or trusted operator route");
      return { agentId: p.callerAgentId };
    };
    this.handlers = {
      "agent.forkCapabilities": p => forks.capabilities(p, authority(p)),
      "agent.fork": p => forks.create(p, authority(p)),
    };
  }
  operator(method: string, p: { agentId: string; callerAgentId?: string }) {
    if (p.callerAgentId) return this.handlers[method as keyof typeof this.handlers](p as never);
    return method === "agent.fork" ? this.forks.create(p, { operator: true }) : this.forks.capabilities(p, { operator: true });
  }
}
