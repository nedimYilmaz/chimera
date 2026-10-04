// FEATURE-11: artifact.* RPC family (D13, artifact registry), extracted verbatim out of
// engine.ts's old inline `switch` case bodies into its own ContractHandlers slice. Local-only
// by construction (absent from PEER_METHODS): a peer never sees or drives our artifact
// registry — unchanged by this extraction.
import type { ContractHandlers } from "@chimera/protocol/contract";
import type { ArtifactStore } from "../artifacts.js";
import type { QueueScheduler } from "../scheduler.js";
import type { QueueStore } from "../queues.js";
import { isAbsolute, resolve } from "node:path";

export type ArtifactRpcHandlers = Pick<ContractHandlers, "artifact.add" | "artifact.list" | "artifact.get">;

export class ArtifactRpc {
  readonly handlers: ArtifactRpcHandlers;

  constructor(private readonly deps: { artifacts: ArtifactStore; scheduler: QueueScheduler; queues: QueueStore; agentWorkdir: (agentId: string) => string }) {
    this.handlers = {
      "artifact.add": (p) => {
        const agentId = p.agentId ?? null;
        const taskId = agentId ? this.deps.scheduler.taskFor(agentId) : null;
        // F16.1 Phase 2 (WF-4/G5): stamp the caller's CURRENT step cursor server-side
        // (never client-supplied) — backs the artifact gate's scope:"step" pin.
        const stepIndex = taskId ? this.deps.queues.getTask(taskId).stepIndex : undefined;
        // The daemon's cwd is unrelated to the worker's checkout. A relative report
        // belongs to the caller's actual worktree, just like its file tools.
        const path = p.kind !== "link" && p.path && !isAbsolute(p.path) && agentId
          ? resolve(this.deps.agentWorkdir(agentId), p.path) : p.path;
        return this.deps.artifacts.add({ kind: p.kind, path, url: p.url, label: p.label, agentId, taskId, stepIndex });
      },
      "artifact.list": (p) => this.deps.artifacts.list(p),
      "artifact.get": (p) => this.deps.artifacts.get(p.id),
    };
  }
}
