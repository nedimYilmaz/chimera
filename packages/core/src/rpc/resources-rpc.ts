import type { AgentResourceSample, HostAdmission } from "@chimera/protocol";
import type { ContractHandlers } from "@chimera/protocol/contract";
import type { AgentSupervisor } from "../supervisor.js";
import { ProcessTreeSampler, processExec, unavailableSample, type ProcessExec } from "../process-tree.js";
import { sessionNameFor } from "../terminal-runtime.js";

export class ResourcesRpc {
  readonly handlers: Pick<ContractHandlers, "agent.resources" | "host.admission">;
  private cache = new Map<string, { at: number; key: string; promise: Promise<AgentResourceSample> }>();
  constructor(private readonly deps: {
    supervisor: Pick<AgentSupervisor, "status" | "list" | "resourceProcessPid">;
    admission: () => HostAdmission;
    sampler?: ProcessTreeSampler;
    exec?: ProcessExec;
    now?: () => number;
    platform?: NodeJS.Platform;
  }) {
    const now = deps.now ?? Date.now;
    const sampler = deps.sampler ?? new ProcessTreeSampler(deps.exec, now, deps.platform);
    const exec = deps.exec ?? processExec;
    this.handlers = {
      "host.admission": () => deps.admission(),
      "agent.resources": async ({ agentId, callerAgentId }) => {
        if (callerAgentId && !this.visible(callerAgentId, agentId)) throw new Error("resource access denied: only your agent and descendants are visible");
        const record = deps.supervisor.status(agentId);
        const pid = deps.supervisor.resourceProcessPid(agentId);
        const key = `${record.state}:${pid}:${record.attempts.at(-1)?.startedAt ?? record.createdAt}`;
        let entry = this.cache.get(agentId);
        if (!entry || entry.key !== key || now() - entry.at >= 2000) {
          const old = entry;
          if (old && old.key !== key) sampler.forget(agentId);
          const promise = (async () => {
            let rootPid = pid;
            if (record.state === "running" && record.spec.runtime === "terminal" && (deps.platform ?? process.platform) !== "win32") {
              try {
                const out = await exec("tmux", ["list-panes", "-t", `=${sessionNameFor(agentId)}`, "-F", "#{pane_pid}"]);
                const pids = out.trim().split(/\s+/).filter(p => /^\d+$/.test(p)).map(Number);
                rootPid = pids.length === 1 && pids[0]! > 0 ? pids[0]! : null;
              } catch { rootPid = null; }
            }
            const live = deps.supervisor.list().filter(a => a.state === "running");
            sampler.retainOwners(new Set(live.map(a => a.agentId)));
            const otherRoots = new Set(live.filter(a => a.agentId !== agentId).map(a => deps.supervisor.resourceProcessPid(a.agentId)).filter((p): p is number => p !== null));
            const sample = await sampler.sample(agentId, record.state === "running" ? rootPid : null, otherRoots, record.spec.runtime === "terminal", key);
            // A stop/relaunch during ps must not resurrect ended workers or attribute the next run.
            const current = deps.supervisor.status(agentId);
            if (`${current.state}:${deps.supervisor.resourceProcessPid(agentId)}:${current.attempts.at(-1)?.startedAt ?? current.createdAt}` !== key) {
              sampler.forget(agentId); return unavailableSample(agentId, now(), "no_process");
            }
            if (sample.reason === "sampling" || sample.reason === "permission") {
              const last = old?.key === key ? await old.promise : null;
              if (last?.state === "ok" || last?.state === "stale") return { ...last, state: "stale" as const, reason: sample.reason };
            }
            return sample;
          })();
          entry = { at: now(), key, promise };
          this.cache.delete(agentId); this.cache.set(agentId, entry);
          if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
        }
        return { sample: await entry.promise, admission: deps.admission() };
      },
    };
  }
  private visible(caller: string, target: string): boolean {
    const seen = new Set<string>();
    let id: string | null | undefined = target;
    while (id && !seen.has(id)) {
      if (id === caller) return true;
      seen.add(id);
      try { id = this.deps.supervisor.status(id).parentId; } catch { return false; }
    }
    return false;
  }
}
