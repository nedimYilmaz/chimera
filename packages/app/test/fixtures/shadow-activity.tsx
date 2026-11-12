import React, { useState } from "react";
import type { AgentView } from "@chimera/ui-state";
import { AgentShadowPane } from "../../src/components/AgentShadowPane";

export const shadowFixture = { active: false, completed: false, fail: false };
const row = (agentId: string, label: string, phaseIndex: number, state: string) => ({ agentId, label, phaseIndex, phase: phaseIndex === 1 ? "Context" : "Review", state,
  agentType: null, model: "Opus 5.5", resultPreview: null, lastActivityTs: Date.now(), spawnDepth: 1,
  tokens: 55600, durationMs: 16000, toolCalls: 4, lastToolName: "Read", lastToolSummary: "Checking staged changes" });
export function shadowRpc(params: Record<string, unknown>) {
  if (shadowFixture.fail) throw new Error("synthetic connection loss");
  const native = params.agentId === "shadow:owner:native";
  return { available: true, reason: null, source: native ? "subagent" : "workflow", runId: null, transcriptDir: null,
    agents: native ? [] : [row("pre", "pre-gather", 1, "done"), row("judge", "context (judgment)", 1, shadowFixture.completed ? "done" : "running"), row("review", "security-review", 2, "pending")],
    ...(native ? {} : { workflow: { name: "ai-review-staged", status: "running", phases: [{ index: 1, title: "Context", detail: null }, { index: 2, title: "Review", detail: null }], totalTokens: 147300, durationMs: 16000, totalToolCalls: 8 } }),
    narratorLines: [], transcript: native || params.innerAgentId ? [{ role: "tool", text: native ? "Bash: npm test — native task output" : `Read: ${params.innerAgentId} private output`, ts: Date.now() }] : null,
    activity: { lastTool: "Read", lastActivityTs: Date.now(), truncated: false, steps: [{ title: "Inspect staged changes", status: "in_progress" }] },
  };
}
export function ShadowActivityProbe() {
  const [native, setNative] = useState(false);
  const agent = { agentId: native ? "shadow:owner:native" : "shadow:owner:workflow", state: "running", shadow: true,
    label: native ? "general-purpose" : "ai-review-staged", transcript: [], tools: [], lastEventTs: Date.now(), costUsd: 0,
    pendingQuestion: null, conductor: false } as AgentView;
  return <div style={{ display: "flex", flexDirection: "column", height: "100vh", minWidth: 0 }} data-shadow-probe>
    <div><button onClick={() => setNative(!native)}>Switch shadow</button>
      <button onClick={() => { shadowFixture.completed = true; }}>Complete phase</button>
      <button onClick={() => { shadowFixture.fail = !shadowFixture.fail; }}>Toggle failure</button></div>
    <AgentShadowPane key={agent.agentId} agent={agent} />
  </div>;
}
