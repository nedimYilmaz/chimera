import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { AgentView } from "@chimera/ui-state";
import type { ShadowWorkflowInspectResponse, WorkflowInnerAgent } from "@chimera/protocol/contract";

// SHADOW-WORKFLOW-VISIBILITY (cockpit): the live inner-agent inspector shown in place of the old
// "no transcript" note for a WORKFLOW shadow. AgentWorkflowInspect drives itself off the polling
// useWorkflowInspect hook, which round-trips shadow.workflowInspect through the Tauri bridge — so
// these render tests mock the bridge's rpcCall and let the hook's own poll land the roster /
// transcript, then assert the degrade note, the roster rows + running pill, the empty-roster line
// and the click-to-drill-down transcript.

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(),
}));

import { rpcCall } from "../src/rpc/bridge";
import { AgentWorkflowInspect } from "../src/components/AgentWorkflowInspect";

const mockRpc = vi.mocked(rpcCall);

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function flattenText(node: TreeNode | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(flattenText).join("");
}

const agent = (): AgentView => ({
  agentId: "shadow:parent-1:W1", state: "running", conductor: false, costUsd: 0,
  lastEventTs: 0, transcript: [], tools: [], pendingQuestion: null,
  shadow: true, label: "spec", shadowInfo: { workflowName: "spec" },
} as AgentView);

const inner = (over: Partial<WorkflowInnerAgent>): WorkflowInnerAgent => ({
  agentId: "i-1", agentType: null, label: null, phase: null, state: "done",
  resultPreview: null, lastActivityTs: null, spawnDepth: null, model: null, ...over,
});

const resp = (over: Partial<ShadowWorkflowInspectResponse> = {}): ShadowWorkflowInspectResponse => ({
  available: true, reason: null, runId: "run-42", transcriptDir: "/runs/42",
  agents: [], narratorLines: [], transcript: null, ...over,
});

// Mount + let the hook's initial poll (an already-resolved rpcCall) settle before reading the tree.
async function renderInspect(): Promise<ReturnType<typeof create>> {
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(React.createElement(AgentWorkflowInspect, { agent: agent() })); });
  mounted.push(renderer);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return renderer;
}

const textOf = (r: ReturnType<typeof create>) => flattenText(r.toJSON() as TreeNode);

const mounted: ReturnType<typeof create>[] = [];
beforeEach(() => { mockRpc.mockReset(); });
afterEach(() => { act(() => { for (const renderer of mounted.splice(0)) renderer.unmount(); }); vi.useRealTimers(); });

describe("AgentWorkflowInspect — degrade path", () => {
  it("keeps the historic note and appends the daemon's reason when the workflow is unavailable", async () => {
    mockRpc.mockResolvedValue(resp({ available: false, reason: "workflow transcript dir not reported yet", runId: null, transcriptDir: null }));
    const r = await renderInspect();
    const text = textOf(r);
    expect(text).toContain("read on"); // the historic on-demand note is preserved
    expect(text).toContain("workflow transcript dir not reported yet"); // concrete reason surfaced
  });

  it("shows a loading reason before the first poll resolves", () => {
    mockRpc.mockReturnValue(new Promise(() => {})); // never resolves — stays in the initial loading state
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(AgentWorkflowInspect, { agent: agent() })); });
    expect(textOf(renderer)).toContain("loading workflow activity…");
  });
});

describe("AgentWorkflowInspect — roster", () => {
  it("renders one row per inner agent with its label and type chip", async () => {
    mockRpc.mockResolvedValue(resp({
      agents: [
        inner({ agentId: "a1", label: "gather sources", agentType: "general-purpose", state: "done", resultPreview: "found 3 files" }),
        inner({ agentId: "a2", label: "write draft", agentType: "writer", state: "running" }),
      ],
    }));
    const r = await renderInspect();
    const text = textOf(r);
    expect(text).toContain("gather sources");
    expect(text).toContain("write draft");
    expect(text).toContain("general-purpose");
    expect(text).toContain("found 3 files"); // result preview for a done agent
  });

  it("summarises the roster size and shows a running pill when at least one inner agent is live", async () => {
    mockRpc.mockResolvedValue(resp({
      agents: [inner({ agentId: "a1", state: "running" }), inner({ agentId: "a2", state: "done" })],
    }));
    const text = textOf(await renderInspect());
    expect(text).toContain("2 inner agents");
    expect(text).toContain("1 running");
  });

  it("renders the empty-roster note when the workflow is available but no inner agents have started", async () => {
    mockRpc.mockResolvedValue(resp({ agents: [] }));
    const text = textOf(await renderInspect());
    expect(text).toContain("no inner agents have started yet.");
  });

  it("shows the run id when the daemon reports one", async () => {
    mockRpc.mockResolvedValue(resp({ runId: "run-42", agents: [inner({ agentId: "a1" })] }));
    expect(textOf(await renderInspect())).toContain("run-42");
  });
});

describe("AgentWorkflowInspect — drill-down transcript", () => {
  it("does not send the previous workflow's inner-agent selection to a new workflow", async () => {
    mockRpc.mockResolvedValue(resp({ agents: [inner({ agentId: "a1" })] }));
    const r = await renderInspect();
    await act(async () => { r.root.findAllByType("button").find((b) => b.props.title === "drill into a1")!.props.onClick(); });
    mockRpc.mockClear();
    await act(async () => { r.update(<AgentWorkflowInspect agent={{ ...agent(), agentId: "shadow:other" }} />); });
    expect(mockRpc).toHaveBeenCalledWith("shadow.workflowInspect", { agentId: "shadow:other" });
    expect(mockRpc.mock.calls.some(([, params]) => (params as { innerAgentId?: string }).innerAgentId)).toBe(false);
  });
  it("polls the selected inner agent and renders its transcript tail after a row click", async () => {
    // The roster poll carries no transcript; a poll WITH innerAgentId carries the drilled-into
    // agent's transcript tail (the hook folds innerAgentId into the same call).
    mockRpc.mockImplementation(async (_method: string, params: unknown) => {
      const p = params as { innerAgentId?: string };
      const base = resp({ agents: [inner({ agentId: "a1", label: "gather sources", state: "running" })] });
      if (p.innerAgentId === "a1") {
        return { ...base, transcript: [
          { role: "user", text: "collect the sources", ts: null },
          { role: "assistant", text: "collected 3 files", ts: null },
        ] } satisfies ShadowWorkflowInspectResponse;
      }
      return base;
    });
    const r = await renderInspect();
    // Before drilling in, the hint prompts for a selection.
    expect(textOf(r)).toContain("select an inner agent to view its transcript");

    const button = (r.root.findAllByType("button")).find((b) => (b.props.title as string)?.includes("a1"))!;
    await act(async () => { (button.props.onClick as () => void)(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const text = textOf(r);
    expect(text).toContain("collect the sources");
    expect(text).toContain("collected 3 files");
    expect(mockRpc).toHaveBeenCalledWith("shadow.workflowInspect", expect.objectContaining({ innerAgentId: "a1" }));
  });
});
