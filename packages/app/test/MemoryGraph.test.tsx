import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { MemoryGraphResult, NormalizedEvent } from "@chimera/protocol";

// MEM-6 §5 — the thin React shell (MemoryGraph.tsx) around the framework-free
// GraphRenderer. This test drives the shell's own contract — fetch memory.graph
// → renderer.setData, forward the shared query as lit-node matches, refetch on
// memory:* daemon events, and dispose the renderer + detach the event listener
// on unmount — with the renderer itself mocked (its physics/drawing are covered
// by memory-graph-renderer*.test.ts).

if (typeof window === "undefined") {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    devicePixelRatio: 2,
  };
} else {
  (window as unknown as { devicePixelRatio: number }).devicePixelRatio = 2;
}
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({
  getPropertyValue: () => "#9aa3f2",
});
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
};

// ---- daemon-event seam: capture the callback so a test can fire memory:* -----
let eventCb: ((e: NormalizedEvent) => void) | null = null;
const offEvent = vi.fn();

let graphResult: MemoryGraphResult = { nodes: [], edges: [] };
const rpcImpl = vi.fn(async (method: string): Promise<unknown> => {
  if (method === "memory.graph") return graphResult;
  return {};
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  onDaemonEvent: (cb: (e: NormalizedEvent) => void) => {
    eventCb = cb;
    return offEvent;
  },
}));

// ---- renderer mock: capture the single live instance + its method calls ------
const rendererMock = vi.hoisted(() => {
  const instances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  return { instances };
});
vi.mock("../src/memory-graph/renderer", () => {
  class GraphRenderer {
    setData = vi.fn();
    setSearchMatches = vi.fn();
    setColorMode = vi.fn();
    setClusterByFolder = vi.fn();
    setShowSemantic = vi.fn();
    setSize = vi.fn();
    focusBestMatch = vi.fn();
    dispose = vi.fn();
    constructor() {
      rendererMock.instances.push(this as unknown as Record<string, ReturnType<typeof vi.fn>>);
    }
  }
  return { GraphRenderer };
});

import { MemoryGraph } from "../src/components/MemoryGraph";

const node = (id: string, label: string) => ({
  id,
  title: null,
  label,
  kind: "note" as const,
  folder: null,
  tags: [] as string[],
  degree: 0,
  updatedAt: 1,
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

// canvas + host refs must be non-null for the mount effect to build the renderer
const createNodeMock = () => ({
  getContext: () => ({}),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  addEventListener: () => {},
  removeEventListener: () => {},
  style: {} as Record<string, string>,
  width: 0,
  height: 0,
});

let mounted: ReturnType<typeof create> | null = null;

beforeEach(() => {
  rpcImpl.mockClear();
  offEvent.mockClear();
  rendererMock.instances.length = 0;
  eventCb = null;
  graphResult = { nodes: [], edges: [] };
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

const last = () => rendererMock.instances[rendererMock.instances.length - 1]!;

describe("MemoryGraph shell — fetch → renderer.setData", () => {
  it("fetches memory.graph on mount and feeds the result to the renderer", async () => {
    graphResult = { nodes: [node("a", "alpha"), node("b", "beta")], edges: [] };
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "" }), { createNodeMock });
    });
    await flush();
    expect(rpcImpl).toHaveBeenCalledWith("memory.graph", {});
    expect(last().setData).toHaveBeenCalledTimes(1);
  });

  it("does not build a renderer when inactive (fetch gated on graph mode)", async () => {
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: false, query: "" }), { createNodeMock });
    });
    await flush();
    expect(rendererMock.instances).toHaveLength(0);
    expect(rpcImpl).not.toHaveBeenCalled();
  });
});

describe("MemoryGraph shell — search match forwarding", () => {
  it("forwards the query's matching node ids as lit matches after load", async () => {
    graphResult = { nodes: [node("a", "alpha"), node("b", "beta")], edges: [] };
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "alph" }), { createNodeMock });
    });
    await flush();
    // last setSearchMatches call after load carries the id whose label matched
    const calls = last().setSearchMatches.mock.calls as Array<[Set<string> | null]>;
    const litSet = calls[calls.length - 1]![0];
    expect(litSet).toEqual(new Set(["a"]));
  });

  it("relights matches when the shared query prop changes", async () => {
    graphResult = { nodes: [node("a", "alpha"), node("b", "beta")], edges: [] };
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "" }), { createNodeMock });
    });
    await flush();
    act(() => {
      mounted!.update(React.createElement(MemoryGraph, { active: true, query: "beta" }));
    });
    const calls = last().setSearchMatches.mock.calls as Array<[Set<string> | null]>;
    expect(calls[calls.length - 1]![0]).toEqual(new Set(["b"]));
  });
});

describe("MemoryGraph shell — event refetch (§4 freshness)", () => {
  it("refetches memory.graph after a debounced memory:* daemon event", async () => {
    graphResult = { nodes: [node("a", "alpha")], edges: [] };
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "" }), { createNodeMock });
    });
    await flush();
    expect(rpcImpl).toHaveBeenCalledTimes(1);

    act(() => {
      eventCb?.({ ts: 1, seq: 1, agentId: "memory:edit", kind: "status", data: {} } as NormalizedEvent);
    });
    await wait(350); // clears the 300ms refetch debounce
    expect(rpcImpl).toHaveBeenCalledTimes(2);
  });

  it("ignores non-memory events", async () => {
    graphResult = { nodes: [], edges: [] };
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "" }), { createNodeMock });
    });
    await flush();
    expect(rpcImpl).toHaveBeenCalledTimes(1);

    act(() => {
      eventCb?.({ ts: 1, seq: 1, agentId: "worker:1", kind: "status", data: {} } as NormalizedEvent);
    });
    await wait(350);
    expect(rpcImpl).toHaveBeenCalledTimes(1);
  });
});

describe("MemoryGraph shell — similarity edges toggle (MEM-7 §4, §5.2)", () => {
  it("omits semanticEdges from the fetch by default, off at the renderer", async () => {
    graphResult = { nodes: [node("a", "alpha")], edges: [] };
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "" }), { createNodeMock });
    });
    await flush();
    expect(rpcImpl).toHaveBeenCalledWith("memory.graph", {});
    expect(last().setShowSemantic).toHaveBeenCalledWith(false);
  });

  it("clicking the similarity toggle refetches with semanticEdges:true and flips the renderer flag", async () => {
    graphResult = { nodes: [node("a", "alpha")], edges: [] };
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "" }), { createNodeMock });
    });
    await flush();
    expect(rpcImpl).toHaveBeenCalledTimes(1);

    const toggle = mounted!.root.findAll((n) => (n.props as Record<string, unknown>)["title"] === "dashed edges between semantically-similar notes (needs the vector index ready)")[0]!;
    act(() => { (toggle.props as { onClick: () => void }).onClick(); });
    await flush();

    expect(rpcImpl).toHaveBeenCalledTimes(2);
    expect(rpcImpl).toHaveBeenLastCalledWith("memory.graph", { semanticEdges: true });
    expect(last().setShowSemantic).toHaveBeenCalledWith(true);
  });
});

describe("MemoryGraph shell — cleanup on unmount", () => {
  it("disposes the renderer and detaches the event listener", async () => {
    act(() => {
      mounted = create(React.createElement(MemoryGraph, { active: true, query: "" }), { createNodeMock });
    });
    await flush();
    const inst = last();
    act(() => mounted!.unmount());
    mounted = null;
    expect(inst.dispose).toHaveBeenCalledTimes(1);
    expect(offEvent).toHaveBeenCalledTimes(1);
  });
});
