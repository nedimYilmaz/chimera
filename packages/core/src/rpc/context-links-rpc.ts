import type { ContractHandlers } from "@chimera/protocol/contract";
import type { ContextLinkStore, ContextAuthority } from "../context-links.js";
import { rpcError } from "../rpc-error.js";

export class ContextLinksRpc {
  readonly handlers: Pick<ContractHandlers, "contextlink.create" | "contextlink.list" | "contextlink.get" | "contextlink.revoke">;
  constructor(private readonly store: ContextLinkStore, private readonly notify: (agentId: string, linkId: string) => Promise<void> = async () => {}) {
    this.handlers = {
      "contextlink.create": p => this.create(p, this.authority(p)),
      "contextlink.list": p => store.list(p, this.authority(p)),
      "contextlink.get": p => store.get(p.id, this.authority(p)),
      "contextlink.revoke": p => store.revoke(p.id, this.authority(p)),
    };
  }
  private authority(p: { callerAgentId?: string }): ContextAuthority {
    if (!p.callerAgentId) throw rpcError("forbidden", "Context links require an authenticated agent or trusted operator route");
    return { agentId: p.callerAgentId };
  }
  private async create(p: Parameters<ContextLinkStore["create"]>[0], authority: ContextAuthority) {
    const link = this.store.create(p, authority);
    if (p.notify) {
      try { await this.notify(p.toAgentId, link.id); return { ...link, notification: "queued" as const }; }
      catch { return { ...link, notification: "failed" as const }; }
    }
    return link;
  }
  operator(method: string, p: unknown): unknown {
    const authority = { operator: true } as const;
    // The transport supplies this authority; request fields cannot set it.
    const params = p as Parameters<ContextLinkStore["create"]>[0] & { id: string };
    if (params.callerAgentId) return this.handlers[method as keyof typeof this.handlers](params);
    switch (method) {
      case "contextlink.create": return this.create(params, authority);
      case "contextlink.list": return this.store.list(params, authority);
      case "contextlink.get": return this.store.get(params.id, authority);
      case "contextlink.revoke": return this.store.revoke(params.id, authority);
      default: throw rpcError("protocol", "Unknown context link method");
    }
  }
}
