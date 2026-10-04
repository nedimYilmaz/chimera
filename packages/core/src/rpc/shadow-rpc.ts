// SHADOW-WORKFLOW-VISIBILITY: shadow.workflowInspect RPC family. UI-only + LOCAL-ONLY by
// construction (absent from PEER_METHODS) — the inner-agent transcripts it reads are on THIS
// host's disk, so a peer has no path to them anyway. Mirrors health-rpc.ts's shape.
import type { ContractHandlers, ShadowWorkflowInspectResponse } from "@chimera/protocol/contract";
import type { AgentSupervisor } from "../supervisor.js";
import { inspectWorkflowDir } from "./workflow-inspect.js";

export type ShadowRpcHandlers = Pick<ContractHandlers, "shadow.workflowInspect">;

export class ShadowRpc {
  readonly handlers: ShadowRpcHandlers;

  constructor(private readonly deps: { supervisor: AgentSupervisor }) {
    this.handlers = {
      "shadow.workflowInspect": (p) => this.inspect(p.agentId, p.innerAgentId, p.tailLines),
    };
  }

  private async inspect(
    agentId: string,
    innerAgentId: string | undefined,
    tailLines: number | undefined,
  ): Promise<ShadowWorkflowInspectResponse> {
    // Every unavailable branch keeps today's degrade contract: available:false + a one-line
    // human reason, so the UI can fall back to the old placeholder plus that reason.
    const unavailable = (reason: string, transcriptDir: string | null = null, runId: string | null = null): ShadowWorkflowInspectResponse => ({
      available: false, reason, runId, transcriptDir, agents: [], narratorLines: [], transcript: null,
    });

    const shadow = this.deps.supervisor.getShadow(agentId);
    if (!shadow) return unavailable("not a known shadow row");
    if (!shadow.shadowInfo?.workflowName) return unavailable("this shadow is a native sub-agent, not a workflow");
    const runId = shadow.workflowRunId ?? null;
    const dir = shadow.workflowTranscriptDir;
    if (!dir) {
      return unavailable(
        "the workflow's transcript location has not been reported yet — it arrives with the Workflow tool result",
        null,
        runId,
      );
    }

    try {
      const { agents, transcript } = await inspectWorkflowDir(dir, { innerAgentId, tailLines });
      return {
        available: true,
        reason: null,
        runId,
        transcriptDir: dir,
        // phase is reserved (not persisted on disk) — always null in v1; the parser omits it.
        agents: agents.map((a) => ({ ...a, phase: null })),
        narratorLines: [],
        transcript,
      };
    } catch (e) {
      // The dir was reported but is gone/unreadable (workflow cleaned up, or a stale path).
      return unavailable(
        `workflow transcript unavailable: ${e instanceof Error ? e.message : String(e)}`,
        dir,
        runId,
      );
    }
  }
}
