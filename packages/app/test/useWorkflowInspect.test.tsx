import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { InspectState } from "../src/state/useWorkflowInspect";
import type { ShadowWorkflowInspectResponse } from "@chimera/protocol/contract";

// SHADOW-WORKFLOW-VISIBILITY (cockpit): the polling hook behind AgentWorkflowInspect. It rounds a
// shadow.workflowInspect call through the Tauri bridge, re-polls on an interval, re-subscribes when
// the selected shadow or drilled-into inner agent changes, and holds the last good data across a
// transient RPC error. These tests mock the bridge and drive the interval with fake timers.

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(),
}));

import { rpcCall } from "../src/rpc/bridge";
import { useWorkflowInspect } from "../src/state/useWorkflowInspect";

const mockRpc = vi.mocked(rpcCall);

const resp = (over: Partial<ShadowWorkflowInspectResponse> = {}): ShadowWorkflowInspectResponse => ({
  available: true, reason: null, runId: "run-1", transcriptDir: "/d",
  agents: [], narratorLines: [], transcript: null, ...over,
});

// Capture the hook's latest return on every render so assertions read state without parsing a frame.
let captured: InspectState;
function Probe({ agentId, innerAgentId, intervalMs }: { agentId: string; innerAgentId: string | null; intervalMs?: number }) {
  captured = useWorkflowInspect(agentId, innerAgentId, intervalMs);
  return null;
}

beforeEach(() => { mockRpc.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe("useWorkflowInspect (cockpit)", () => {
  it("does not overlap polls while the daemon is slow", async () => {
    mockRpc.mockReturnValue(new Promise(() => {}));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} intervalMs={100} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it("clears the prior workflow and ignores its late response after switching targets", async () => {
    mockRpc.mockResolvedValueOnce(resp({ runId: "old" }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} intervalMs={100} />); });
    let finishOld!: (v: ShadowWorkflowInspectResponse) => void;
    mockRpc.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    mockRpc.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { renderer.update(<Probe agentId="w2" innerAgentId={null} intervalMs={100} />); });
    expect(captured).toMatchObject({ data: null, error: null, loading: true });
    await act(async () => { finishOld(resp({ runId: "late-old" })); });
    expect(captured.data).toBeNull();
    act(() => renderer.unmount());
  });
  it("starts loading, then lands the first poll's data and clears loading", async () => {
    // Hold the first poll open (a resolved mock would settle inside the mount `act`, hiding the
    // loading window) so the pre-resolution state is observable, then release it.
    let resolveRpc!: (v: ShadowWorkflowInspectResponse) => void;
    mockRpc.mockReturnValue(new Promise<ShadowWorkflowInspectResponse>((r) => { resolveRpc = r; }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} />); });
    // the first poll is still in flight — the hook is in its loading state with no data yet
    expect(captured.loading).toBe(true);
    expect(captured.data).toBeNull();
    await act(async () => { resolveRpc(resp({ runId: "run-A" })); await Promise.resolve(); });
    expect(captured.loading).toBe(false);
    expect(captured.data?.runId).toBe("run-A");
    expect(captured.error).toBeNull();
    act(() => { renderer.unmount(); });
  });

  it("omits innerAgentId from the RPC params when none is drilled into", async () => {
    mockRpc.mockResolvedValue(resp());
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} />); });
    await flush();
    expect(mockRpc).toHaveBeenCalledWith("shadow.workflowInspect", { agentId: "w1" });
    act(() => { renderer.unmount(); });
  });

  it("folds a drilled-into innerAgentId into the same RPC call", async () => {
    mockRpc.mockResolvedValue(resp());
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId="inner-9" />); });
    await flush();
    expect(mockRpc).toHaveBeenCalledWith("shadow.workflowInspect", { agentId: "w1", innerAgentId: "inner-9" });
    act(() => { renderer.unmount(); });
  });

  it("re-polls on the interval", async () => {
    mockRpc.mockResolvedValue(resp());
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} intervalMs={2500} />); });
    await flush();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mockRpc).toHaveBeenCalledTimes(3);
    act(() => { renderer.unmount(); });
  });

  it("re-subscribes (re-polls with the new target) when the selected shadow changes", async () => {
    mockRpc.mockResolvedValue(resp());
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} />); });
    await flush();
    await act(async () => { renderer.update(<Probe agentId="w2" innerAgentId={null} />); });
    await flush();
    expect(mockRpc).toHaveBeenCalledWith("shadow.workflowInspect", { agentId: "w2" });
    act(() => { renderer.unmount(); });
  });

  it("re-subscribes when the drilled-into inner agent changes", async () => {
    mockRpc.mockResolvedValue(resp());
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} />); });
    await flush();
    await act(async () => { renderer.update(<Probe agentId="w1" innerAgentId="inner-1" />); });
    await flush();
    expect(mockRpc).toHaveBeenCalledWith("shadow.workflowInspect", { agentId: "w1", innerAgentId: "inner-1" });
    act(() => { renderer.unmount(); });
  });

  it("holds the last good data when a later poll errors, surfacing the error alongside it", async () => {
    mockRpc.mockResolvedValueOnce(resp({ runId: "good" }));
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(<Probe agentId="w1" innerAgentId={null} intervalMs={2500} />); });
    await flush();
    expect(captured.data?.runId).toBe("good");
    mockRpc.mockRejectedValueOnce(new Error("rpc boom"));
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(captured.data?.runId).toBe("good"); // last good roster retained
    expect(captured.error).toBe("rpc boom");
    act(() => { renderer.unmount(); });
  });
});
