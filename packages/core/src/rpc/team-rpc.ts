// FEATURE-11: team.* RPC family, extracted verbatim out of engine.ts's old inline `switch`
// case bodies (see PLAN.md's "team-rpc.ts" section) into its own ContractHandlers slice.
// Constructed once by Engine, after teams/queues/scheduler/supervisor are all assigned (see
// engine.ts's constructor) — `handlers` is a plain object of bound closures, spread into
// Engine's `contractHandlers` alongside the other migrated families.
import type { RoleBinding } from "@chimera/protocol";
import type { ContractHandlers } from "@chimera/protocol/contract";
import { rpcError } from "../rpc-error.js";
import type { TeamManager } from "../teams.js";
import type { QueueStore } from "../queues.js";
import type { QueueScheduler } from "../scheduler.js";
import type { AgentSupervisor } from "../supervisor.js";
import type { RoleStore } from "../roles-store.js";
import { resolveRole } from "../shared-roles.js";

export type TeamRpcHandlers = Pick<ContractHandlers, "team.create" | "team.list" | "team.status" | "team.mine" | "team.dissolve" | "team.update" | "team.attachRole" | "team.detachRole" | "team.updateRoleBinding">;

// ROLES-TAB S2 §4: shared by team.detachRole and role.delete's attached-elsewhere refusal —
// same "running members / live tasks" blocker team.update's roles-removal guard already
// computes, extracted so both call sites stay byte-identical.
export function inUseBlocker(
  deps: { teams: TeamManager; queues: QueueStore; scheduler: QueueScheduler },
  team: string, role: string,
): { role: string; members: string[]; tasks: string[] } | null {
  const current = deps.teams.get(team);
  const boundQueue = current.queue;
  const liveTasks = boundQueue && deps.queues.list().some((q) => q.name === boundQueue)
    ? deps.queues.status(boundQueue).tasks.filter((t) => t.state === "pending" || t.state === "blocked" || t.state === "in_progress")
    : [];
  const liveTaskRoles = liveTasks.map((t) => ({ taskId: t.taskId, role: deps.scheduler.routingRoleFor(current, t) }));
  const members = deps.scheduler.membersOf(team, role).map((m) => m.agentId);
  const tasks = liveTaskRoles.filter((t) => t.role === role).map((t) => t.taskId);
  if (members.length === 0 && tasks.length === 0) return null;
  return { role, members, tasks };
}

export class TeamRpc {
  readonly handlers: TeamRpcHandlers;

  constructor(private readonly deps: {
    teams: TeamManager; queues: QueueStore; scheduler: QueueScheduler; supervisor: AgentSupervisor; roles: RoleStore;
  }) {
    this.handlers = {
      // ROLES-BINDING-CORRECTNESS: unlike team.attachRole/team.updateRoleBinding (below),
      // team.create never validated that its roles[key].role bindings reference a real
      // library role — a typo'd/nonexistent name parsed fine and only failed, silently,
      // at resolveRole time far from the mistake (team.status's not_spawned preview or an
      // actual spawn attempt). Same "reject at create" discipline as the queue check right
      // below and as JOB-ROLE-TARGET's create-time role validation — UnknownRoleError
      // BEFORE anything persists, naming the bad role.
      "team.create": async (p) => {
        for (const binding of Object.values(p.spec.roles)) this.deps.roles.get(binding.role);
        if (p.spec.queue !== null) this.deps.queues.get(p.spec.queue);   // UnknownQueueError BEFORE anything persists
        const spec = this.deps.teams.create(p.spec);
        await this.deps.scheduler.tick();
        return spec;
      },
      // TEAM-STATS: totalRuns sums runCountFor over every agent supervisor.list()
      // has EVER tagged with this team's membership (terminal records included —
      // see the team.status comment below), one pass over the full agent list
      // shared across every team instead of N separate scans.
      "team.list": () => {
        const totalRunsByTeam = new Map<string, number>();
        for (const rec of this.deps.supervisor.list()) {
          const team = rec.membership?.team;
          if (!team) continue;
          totalRunsByTeam.set(team, (totalRunsByTeam.get(team) ?? 0) + this.deps.scheduler.runCountFor(rec.agentId));
        }
        return this.deps.teams.list().map((t) => ({
          ...t,
          running: this.deps.scheduler.runningFor(t.name),
          totalRuns: totalRunsByTeam.get(t.name) ?? 0,
        }));
      },
      "team.status": (p) => {
        // BUG (team detail roster): agentsFor() alone (busy/tracked-only) goes empty
        // whenever a team is idle, even though its persistent pool workers are alive
        // and every role stays part of the roster. Build the FULL roster instead:
        // every agent ever spawned under this team's membership (supervisor.list()
        // keeps terminal records forever — see supervisor.ts), phase-tagged running
        // (busy)/idle (alive, unbound)/done/failed/killed, plus a synthetic
        // "not_spawned" row for any role that has never produced an agent. `running`
        // stays the busy count (parity with team.list's runningFor).
        const name = p.name;
        const spec = this.deps.teams.get(name);
        const busyIds = new Set(this.deps.scheduler.agentsFor(name));
        const liveIds = new Set(this.deps.scheduler.membersOf(name).map((m) => m.agentId));
        const rosterRoles = new Set<string>();
        const agents: Array<Record<string, unknown>> = this.deps.supervisor.list()
          .filter((a) => a.membership?.team === name)
          .map((rec) => {
            rosterRoles.add(rec.membership!.role);
            const phase = liveIds.has(rec.agentId) ? (busyIds.has(rec.agentId) ? "running" : "idle") : rec.state;
            return { ...rec, phase, runCount: this.deps.scheduler.runCountFor(rec.agentId) };
          });
        for (const roleName of Object.keys(spec.roles)) {
          if (!rosterRoles.has(roleName)) {
            // ROLES-UNIFY §4: resolve the binding live so the inspector still shows the
            // effective cwd/model/permissionProfile/etc. a spawn WOULD use — falls back to
            // the raw binding if the library entry has since vanished (data-integrity edge
            // case) rather than failing the whole status call.
            let previewSpec: unknown = spec.roles[roleName];
            try { previewSpec = resolveRole(this.deps.roles, spec.roles[roleName]!); } catch { /* library entry gone — show the raw binding */ }
            agents.push({ agentId: null, membership: { team: name, role: roleName }, phase: "not_spawned", runCount: 0, spec: previewSpec });
          }
        }
        // TEAM-STATS: sum of the SAME per-agent runCount already on every row
        // above (including the terminal/departed ones supervisor.list() keeps),
        // so this total and the per-agent "runs" column can never disagree.
        const totalRuns = agents.reduce((sum, a) => sum + (typeof a["runCount"] === "number" ? a["runCount"] : 0), 0);
        return { spec, running: busyIds.size, agents, totalRuns };
      },
      // WORKER-TEAM-CONTEXT: authoritative my_team fallback (see contract.ts's TeamMineRequestSchema
      // comment) — resolves the caller's team from ITS OWN AgentRecord.membership, not from an env
      // var a backend might have failed to forward. Reuses team.status verbatim once membership is
      // known, so the response stays byte-identical to a direct team_status call.
      "team.mine": (p) => {
        const record = this.deps.supervisor.list().find((a) => a.agentId === p.agentId);
        if (!record?.membership) return { team: null };
        return this.handlers["team.status"]({ name: record.membership.team });
      },
      "team.dissolve": (p) => {
        this.deps.teams.dissolve(p.name);
        this.deps.scheduler.retire(p.name);   // Task A4: close+de-register the team's persistent pool workers
        return { ok: true as const };
      },
      // [TEAM-ROLES-ONTHEFLY] A roles patch REPLACES the whole roles record, so a role the
      // patch OMITS is an IMPLICIT removal. Rather than lock the entire team while any member
      // runs (the old D11 blanket guard), we diff patch-vs-current and gate only what's unsafe.
      // A role is a spawn TEMPLATE — scheduler.spawnForTask reads team.roles[roleName] FRESH at
      // spawn time; a running agent captured its spec at spawn and never references the template
      // live. So:
      //   • ADDED role   -> always allowed (nothing running could be reading it).
      //   • CHANGED role -> always allowed. Agents already running keep their SPAWN-TIME spec
      //                     (unchanged); the NEXT spawn — INCLUDING a retry/respawn of an existing
      //                     task — uses the new template. That's the intended behavior, not a race.
      //   • REMOVED role -> refused ONLY if that specific role (a) still has running members
      //                     spawned from it (membership.role, via scheduler.membersOf) OR (b) is
      //                     referenced by a non-terminal task (pending/blocked/in_progress) in the
      //                     team's bound queue that would still spawn FROM it. Dropping an UNUSED
      //                     role is allowed even while OTHER roles' members run.
      "team.update": async (p) => {
        if (p.patch.roles !== undefined) {
          const nextRoles = p.patch.roles;
          const current = this.deps.teams.get(p.name);   // UnknownTeamError BEFORE any diff/persist
          const removed = Object.keys(current.roles).filter((r) => !(r in nextRoles));
          if (removed.length > 0) {
            // Non-terminal only, dangling-queue-safe, effective-role-resolved — see
            // inUseBlocker's own comment. Resolved against `current` (pre-removal) roles.
            const blockers = removed
              .map((role) => inUseBlocker(this.deps, p.name, role))
              .filter((b): b is NonNullable<typeof b> => b !== null);
            if (blockers.length > 0) {
              const detail = blockers
                .map((b) => `"${b.role}" (running members: ${b.members.join(", ") || "none"}; blocking tasks: ${b.tasks.join(", ") || "none"})`)
                .join("; ");
              throw rpcError("protocol", `team "${p.name}" cannot remove in-use role(s): ${detail}`);
            }
          }
        }
        if (p.patch.queue !== undefined && p.patch.queue !== null) this.deps.queues.get(p.patch.queue);   // UnknownQueueError BEFORE anything persists
        const spec = this.deps.teams.update(p.name, p.patch);
        await this.deps.scheduler.tick();
        return spec;
      },
      // ROLES-UNIFY §5: attach a library role onto this team as a BINDING (a reference, not
      // a materialized copy — sharedRoles bookkeeping is gone, see TeamSpecSchema's own
      // comment). UnknownRoleError from roles.get surfaces as-is.
      "team.attachRole": async (p) => {
        const role = this.deps.roles.get(p.role);   // UnknownRoleError BEFORE anything persists
        const current = this.deps.teams.get(p.team);   // UnknownTeamError BEFORE anything persists
        const key = p.as ?? p.role;
        if (key in current.roles) throw rpcError("protocol", `team "${p.team}" already has a role named "${key}"`);
        // ROLES-UNIFY §2 bind-time invariant: the binding must resolve to a cwd-complete
        // spec. An explicit p.cwd always wins; else the library role's own cwd (if any)
        // already satisfies the invariant with no override needed; else default from an
        // existing sibling binding's resolved cwd (today's attachRole fallback, unchanged).
        const overrides: Record<string, unknown> = {};
        if (p.cwd) {
          overrides["cwd"] = p.cwd;
        } else if (!role.cwd) {
          const siblingCwd = Object.values(current.roles)
            .map((b) => { try { return resolveRole(this.deps.roles, b).cwd; } catch { return undefined; } })
            .find((c): c is string => !!c);
          if (!siblingCwd) throw rpcError("protocol", `team "${p.team}" has no existing role to default cwd from — pass an explicit cwd`);
          overrides["cwd"] = siblingCwd;
        }
        const binding: RoleBinding = { role: p.role, overrides };
        const spec = this.deps.teams.update(p.team, { roles: { ...current.roles, [key]: binding } });
        await this.deps.scheduler.tick();
        return spec;
      },
      "team.detachRole": async (p) => {
        const current = this.deps.teams.get(p.team);   // UnknownTeamError BEFORE anything persists
        if (!(p.role in current.roles)) throw rpcError("protocol", `team "${p.team}" has no role named "${p.role}"`);
        const blocker = inUseBlocker(this.deps, p.team, p.role);
        if (blocker) {
          throw rpcError("protocol", `team "${p.team}" cannot detach in-use role "${blocker.role}" (running members: ${blocker.members.join(", ") || "none"}; blocking tasks: ${blocker.tasks.join(", ") || "none"})`);
        }
        const { [p.role]: _removed, ...remainingRoles } = current.roles;
        const spec = this.deps.teams.update(p.team, { roles: remainingRoles });
        await this.deps.scheduler.tick();
        return spec;
      },
      // ROLES-UNIFY §5: atomic server-side RMW against the CURRENT roles record, touching
      // ONLY roleKey (sibling-preservation, same discipline team.update's own roles RMW
      // requires) — removes the need for ui-state's client-side rebase-at-submit dance.
      "team.updateRoleBinding": async (p) => {
        if (p.role === undefined && p.overrides === undefined) {
          throw rpcError("protocol", "team.updateRoleBinding requires at least one of role/overrides");
        }
        const current = this.deps.teams.get(p.team);   // UnknownTeamError BEFORE anything persists
        const existing = current.roles[p.roleKey];
        if (!existing) throw rpcError("protocol", `team "${p.team}" has no role named "${p.roleKey}"`);
        if (p.role !== undefined) this.deps.roles.get(p.role);   // UnknownRoleError BEFORE anything persists
        const nextBinding: RoleBinding = {
          role: p.role ?? existing.role,
          overrides: p.overrides ?? existing.overrides,
        };
        // §2 bind-time invariant, same check as attachRole above.
        const resolved = resolveRole(this.deps.roles, nextBinding);
        if (!resolved.cwd) {
          throw rpcError("protocol", `role "${nextBinding.role}" has no cwd and the binding sets none — supply an override cwd`);
        }
        const spec = this.deps.teams.update(p.team, { roles: { ...current.roles, [p.roleKey]: nextBinding } });
        await this.deps.scheduler.tick();
        return spec;
      },
    };
  }
}
