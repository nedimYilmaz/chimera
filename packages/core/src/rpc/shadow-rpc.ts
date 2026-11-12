// SHADOW-WORKFLOW-VISIBILITY: shadow.workflowInspect RPC family. UI-only + LOCAL-ONLY by
// construction (absent from PEER_METHODS) — the inner-agent transcripts it reads are on THIS
// host's disk, so a peer has no path to them anyway. Mirrors health-rpc.ts's shape.
import type { ContractHandlers, ShadowWorkflowInspectResponse } from "@chimera/protocol/contract";
import type { AgentSupervisor } from "../supervisor.js";
import { inspectWorkflowDir } from "./workflow-inspect.js";
import { inspectSubagentFile, locateShadowTranscript } from "./shadow-transcript.js";
import { parseWorkflowSnapshot } from "./workflow-snapshot.js";

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
    // human reason, so an empty inspector explains which data is missing.
    const unavailable = (reason: string, transcriptDir: string | null = null, runId: string | null = null): ShadowWorkflowInspectResponse => ({
      available: false, reason, runId, transcriptDir, agents: [], narratorLines: [], transcript: null,
    });

    const shadow = this.deps.supervisor.getShadow(agentId);
    if (!shadow) return unavailable("not a known shadow row");
    if (shadow.shadowTranscriptContext?.skipTranscript) return unavailable("this task has transcript capture disabled by Claude");
    const runId = shadow.workflowRunId ?? null;
    const live = shadow.shadowWorkflowProgress ? parseWorkflowSnapshot({
      taskId: shadow.shadowTranscriptContext?.taskId ?? agentId, runId: shadow.workflowRunId ?? "",
      workflowName: shadow.shadowInfo?.workflowName ?? shadow.label,
      workflowProgress: shadow.shadowWorkflowProgress, status: shadow.state,
      durationMs: shadow.shadowInfo?.durationMs, totalTokens: shadow.shadowInfo?.totalTokens,
      totalToolCalls: shadow.shadowInfo?.toolUses,
    }) : null;
    const located = shadow.shadowTranscriptContext ? await locateShadowTranscript(shadow.shadowTranscriptContext, live?.agents.map(a => a.agentId)) : null;
    if (located?.source === "subagent") {
      try {
        const result = await inspectSubagentFile(located.path, tailLines);
        return this.redact({ available: true, reason: null, source: "subagent", runId, transcriptDir: null,
          agents: [], narratorLines: [], ...result });
      } catch { return unavailable("the sub-agent transcript is not readable yet; activity will refresh automatically"); }
    }
    const dir = shadow.workflowTranscriptDir ?? (located?.source === "workflow" ? located.path : undefined);
    const snapshot = shadow.state === "running" && live ? live : located?.snapshot ?? live;
    if (!dir && snapshot) return this.redact({ available: true, reason: null, source: "workflow", runId,
      transcriptDir: null, agents: snapshot.agents, workflow: snapshot.workflow, narratorLines: snapshot.narratorLines,
      transcript: innerAgentId ? [] : null });
    if (!dir) {
      return unavailable(
        shadow.shadowInfo?.workflowName
          ? "the workflow's transcript location has not been reported yet; waiting for session logs or the Workflow tool result"
          : "the sub-agent transcript has not been found in its spawning Claude session yet; activity will refresh automatically",
        null,
        runId,
      );
    }

    try {
      const { agents, transcript, activity } = await inspectWorkflowDir(dir, { innerAgentId, tailLines }).catch(e => {
        if (!snapshot) throw e;
        return { agents: [], transcript: innerAgentId ? [] : null, activity: undefined };
      });
      const rows = new Map(agents.map(a => [a.agentId, { ...a, phase: null } as ShadowWorkflowInspectResponse["agents"][number]]));
      for (const a of snapshot?.agents ?? []) rows.set(a.agentId, { ...rows.get(a.agentId), ...a });
      return this.redact({
        source: "workflow",
        ...(activity ? { activity } : {}),
        available: true,
        reason: null,
        runId: snapshot?.runId ?? runId,
        transcriptDir: dir,
        agents: [...rows.values()],
        ...(snapshot ? { workflow: snapshot.workflow } : {}),
        narratorLines: snapshot?.narratorLines ?? [],
        transcript,
      });
    } catch (e) {
      // The dir was reported but is gone/unreadable (workflow cleaned up, or a stale path).
      return unavailable(
        `workflow transcript unavailable: ${e instanceof Error ? e.message : String(e)}`,
        dir,
        runId,
      );
    }
  }

  private redact(result: ShadowWorkflowInspectResponse): ShadowWorkflowInspectResponse {
    // Disk transcripts have not passed through the event log's credential scrubber.
    const scrub = (value: any): any => typeof value === "string" ? this.deps.supervisor.redactForPeer(value)
      : Array.isArray(value) ? value.map(scrub)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;
    return scrub(result);
  }
}
