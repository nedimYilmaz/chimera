// PLAN-HOOKS.md §2/§6.1 (HOOK-2): sub.create/remove/list RPC family — thin dispatch onto
// SubscriptionRegistry (subscriptions.ts), mirroring shadow-rpc.ts's shape. `subscriberId` is a
// normal required field on the request schema; trusting it is the CALLER's job (the future
// subscribe/unsubscribe/subscriptions_list MCP tools, HOOK-3, stamp it from ctx and never let
// the calling agent supply an arbitrary one — same boundary TeamSpec.createdBy's stamping
// convention draws at the tool layer, not the RPC layer).
import type { ContractHandlers } from "@chimera/protocol/contract";
import type { SubscriptionRegistry } from "../subscriptions.js";

export type SubRpcHandlers = Pick<ContractHandlers, "sub.create" | "sub.remove" | "sub.list">;

export class SubRpc {
  readonly handlers: SubRpcHandlers;

  constructor(private readonly deps: { registry: SubscriptionRegistry }) {
    this.handlers = {
      "sub.create": (p) => this.deps.registry.create(p),
      "sub.remove": (p) => ({ removed: this.deps.registry.remove(p.subscriberId, p.id) }),
      "sub.list": (p) => this.deps.registry.list(p.subscriberId),
    };
  }
}
