import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { ReviewSession, TaskEvidence } from "@chimera/protocol";
import type { UiStore } from "@chimera/ui-state";
import { createEvidenceCommands, openReviewRoom, useTaskEvidence } from "../src/state/commands.evidence";

// FEATURE-10 (Changes & Evidence Review) — mirrors commands.artifacts.test.ts's harness:
// createEvidenceCommands is a pure RPC wrapper; useTaskEvidence carries its own
// useState/useEffect, so it needs an actual render pass (react-test-renderer, no DOM).

type Call = { method: string; params: unknown };

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

const evidence = (over: Partial<TaskEvidence> = {}): TaskEvidence => ({
  taskId: "t1", queue: "work", state: "done", workflow: null, steps: [], artifacts: [], provenance: [],
  ...over,
});

describe("createEvidenceCommands", () => {
  it("get() calls evidence.get with the taskId", async () => {
    const calls: Call[] = [];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve(evidence() as unknown as T);
    };
    const cmds = createEvidenceCommands(request);
    const result = await cmds.get("t1");
    expect(calls).toEqual([{ method: "evidence.get", params: { taskId: "t1" } }]);
    expect(result).toEqual(evidence());
  });
  it("sends findings and decisions to the review RPC family", async () => {
    const calls: Call[] = [];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => { calls.push({ method, params }); return Promise.resolve({} as T); };
    const cmds = createEvidenceCommands(request);
    await cmds.addFinding({ taskId: "t1", path: "a.ts", severity: "blocking", body: "fix" });
    await cmds.decide("t1", "changes_requested", "blocked");
    expect(calls.map((call) => call.method)).toEqual(["review.finding.add", "review.decide"]);
  });
});

const session = (over: Partial<ReviewSession> = {}): ReviewSession => ({
  taskId: "t1", findings: [], decision: null, revision: 0, updatedAt: 0,
  ...over,
});

function makeStore(): { store: UiStore; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
  return { store, dispatched };
}

describe("openReviewRoom", () => {
  it("turns an object-shaped evidence.get rejection into a readable error even when review.get succeeds", async () => {
    const { store, dispatched } = makeStore();
    const request = <T = unknown>(method: string): Promise<T> =>
      method === "evidence.get" ? Promise.reject({ code: "protocol", message: "evidence blew up" }) : Promise.resolve(session() as unknown as T);
    await openReviewRoom(store, request, "t1");
    expect(dispatched).toEqual([
      { type: "reviewRoomOpen", taskId: "t1" },
      { type: "reviewRoomLoading", taskId: "t1" },
      { type: "reviewRoomFailed", taskId: "t1", error: "evidence blew up" },
    ]);
  });

  it("degrades to a session-less load when review.get is unknown-method but evidence.get succeeds", async () => {
    const { store, dispatched } = makeStore();
    const request = <T = unknown>(method: string): Promise<T> => {
      if (method === "evidence.get") return Promise.resolve(evidence({ taskId: "t1" }) as unknown as T);
      return Promise.reject({ code: "protocol", message: 'unknown method "review.get"' });
    };
    await openReviewRoom(store, request, "t1");
    expect(dispatched).toEqual([
      { type: "reviewRoomOpen", taskId: "t1" },
      { type: "reviewRoomLoading", taskId: "t1" },
      { type: "reviewRoomLoaded", taskId: "t1", evidence: evidence({ taskId: "t1" }), session: null, sessionError: "review unavailable — daemon predates review RPCs (restart chimerad)" },
    ]);
  });

  it("combines both failures into one readable message when evidence.get and review.get both reject", async () => {
    const { store, dispatched } = makeStore();
    const request = (method: string): Promise<never> =>
      Promise.reject(method === "evidence.get" ? { code: "protocol", message: "evidence down" } : { code: "protocol", message: "review down" });
    await openReviewRoom(store, request, "t1");
    expect(dispatched.at(-1)).toEqual({ type: "reviewRoomFailed", taskId: "t1", error: "evidence down; review down" });
  });

  it("loads a full session when both fetches succeed", async () => {
    const { store, dispatched } = makeStore();
    const request = <T = unknown>(method: string): Promise<T> =>
      Promise.resolve((method === "evidence.get" ? evidence({ taskId: "t1" }) : session()) as unknown as T);
    await openReviewRoom(store, request, "t1");
    expect(dispatched.at(-1)).toEqual({ type: "reviewRoomLoaded", taskId: "t1", evidence: evidence({ taskId: "t1" }), session: session(), sessionError: null });
  });
});

describe("useTaskEvidence", () => {
  it("stays idle (no fetch) while taskId is null", async () => {
    const calls: Call[] = [];
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return Promise.resolve(evidence() as unknown as T);
    };
    const { result } = renderHook(() => useTaskEvidence(null, request));
    expect(result.current).toEqual({ loading: false, data: null, error: null });
    expect(calls).toEqual([]);
  });

  it("fetches once opened, resolving to {loading:false, data}", async () => {
    const request = <T = unknown>(): Promise<T> => Promise.resolve(evidence({ taskId: "t1" }) as unknown as T);
    const { result, rerender } = renderHook(() => useTaskEvidence("t1", request));
    expect(result.current.loading).toBe(true);
    await rerender();
    expect(result.current).toEqual({ loading: false, data: evidence({ taskId: "t1" }), error: null });
  });

  it("surfaces a rejected fetch as {loading:false, error}", async () => {
    const request = (): Promise<never> => Promise.reject(new Error("boom"));
    const { result, rerender } = renderHook(() => useTaskEvidence("t1", request));
    await rerender();
    expect(result.current).toEqual({ loading: false, data: null, error: "boom" });
  });

  it("turns an object-shaped rpc rejection into a readable message, not '[object Object]'", async () => {
    const request = (): Promise<never> => Promise.reject({ code: "protocol", message: "evidence blew up" });
    const { result, rerender } = renderHook(() => useTaskEvidence("t1", request));
    await rerender();
    expect(result.current).toEqual({ loading: false, data: null, error: "evidence blew up" });
  });

  it("clears the result the instant taskId goes back to null (closing the panel)", async () => {
    const request = <T = unknown>(): Promise<T> => Promise.resolve(evidence() as unknown as T);
    let taskId: string | null = "t1";
    const { result, rerender } = renderHook(() => useTaskEvidence(taskId, request));
    await rerender();
    expect(result.current.data).not.toBeNull();
    taskId = null;
    await rerender();
    expect(result.current).toEqual({ loading: false, data: null, error: null });
  });

  it("re-fetches when taskId changes to a different task", async () => {
    const calls: string[] = [];
    const request = <T = unknown>(_method: string, params?: unknown): Promise<T> => {
      calls.push((params as { taskId: string }).taskId);
      return Promise.resolve(evidence({ taskId: (params as { taskId: string }).taskId }) as unknown as T);
    };
    let taskId = "t1";
    const { result, rerender } = renderHook(() => useTaskEvidence(taskId, request));
    await rerender();
    taskId = "t2";
    await rerender();
    await rerender();
    expect(calls).toEqual(["t1", "t2"]);
    expect(result.current.data?.taskId).toBe("t2");
  });
});
