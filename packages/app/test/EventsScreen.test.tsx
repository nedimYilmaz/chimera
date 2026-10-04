import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { ChronicleSearchResponse, NormalizedEvent } from "@chimera/protocol";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

type RpcCallRecord = { method: string; params: unknown };
const calls: RpcCallRecord[] = [];
let replayImpl: (params: Record<string, unknown>) => Promise<NormalizedEvent[]> = async () => [];
let searchImpl: (params: Record<string, unknown>) => Promise<ChronicleSearchResponse> = async () => ({
  hits: [], nextCursor: null, retained: { firstSeq: null, lastSeq: null },
});

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  calls.push({ method, params });
  if (method === "events.replay") return replayImpl((params ?? {}) as Record<string, unknown>);
  if (method === "events.search") return searchImpl((params ?? {}) as Record<string, unknown>);
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { EventsScreen, OLDER_PAGE } from "../src/screens/EventsScreen";
import { appStore } from "../src/state/store";
import { registerActionHandler } from "../src/keymap";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

// EventsScreen refs (bodyRef) just need scrollTop/scrollHeight/clientHeight readable/
// writable plus the no-op DOM methods it calls (querySelector/scrollIntoView/
// addEventListener) — one shared mutable mock stands in for every host ref.
let bodyMock: { scrollTop: number; scrollHeight: number; clientHeight: number };
const createNodeMock = () => ({
  ...bodyMock,
  querySelector: () => null,
  scrollIntoView: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
});

const seedEvent = (seq: number, agentId = "seed-agent"): NormalizedEvent =>
  ({ ts: 1_000_000 + seq, seq, agentId, kind: "status", data: { note: `seq-${seq}` } });

const emptyCorrelation = {
  taskId: null, workflow: null, stepId: null, toolId: null,
  artifactId: null, traceId: null, spanId: null, parentAgentId: null,
};

let mounted: ReturnType<typeof create> | null = null;

beforeEach(() => {
  rpcImpl.mockClear();
  calls.length = 0;
  replayImpl = async () => [];
  searchImpl = async () => ({ hits: [], nextCursor: null, retained: { firstSeq: null, lastSeq: null } });
  bodyMock = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

// FEATURE (Events tab lazy-loads recent past events on connect): appStore is a
// real module-level singleton (no reset hook, same discipline as
// InboxScreen.test.tsx) — the first two tests below rely on appStore.getState()
// .events still being empty, so nothing in this file may dispatch a plain
// "event" action before them. Only the last two tests (search / already-
// populated) ever feed appStore.events, and they run last for exactly that
// reason.
describe("EventsScreen initial backfill", () => {
  it("backfills the most-recent events on connect when the live ring is empty", async () => {
    expect(appStore.getState().events).toEqual([]);
    act(() => { appStore.dispatch({ type: "connected", connected: true }); });

    const tail = [seedEvent(101), seedEvent(102), seedEvent(103)];
    replayImpl = async (params) => {
      expect(params).toEqual({ limit: OLDER_PAGE });
      return tail;
    };

    act(() => { mounted = create(React.createElement(EventsScreen), { createNodeMock }); });
    await flush();
    await flush();

    const replayCalls = calls.filter((c) => c.method === "events.replay");
    expect(replayCalls).toHaveLength(1);
    expect(replayCalls[0]!.params).toEqual({ limit: OLDER_PAGE });

    for (const e of tail) {
      expect(mounted!.root.findAll((n) => n.props["data-event-seq"] === e.seq)).toHaveLength(1);
    }
    expect(mounted!.root.findAll((n) => n.props["children"] === "no events yet")).toHaveLength(0);
  });

  it("scroll-up still pages events older than the seeded tail", async () => {
    // Still empty — the previous test only ever wrote into EventsScreen's own
    // component-local olderRef cache (discarded on unmount), never the shared ring.
    expect(appStore.getState().events).toEqual([]);

    const fullTailPage = Array.from({ length: OLDER_PAGE }, (_, i) => seedEvent(501 + i));
    const olderBatch = [seedEvent(10), seedEvent(11)];
    replayImpl = async (params) => {
      if (params["fromSeq"] === undefined) return fullTailPage; // the initial tail seed
      return olderBatch.filter((e) => e.seq >= (params["fromSeq"] as number));
    };

    act(() => { mounted = create(React.createElement(EventsScreen), { createNodeMock }); });
    await flush();
    await flush();
    expect(calls.filter((c) => c.method === "events.replay")).toHaveLength(1);

    const body = mounted!.root.find((n) => n.props["data-events-body"] !== undefined);
    bodyMock.scrollTop = 0; // <=24 triggers fetchOlder inside onScroll
    act(() => { body.props.onScroll(); });
    await flush();
    await flush();

    const olderCalls = calls.filter((c) => c.method === "events.replay");
    expect(olderCalls).toHaveLength(2);
    // olderPageRequest(oldestSeq=501, OLDER_PAGE=500) -> fromSeq=max(1,1)=1
    expect(olderCalls[1]!.params).toEqual({ fromSeq: 1, limit: OLDER_PAGE });
    expect(mounted!.root.findAll((n) => n.props["data-event-seq"] === 10)).toHaveLength(1);
    expect(mounted!.root.findAll((n) => n.props["data-event-seq"] === 11)).toHaveLength(1);
  });

  it("a failed initial seed is retried after a reconnect", async () => {
    expect(appStore.getState().events).toEqual([]);
    let attempt = 0;
    const tail = [seedEvent(701)];
    replayImpl = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient daemon hiccup");
      return tail;
    };

    // connected is already true (set by the first test, never reset since) —
    // this mount exercises the "on mount, already connected" path first.
    act(() => { mounted = create(React.createElement(EventsScreen), { createNodeMock }); });
    await flush();
    await flush();

    expect(calls.filter((c) => c.method === "events.replay")).toHaveLength(1);
    expect(mounted!.root.findAll((n) => n.props["data-event-seq"] === 701)).toHaveLength(0);

    act(() => { appStore.dispatch({ type: "connected", connected: false }); });
    act(() => { appStore.dispatch({ type: "connected", connected: true }); });
    await flush();
    await flush();

    expect(calls.filter((c) => c.method === "events.replay")).toHaveLength(2);
    expect(mounted!.root.findAll((n) => n.props["data-event-seq"] === 701)).toHaveLength(1);
  });

  it("events.search returns a hit for an event absent from the live ring (and populates the ring for the next test)", async () => {
    const liveEvt = seedEvent(9001, "search-live-agent");
    act(() => { appStore.dispatch({ type: "event", event: liveEvt }); });
    expect(appStore.getState().events.some((e) => e.seq === 42)).toBe(false);

    searchImpl = async (params) => {
      expect(params["query"]).toBe("archived decision");
      return {
        hits: [{
          engineId: "local", seq: 42, ts: 42_000, agentId: "old-agent", kind: "result",
          score: 100, fields: ["transcript"], snippet: "archived decision made here",
          correlation: emptyCorrelation,
        }],
        nextCursor: null, retained: { firstSeq: 1, lastSeq: 9001 },
      };
    };

    act(() => { mounted = create(React.createElement(EventsScreen), { createNodeMock }); });
    await flush();

    const input = mounted!.root.find((n) => n.props["data-events-search"] !== undefined);
    act(() => { input.props.onChange({ target: { value: "archived decision" } }); });
    // SEARCH-STORM: the debounce is sized to what a whole-log scan actually costs (seconds), not
    // to an instant filter — so the wait tracks it rather than a number that used to be 180.
    await wait(700);

    expect(mounted!.root.findAll((n) => n.props["data-event-seq"] === 42)).toHaveLength(1);
  });

  it("does not re-fetch the tail once the live ring already has events (must run after the search test above)", async () => {
    expect(appStore.getState().events.length).toBeGreaterThan(0);
    replayImpl = async () => { throw new Error("should not be called — the ring is already populated"); };

    act(() => { mounted = create(React.createElement(EventsScreen), { createNodeMock }); });
    await flush();
    await flush();

    expect(calls.filter((c) => c.method === "events.replay")).toHaveLength(0);
  });

  it("the row star dispatches events.pin", async () => {
    act(() => { mounted = create(React.createElement(EventsScreen), { createNodeMock }); });
    await flush();

    const handler = vi.fn();
    const dispose = registerActionHandler("events.pin", handler);
    const star = mounted!.root.findByProps({ "data-event-action": "events.pin" });
    act(() => star.props.onClick({ stopPropagation: vi.fn() }));

    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
  });
});
