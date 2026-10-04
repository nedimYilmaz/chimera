// R2 (self-healing supervision): health.status / replay.agentsAsOf RPC family, mirroring
// artifact-rpc.ts's shape. Both LOCAL-ONLY by construction (absent from PEER_METHODS) — a peer
// has no business reading our health state or replaying our log.
import { join } from "node:path";
import type { ContractHandlers } from "@chimera/protocol/contract";
import type { AgentSupervisor } from "../supervisor.js";
import type { EventLog } from "../events.js";
import { replayAgentsAsOfFromStateFile } from "../replay.js";

export type HealthRpcHandlers = Pick<ContractHandlers, "health.status" | "replay.agentsAsOf">;

export class HealthRpc {
  readonly handlers: HealthRpcHandlers;

  constructor(private readonly deps: { supervisor: AgentSupervisor; events: EventLog; home: string }) {
    this.handlers = {
      "health.status": () => this.deps.supervisor.list().filter((a) => !a.shadow).map((a) => ({
        agentId: a.agentId, state: a.state, crashCount: a.crashCount ?? 0,
        circuitOpen: a.circuitOpen ?? false, pauseReason: a.pauseReason ?? null,
      })),
      "replay.agentsAsOf": (p) =>
        replayAgentsAsOfFromStateFile(join(this.deps.home, "state.json"), this.deps.events, p.toSeq),
    };
  }
}
