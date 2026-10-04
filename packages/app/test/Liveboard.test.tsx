import { beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// Without this, react-test-renderer (React 19) can't tell it's inside act() and
// defensively double-commits the initial mount — double-firing this file's
// mount effects before the requested-set guard's dispatch has landed, which
// masked the "at most once" test below with a false failure. Scoped to this
// file only (not global test setup) since it's the one file here asserting an
// exact call count against an effect race.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Liveboard (via its store.ts import) transitively reaches the Tauri rpc/bridge
// module, which fires real listen()/invoke() calls as an import-time DEV side
// effect — same seam TranscriptPanel.test.tsx stubs.
const tailByAgent = vi.hoisted(() => new Map<string, unknown[]>());
const tailCalls = vi.hoisted(() => [] as string[]);

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "agent.tail" && params && typeof params["agentId"] === "string") {
      tailCalls.push(params["agentId"]);
      return tailByAgent.get(params["agentId"]) ?? [];
    }
    return [];
  }),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { Liveboard } from "../src/components/Liveboard";
import { appStore } from "../src/state/store";

// Same NormalizedEvent-fixture convention as TranscriptPanel.test.tsx's `ev`.
function ev(seq: number, kind: string, agentId: string, ts: number, data: Record<string, unknown> = {}) {
  return { seq, ts, engineId: "local", agentId, kind, data };
}

// create() never tears down a prior test's tree — an un-unmounted Liveboard stays
// subscribed to the shared appStore singleton, so a later test's dispatch would
// also re-render it and double-fire its OWN (separate) backfill effect. Unmount
// the previous renderer first so exactly one Liveboard instance is ever live.
let liveRenderer: ReturnType<typeof create> | null = null;
async function renderBoard() {
  if (liveRenderer) act(() => liveRenderer!.unmount());
  await act(async () => {
    liveRenderer = create(React.createElement(Liveboard, { onOpen: () => {} }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return liveRenderer;
}

describe("Liveboard — per-lane history backfill", () => {
  // The reducer auto-selects agentRecords' FIRST-ever record as selectedAgentId
  // (types.ts's `selectedAgentId: state.selectedAgentId ?? order[0] ?? null`),
  // and the module-singleton `installHistoryBackfill` (history.ts) watches
  // ONLY that selection — it would otherwise race Liveboard's own per-lane
  // effect and backfill the test's agent via `events.replay` before the
  // Liveboard effect gets a chance, masking the exact bug under test. Pin the
  // selection to an unrelated decoy agent up front so every lane agent below
  // is provably NOT the selection, matching the real "non-selected lane" bug.
  beforeAll(() => {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId: "selected-decoy", state: "done", accountName: "acct-decoy", provider: "claude", costUsd: 0, createdAt: 0 }],
    });
  });

  it("backfills a lane whose agent is not the selection, replacing 'no transcript yet'", async () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId: "lb-agent-1", state: "done", accountName: "acct-a", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    appStore.dispatch({ type: "liveboardLaneAdd", agentId: "lb-agent-1" });
    tailByAgent.set("lb-agent-1", [
      ev(1, "message_delta", "lb-agent-1", 10, { text: "hello from backfill" }),
      ev(2, "message_complete", "lb-agent-1", 10, { text: "hello from backfill" }),
    ]);

    const renderer = await renderBoard();

    expect(tailCalls).toContain("lb-agent-1");
    const text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain("no transcript yet");
    expect(text).toContain("hello from backfill");
  });

  it("requests agent.tail at most once per agent even across re-renders", async () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId: "lb-agent-2", state: "running", accountName: "acct-b", provider: "claude", costUsd: 0, createdAt: 2 }],
    });
    appStore.dispatch({ type: "liveboardLaneAdd", agentId: "lb-agent-2" });
    tailByAgent.set("lb-agent-2", [ev(1, "message_delta", "lb-agent-2", 10, { text: "hi" })]);

    await renderBoard();
    expect(tailCalls.filter((id) => id === "lb-agent-2")).toHaveLength(1);

    // An unrelated dispatch re-runs the effect's deps (state.agents changes reference);
    // the requested-set guard must still hold.
    await act(async () => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "lb-agent-2", state: "running", accountName: "acct-b", provider: "claude", costUsd: 0.01, createdAt: 2 }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tailCalls.filter((id) => id === "lb-agent-2")).toHaveLength(1);
  });

  it("does not backfill an agent whose history is already loaded or has content", async () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId: "lb-agent-3", state: "done", accountName: "acct-c", provider: "claude", costUsd: 0, createdAt: 3 }],
    });
    appStore.dispatch({ type: "liveboardLaneAdd", agentId: "lb-agent-3" });
    appStore.dispatch({ type: "backfillHistory", agentId: "lb-agent-3", events: [] });

    await renderBoard();

    expect(tailCalls).not.toContain("lb-agent-3");
  });
});
