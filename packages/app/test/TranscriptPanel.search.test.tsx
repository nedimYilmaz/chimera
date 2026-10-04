import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// TRANSCRIPT-WINDOWING (part C) — proof that a search hit whose seq is NOT
// currently resident (older than agent.historyMinSeq — never loaded, or
// already evicted from the window) is still REACHABLE: clicking it walks
// loadNextOlderHistoryPage backward (the same on-demand page loader scroll
// uses) until the hit's seq is folded into the transcript, then forces the
// window fully open (forceExpandKey) and scrolls the nearest block into view.
// A search that finds something you cannot navigate to is worse than no
// search — this is the round trip that makes it not that.

const tail = vi.hoisted(() => new Map<string, unknown[]>());
const replayCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const searchCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const searchHitsToReturn = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "events.replay") {
      replayCalls.push(params ?? {});
      const { agentId, toSeq, limit } = params as { agentId: string; toSeq?: number; limit: number };
      let events = (tail.get(agentId) ?? []) as { seq: number }[];
      if (toSeq !== undefined) events = events.filter((e) => e.seq <= toSeq);
      return events.slice(-limit);
    }
    if (method === "events.search") {
      searchCalls.push(params ?? {});
      return { hits: searchHitsToReturn.current, nextCursor: null, retained: { firstSeq: null, lastSeq: null } };
    }
    return {};
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

class FakeResizeObserver {
  constructor(_cb: () => void) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  };
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

import { TranscriptPanel } from "../src/components/TranscriptPanel";
import { appStore } from "../src/state/store";

function historyEvent(agentId: string, seq: number, text: string) {
  return { seq, ts: 1000 + seq, engineId: "local", agentId, kind: "message_complete", data: { text } };
}

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) { if (typeof c !== "string") findAll(c, pred, out); }
  return out;
}
function textOf(node: TreeNode): string {
  const parts: string[] = [];
  for (const c of node.children ?? []) parts.push(typeof c === "string" ? c : textOf(c));
  return parts.join("");
}

const scrollIntoViewCalls: unknown[] = [];
const bodyEl = {
  scrollTop: 0, scrollHeight: 0, clientHeight: 0,
  addEventListener() {}, removeEventListener() {},
  // jumpToHit queries "[data-block]" and reads .textContent/.getAttribute("data-ts")
  // — real DOM elements support both natively; this bridges the same contract
  // onto react-test-renderer's JSON tree (no real DOM in this harness).
  querySelectorAll(selector: string) {
    if (selector !== "[data-block]" || !renderer) return [];
    const tree = renderer.toJSON() as TreeNode;
    return findAll(tree, (n) => n.props["data-block"] !== undefined).map((n) => ({
      textContent: textOf(n),
      getAttribute: (name: string) => (name === "data-ts" && n.props["data-ts"] !== undefined ? String(n.props["data-ts"]) : null),
      scrollIntoView: (opts?: unknown) => { scrollIntoViewCalls.push({ text: textOf(n), opts }); },
    }));
  },
};
function resetBodyEl(clientHeight: number, scrollHeight: number, scrollTop: number): void {
  bodyEl.clientHeight = clientHeight;
  bodyEl.scrollHeight = scrollHeight;
  bodyEl.scrollTop = scrollTop;
}
const createNodeMock = (element: { props?: Record<string, unknown> }) =>
  element.props?.["data-transcript-body"] !== undefined ? bodyEl : {};

let renderer: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  resetBodyEl(0, 0, 0);
  replayCalls.length = 0;
  searchCalls.length = 0;
  scrollIntoViewCalls.length = 0;
});

function soloAgent(agentId: string): void {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId, state: "done", accountName: "acct", provider: "claude", costUsd: 0, createdAt: 1 }],
  });
}
function mountAgent(agentId: string): void {
  act(() => {
    renderer = create(React.createElement(TranscriptPanel, { agent: appStore.getState().agents[agentId] }), { createNodeMock });
  });
}
function findByAttr(attr: string): TreeNode | undefined {
  const tree = renderer!.toJSON() as TreeNode;
  return findAll(tree, (n) => n.props[attr] !== undefined)[0];
}
async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
// TranscriptSearchBar debounces its RPC by 180ms (mirrors EventsScreen's own
// runSearch debounce) — real timers, so this must actually wait that long.
async function flushDebounce(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
}

const TOTAL = 1001; // seq 1..1001

describe("TranscriptPanel — TRANSCRIPT-WINDOWING (part C): search reaches non-resident history", () => {
  it("a hit older than anything resident triggers a backward walk, then expands + scrolls to it", async () => {
    const agentId = "search-1";
    // NOTE: tail.set() must precede soloAgent() — the shared appStore
    // singleton (imported from state/store.ts) already has its OWN real
    // installHistoryBackfill wired up (store.ts's module-level side effect),
    // which reacts to soloAgent()'s selection-landing SYNCHRONOUSLY and calls
    // the mocked rpcCall's async body synchronously up to its first await —
    // it would read an empty tail if this ran first.
    const full = Array.from({ length: TOTAL }, (_, i) => historyEvent(agentId, i + 1, `turn ${i + 1}`));
    tail.set(agentId, full);
    soloAgent(agentId);
    // simulate the newest page already painted (turns 502..1001) — matches
    // real usage where installHistoryBackfill has already run by the time
    // the operator can even see a search box.
    act(() => {
      appStore.dispatch({ type: "backfillHistory", agentId, events: full.slice(-500) as never });
    });
    resetBodyEl(400, 20000, 20000);
    mountAgent(agentId);

    expect(appStore.getState().agents[agentId]!.historyMinSeq).toBe(502);
    expect(appStore.getState().agents[agentId]!.transcript).toHaveLength(500);

    // open search, type a query, get back a hit for turn 1 (seq 1 — deep
    // before anything resident: 500 turns short of the current historyMinSeq).
    const toggle = findByAttr("data-transcript-search-toggle")!;
    act(() => { (toggle.props["onClick"] as () => void)(); });
    searchHitsToReturn.current = [
      { engineId: "local", seq: 1, ts: 1001, agentId, kind: "message_complete", score: 1, fields: [], snippet: "turn 1", correlation: { taskId: null, workflow: null, stepId: null, toolId: null, artifactId: null, traceId: null, spanId: null, parentAgentId: null } },
    ];
    const input = findByAttr("data-transcript-search")!;
    act(() => { (input.props["onChange"] as (e: { target: { value: string } }) => void)({ target: { value: "turn 1" } }); });
    await flushDebounce(); // debounce timer
    await flush(); // the events.search RPC itself

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!["scope"]).toEqual({ agentIds: [agentId] });

    const hitRow = findByAttr("data-search-hit")!;
    expect(hitRow.props["data-search-hit"]).toBe(1);

    await act(async () => {
      (hitRow.props["onClick"] as () => void)();
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    });

    // walked backward via events.replay until seq 1 was folded in.
    expect(replayCalls.some((c) => c["toSeq"] !== undefined)).toBe(true);
    const a = appStore.getState().agents[agentId]!;
    expect(a.historyMinSeq).toBe(1);
    expect(a.transcript.map((t) => (t as { text: string }).text)).toContain("turn 1");

    // and actually scrolled to it — not just loaded it silently.
    expect(scrollIntoViewCalls.length).toBeGreaterThan(0);
    expect(scrollIntoViewCalls[0]).toMatchObject({ text: expect.stringContaining("turn 1") });
  });

  it("a hit that's already resident scrolls immediately, with no extra events.replay walk", async () => {
    const agentId = "search-2";
    const full = Array.from({ length: 600 }, (_, i) => historyEvent(agentId, i + 1, `turn ${i + 1}`));
    tail.set(agentId, full);
    soloAgent(agentId);
    act(() => {
      appStore.dispatch({ type: "backfillHistory", agentId, events: full.slice(-500) as never }); // turns 101..600
    });
    resetBodyEl(400, 20000, 20000);
    mountAgent(agentId);

    const toggle = findByAttr("data-transcript-search-toggle")!;
    act(() => { (toggle.props["onClick"] as () => void)(); });
    searchHitsToReturn.current = [
      { engineId: "local", seq: 200, ts: 1200, agentId, kind: "message_complete", score: 1, fields: [], snippet: "turn 200", correlation: { taskId: null, workflow: null, stepId: null, toolId: null, artifactId: null, traceId: null, spanId: null, parentAgentId: null } },
    ];
    const input = findByAttr("data-transcript-search")!;
    act(() => { (input.props["onChange"] as (e: { target: { value: string } }) => void)({ target: { value: "turn 200" } }); });
    await flushDebounce();
    await flush();

    const hitRow = findByAttr("data-search-hit")!;
    replayCalls.length = 0; // only count calls made by the CLICK itself
    await act(async () => {
      (hitRow.props["onClick"] as () => void)();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(replayCalls.filter((c) => c["toSeq"] !== undefined)).toHaveLength(0); // already resident — no walk needed
    expect(scrollIntoViewCalls.length).toBeGreaterThan(0);
  });
});
