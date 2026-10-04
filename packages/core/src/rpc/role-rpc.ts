// Ad-hoc sessions design §4: role.* RPC family, mirrors team-rpc.ts's own
// ContractHandlers-slice shape verbatim. No running-member guard is needed (unlike
// team.dissolve/team.update on `roles`) — a role has no live members to protect directly;
// deleting or editing one only affects FUTURE spawns/resolutions that reference its name.
//
// ROLES-UNIFY §3.1/§5: `update`'s old propagation loop (fan out a materialized copy to
// every team that had attached this role) is DELETED — every team binding now resolves
// the library live via resolveRole, so there is nothing to fan out (this also closes the
// roles-tab spec's own §11 propagation write-amplification risk outright, §9.4).
// `delete` REFUSES while any team's binding still references this role — the data source
// for that check is now a live scan of every team's bindings, not the old `sharedRoles`
// marker list.
import type { ContractHandlers } from "@chimera/protocol/contract";
import { rpcError } from "../rpc-error.js";
import type { RoleStore } from "../roles-store.js";
import type { TeamManager } from "../teams.js";

export type RoleRpcHandlers = Pick<ContractHandlers, "role.create" | "role.list" | "role.update" | "role.delete">;

export class RoleRpc {
  readonly handlers: RoleRpcHandlers;

  constructor(private readonly deps: { roles: RoleStore; teams: TeamManager }) {
    this.handlers = {
      "role.create": (p) => this.deps.roles.create(p.spec),
      "role.list": () => this.deps.roles.list(),
      "role.update": (p) => this.deps.roles.update(p.name, p.patch),
      "role.delete": (p) => {
        const attachedIn = this.deps.teams.list()
          .filter((t) => Object.values(t.roles).some((binding) => binding.role === p.name))
          .map((t) => t.name);
        if (attachedIn.length > 0) {
          throw rpcError("protocol", `role "${p.name}" is still attached to team(s): ${attachedIn.join(", ")} — detach it first`);
        }
        this.deps.roles.delete(p.name);
        return { ok: true as const };
      },
    };
  }
}
