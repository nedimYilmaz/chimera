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
const tailPending = vi.hoisted(() => new Map<string, () => Promise<unknown[]>>());
const tailErrors = vi.hoisted(() => new Map<string, Error>());
const tailCalls = vi.hoisted(() => [] as string[]);

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "agent.tail" && params && typeof params["agentId"] === "string") {
      tailCalls.push(params["agentId"]);
      if (tailPending.has(params["agentId"])) return tailPending.get(params["agentId"])!();
      if (tailErrors.has(params["agentId"])) throw tailErrors.get(params["agentId"]);
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

const DECOY = { agentId: "selected-decoy", state: "done" as const, accountName: "acct-decoy", provider: "claude", costUsd: 0, createdAt: 0 };

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
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({
      type: "agentRecords",
      records: [{ agentId: "selected-decoy", state: "done", accountName: "acct-decoy", provider: "claude", costUsd: 0, createdAt: 0 }],
    });
  });

  it("backfills a lane whose agent is not the selection, replacing 'no transcript yet'", async () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [DECOY, { agentId: "lb-agent-1", state: "done", accountName: "acct-a", provider: "claude", costUsd: 0, createdAt: 1 }],
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
      records: [DECOY, { agentId: "lb-agent-2", state: "running", accountName: "acct-b", provider: "claude", costUsd: 0, createdAt: 2 }],
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
        records: [DECOY, { agentId: "lb-agent-2", state: "running", accountName: "acct-b", provider: "claude", costUsd: 0.01, createdAt: 2 }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(tailCalls.filter((id) => id === "lb-agent-2")).toHaveLength(1);
  });

  it("does not backfill an agent whose history is already loaded or has content", async () => {
    appStore.dispatch({
      type: "agentRecords",
      records: [DECOY, { agentId: "lb-agent-3", state: "done", accountName: "acct-c", provider: "claude", costUsd: 0, createdAt: 3 }],
    });
    appStore.dispatch({ type: "liveboardLaneAdd", agentId: "lb-agent-3" });
    appStore.dispatch({ type: "backfillHistory", agentId: "lb-agent-3", events: [] });

    await renderBoard();

    expect(tailCalls).not.toContain("lb-agent-3");
  });
});


describe("Liveboard failed initial history", () => {
  it("shows a retryable error rather than a successful empty transcript", async () => {
    if (liveRenderer) { act(() => liveRenderer!.unmount()); liveRenderer = null; }
    for (const lane of appStore.getState().liveboardLanes) appStore.dispatch({ type: "liveboardLaneRemove", agentId: lane.agentId });
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "agentRecords", records: [DECOY, { agentId: "lb-error", state: "done", accountName: "acct-a", provider: "claude", costUsd: 0, createdAt: 10 }] });
    appStore.dispatch({ type: "liveboardLaneAdd", agentId: "lb-error" });
    tailErrors.set("lb-error", new Error("fixture offline"));
    const renderer = await renderBoard();
    expect(JSON.stringify(renderer.toJSON())).toContain("couldn't load transcript");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("no transcript yet");
    tailErrors.delete("lb-error");
    tailByAgent.set("lb-error", [ev(100, "message_complete", "lb-error", 100, { text: "recovered history" })]);
    const retry = renderer.root.findAllByType("button").find(b => b.props["data-load-retry"] !== undefined)!;
    await act(async () => { retry.props.onClick(); await Promise.resolve(); await Promise.resolve(); });
    expect(JSON.stringify(renderer.toJSON())).toContain("recovered history");
    act(() => renderer.unmount()); liveRenderer = null;
  });
});


it("invalidates pre-disconnect replies, dedups retry and keeps selection through batched reconnect", async () => {
  if (liveRenderer) { act(() => liveRenderer!.unmount()); liveRenderer = null; }
  for (const lane of appStore.getState().liveboardLanes) appStore.dispatch({ type: "liveboardLaneRemove", agentId: lane.agentId });
  appStore.dispatch({ type: "connected", connected: true });
  appStore.dispatch({ type: "agentRecords", records: [DECOY, { agentId: "lb-late", state: "done", accountName: "acct-a", provider: "claude", costUsd: 0, createdAt: 11 }] });
  appStore.dispatch({ type: "liveboardLaneAdd", agentId: "lb-late" });
  const pending: ((events: unknown[]) => void)[] = [];
  tailPending.set("lb-late", () => new Promise(resolve => pending.push(resolve)));
  const selected = appStore.getState().selectedAgentId;
  const renderer = await renderBoard();
  expect(pending).toHaveLength(1);
  expect(JSON.stringify(renderer.toJSON())).toContain("loading ");
  await act(async () => {
    appStore.dispatch({ type: "connected", connected: false });
    appStore.dispatch({ type: "connected", connected: true });
  });
  expect(pending).toHaveLength(2);
  const retry = renderer.root.findAllByType("button").find(b => b.props["data-load-retry"] !== undefined)!;
  await act(async () => { retry.props.onClick(); retry.props.onClick(); });
  expect(pending).toHaveLength(2);
  await act(async () => { pending[1]!([ev(200, "message_complete", "lb-late", 200, { text: "current transcript" })]); });
  await act(async () => { pending[0]!([ev(100, "message_complete", "lb-late", 100, { text: "obsolete transcript" })]); });
  expect(JSON.stringify(renderer.toJSON())).toContain("current transcript");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("obsolete transcript");
  expect(appStore.getState().selectedAgentId).toBe(selected);
  await act(async () => { appStore.dispatch({ type: "connected", connected: false }); });
  expect(JSON.stringify(renderer.toJSON())).toContain("current transcript");
  expect(JSON.stringify(renderer.toJSON())).toContain("showing last loaded transcript");
  act(() => renderer.unmount()); liveRenderer = null;
  tailPending.delete("lb-late");
});
