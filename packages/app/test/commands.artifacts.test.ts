import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { NormalizedEvent } from "@chimera/protocol";
import {
  createArtifactsCommands,
  createArtifactsLocal,
  useArtifacts,
  useDiffMeta,
} from "../src/state/commands.artifacts";
import type { ArtifactRow } from "../src/state/selectors.artifacts";

// F17 (W19 artifacts & deliverables, coverage B21/C15). Mirrors
// commands.workflows.test.ts's harness for the pure RPC wrappers
// (createArtifactsCommands); useArtifacts/useDiffMeta are React hooks (they
// carry their own useState/useEffect), so they need an actual render pass —
// react-test-renderer is a devDependency-only addition for exactly this (no
// DOM, fits the package's existing node-env vitest config).

type Call = { method: string; params: unknown };

const flush = (): Promise<void> => act(async () => {});

function renderHook<T>(hook: () => T): { result: { current: T }; rerender: () => Promise<void>; unmount: () => void } {
  const result = {} as { current: T };
  function Test(): null {
    result.current = hook();
    return null;
  }
  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(React.createElement(Test));
  });
  return {
    result,
    rerender: () => act(async () => renderer.update(React.createElement(Test))),
    unmount: () => act(() => renderer.unmount()),
  };
}

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "art-1",
  kind: "report",
  label: "report.md",
  agentId: "agent-1",
  taskId: "task-1",
  createdAt: 1000,
  sizeBytes: 100,
  path: "/tmp/report.md",
  url: null,
  ...over,
});

// ---------------------------------------------------------------------------
// createArtifactsCommands (pure RPC wrappers)
// ---------------------------------------------------------------------------

describe("createArtifactsCommands", () => {
  function harness() {
    const calls: Call[] = [];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "artifact.list") return Promise.resolve([rec()] as unknown as T);
      if (method === "artifact.get") return Promise.resolve(rec() as unknown as T);
      return Promise.reject(new Error(`unexpected method ${method}`));
    };
    return { cmds: createArtifactsCommands(request), calls };
  }

  it("listForAgent scopes by agentId and projects rows", async () => {
    const h = harness();
    const rows = await h.cmds.listForAgent("agent-1");
    expect(h.calls).toEqual([{ method: "artifact.list", params: { agentId: "agent-1" } }]);
    expect(rows.map((r) => r.id)).toEqual(["art-1"]);
  });

  it("listForTask scopes by taskId", async () => {
    const h = harness();
    await h.cmds.listForTask("task-1");
    expect(h.calls).toEqual([{ method: "artifact.list", params: { taskId: "task-1" } }]);
  });

  it("get fetches artifact.get{id} and projects a single row", async () => {
    const h = harness();
    const row = await h.cmds.get("art-1");
    expect(h.calls).toEqual([{ method: "artifact.get", params: { id: "art-1" } }]);
    expect(row.id).toBe("art-1");
  });
});

// ---------------------------------------------------------------------------
// useArtifacts — optimistic-then-reconcile merge
// ---------------------------------------------------------------------------

describe("useArtifacts", () => {
  it("returns [] with a null scope, and issues no request", async () => {
    const calls: Call[] = [];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.reject(new Error("unexpected"));
    };
    const h = renderHook(() => useArtifacts(null, [], request));
    await flush();
    expect(h.result.current).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("shows an optimistic row immediately, then merges the reconciled fetch (fetched wins by id)", async () => {
    const calls: Call[] = [];
    const events: NormalizedEvent[] = [
      {
        ts: 10, seq: 1, engineId: "local", agentId: "agent-1", kind: "artifact_added",
        data: { id: "art-1", kind: "report", label: "optimistic.md", agentId: "agent-1", taskId: "task-1", sizeBytes: 5 },
      },
    ];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve([rec({ label: "reconciled.md" })] as unknown as T);
    };
    const h = renderHook(() => useArtifacts({ agentId: "agent-1" }, events, request));

    // synchronous first render: the optimistic row is visible before the fetch resolves
    expect((h.result.current as ArtifactRow[]).map((r) => r.label)).toEqual(["optimistic.md"]);

    await flush();
    expect(calls).toEqual([{ method: "artifact.list", params: { agentId: "agent-1" } }]);
    // reconciled fetch wins over the optimistic copy for the same id, still one row
    expect((h.result.current as ArtifactRow[]).map((r) => r.label)).toEqual(["reconciled.md"]);
  });

  it("keeps an unreconciled optimistic row (different id) appended after the fetched set", async () => {
    const events: NormalizedEvent[] = [
      {
        ts: 20, seq: 2, engineId: "local", agentId: "agent-1", kind: "artifact_added",
        data: { id: "art-2", kind: "diff", label: "new.patch", agentId: "agent-1", taskId: "task-1", sizeBytes: 5 },
      },
    ];
    const request = <T = unknown>(): Promise<T> => Promise.resolve([rec({ id: "art-1" })] as unknown as T);
    const h = renderHook(() => useArtifacts({ agentId: "agent-1" }, events, request));
    await flush();
    expect((h.result.current as ArtifactRow[]).map((r) => r.id)).toEqual(["art-1", "art-2"]);
  });

  it("re-fetches when latestArtifactSeq changes (the reconcile trigger)", async () => {
    const calls: Call[] = [];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve([] as unknown as T);
    };
    let events: NormalizedEvent[] = [];
    const h = renderHook(() => useArtifacts({ taskId: "task-1" }, events, request));
    await flush();
    expect(calls).toHaveLength(1);

    events = [{ ts: 30, seq: 3, engineId: "local", agentId: "agent-1", kind: "artifact_added", data: { id: "art-3", taskId: "task-1" } }];
    await h.rerender();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("does not re-fetch on a rerender with an unchanged scope+seq", async () => {
    const calls: Call[] = [];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve([] as unknown as T);
    };
    const events: NormalizedEvent[] = [];
    const h = renderHook(() => useArtifacts({ agentId: "agent-1" }, events, request));
    await flush();
    expect(calls).toHaveLength(1);
    await h.rerender();
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// useDiffMeta — fetch-once-per-id cache keyed by joined diffIds
// ---------------------------------------------------------------------------

describe("useDiffMeta", () => {
  it("fetches a diff row's snapshot once and computes ±lines", async () => {
    const reads: string[] = [];
    const readSnapshot = (id: string): Promise<string> => {
      reads.push(id);
      return Promise.resolve("+a\n-b\n context");
    };
    const rows: ArtifactRow[] = [
      { id: "d1", kind: "diff", label: "d1", agentId: null, taskId: null, createdAt: 0, sizeBytes: null, path: null, url: null },
    ];
    const h = renderHook(() => useDiffMeta(rows, readSnapshot));
    await flush();
    expect(reads).toEqual(["d1"]);
    expect(h.result.current["d1"]).toEqual({ plus: 1, minus: 1 });
  });

  it("ignores non-diff kinds", async () => {
    const reads: string[] = [];
    const readSnapshot = (id: string): Promise<string> => {
      reads.push(id);
      return Promise.resolve("");
    };
    const rows: ArtifactRow[] = [
      { id: "r1", kind: "report", label: "r1", agentId: null, taskId: null, createdAt: 0, sizeBytes: null, path: null, url: null },
    ];
    const h = renderHook(() => useDiffMeta(rows, readSnapshot));
    await flush();
    expect(reads).toEqual([]);
    expect(h.result.current).toEqual({});
  });

  it("caches by id: a rerender with the SAME diffIds does not re-fetch", async () => {
    const reads: string[] = [];
    const readSnapshot = (id: string): Promise<string> => {
      reads.push(id);
      return Promise.resolve("+a");
    };
    const rows: ArtifactRow[] = [
      { id: "d1", kind: "diff", label: "d1", agentId: null, taskId: null, createdAt: 0, sizeBytes: null, path: null, url: null },
    ];
    const h = renderHook(() => useDiffMeta(rows, readSnapshot));
    await flush();
    expect(reads).toEqual(["d1"]);
    await h.rerender();
    await flush();
    expect(reads).toEqual(["d1"]); // no second fetch for the same id
  });

  it("fetches a newly-added diffId (joined-key changed) but not the already-cached one", async () => {
    const reads: string[] = [];
    const readSnapshot = (id: string): Promise<string> => {
      reads.push(id);
      return Promise.resolve("+a");
    };
    let rows: ArtifactRow[] = [
      { id: "d1", kind: "diff", label: "d1", agentId: null, taskId: null, createdAt: 0, sizeBytes: null, path: null, url: null },
    ];
    const h = renderHook(() => useDiffMeta(rows, readSnapshot));
    await flush();
    expect(reads).toEqual(["d1"]);

    rows = [
      ...rows,
      { id: "d2", kind: "diff", label: "d2", agentId: null, taskId: null, createdAt: 0, sizeBytes: null, path: null, url: null },
    ];
    await h.rerender();
    await flush();
    expect(reads).toEqual(["d1", "d2"]);
    expect(Object.keys(h.result.current).sort()).toEqual(["d1", "d2"]);
  });
});

// ---------------------------------------------------------------------------
// artifactsLocal / useArtifactsLocal (preview card open-by-id state)
// ---------------------------------------------------------------------------

describe("createArtifactsLocal", () => {
  it("starts with no preview open, and set()/subscribe() notify listeners", () => {
    const local = createArtifactsLocal();
    expect(local.getState()).toEqual({ previewId: null });
    let notified = 0;
    const unsub = local.subscribe(() => { notified++; });
    local.set({ previewId: "art-1" });
    expect(local.getState().previewId).toBe("art-1");
    expect(notified).toBe(1);
    unsub();
    local.set({ previewId: null });
    expect(notified).toBe(1); // unsubscribed, no further notifications
  });
});
