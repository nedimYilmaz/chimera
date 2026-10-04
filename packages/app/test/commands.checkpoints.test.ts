import { describe, expect, it } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { UiStore } from "@chimera/ui-state";
import type { CheckpointRecord, CheckpointStatus } from "@chimera/protocol";
import { createCheckpointsCommands, useFilesSinceMeta } from "../src/state/commands.checkpoints";
import type { CheckpointRow } from "../src/state/selectors.checkpoints";

// F20 (W22 · coverage §B24/§C18) — the checkpoints strip/card store. Governing
// rules under test: (1) a non-git cwd (checkpoint.status.supported:false)
// clears count/latest so the strip stays dark; (2) revert is ALWAYS routed
// through requestRevert → confirmRevert (the ConfirmCard gate), never direct;
// (3) a busy-repo refusal (CheckpointBusyError, {code:"guardrail"}) surfaces
// as a commandError toast with the guard text verbatim, exactly like every
// other failure — nothing guard-specific is special-cased.

type Call = { method: string; params: unknown };

function harness(handlers: Partial<Record<string, (params: unknown) => unknown>>) {
  const calls: Call[] = [];
  const dispatched: unknown[] = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params: params ?? {} });
    const h = handlers[method];
    if (!h) return Promise.reject(new Error(`unexpected method ${method}`));
    const result = h(params);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result as T);
  };
  const cmds = createCheckpointsCommands(store, request);
  return { cmds, calls, dispatched };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const row = (over: Partial<CheckpointRecord> = {}): CheckpointRecord => ({
  id: "1", ref: "refs/chimera/checkpoints/1", trigger: "manual", ts: 1000, agentId: "a1", taskId: null,
  message: "chimera checkpoint: manual", ...over,
});

describe("refreshStatus", () => {
  it("a non-git cwd (supported:false) clears count/latest", async () => {
    const h = harness({ "checkpoint.status": (): CheckpointStatus => ({ supported: false, cwd: "/not-git" }) });
    await h.cmds.refreshStatus("/not-git");
    expect(h.cmds.getState()).toMatchObject({ supported: false, count: 0, latest: null, cwd: "/not-git" });
  });

  it("a git cwd populates count/latest from checkpoint.status", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 2, latest: row() }),
    });
    await h.cmds.refreshStatus("/repo");
    const s = h.cmds.getState();
    expect(s.supported).toBe(true);
    expect(s.count).toBe(2);
    expect(s.latest).toEqual({
      id: "1",
      ref: "refs/chimera/checkpoints/1",
      trigger: "manual",
      ts: 1000,
      message: "chimera checkpoint: manual",
    });
  });

  it("null cwd (no selected agent) clears everything without an RPC call", async () => {
    const h = harness({});
    await h.cmds.refreshStatus(null);
    expect(h.cmds.getState()).toMatchObject({ supported: false, count: 0, latest: null, cwd: null });
    expect(h.calls).toHaveLength(0);
  });

  it("a rejected checkpoint.status is treated as dark rather than throwing", async () => {
    const h = harness({ "checkpoint.status": (): never => { throw new Error("boom"); } });
    await h.cmds.refreshStatus("/repo");
    expect(h.cmds.getState()).toMatchObject({ supported: false, count: 0, latest: null });
  });
});

describe("refreshForAgent — P3-T4 project-scoped cwd resolution", () => {
  it("no selected agent → dark, no RPC calls", async () => {
    const h = harness({});
    await h.cmds.refreshForAgent(null);
    expect(h.cmds.getState()).toMatchObject({ supported: false, count: 0, latest: null, cwd: null });
    expect(h.calls).toHaveLength(0);
  });

  it("an agent with a projectId resolves the PROJECT's path, not its raw spec.cwd (worktree agent)", async () => {
    const h = harness({
      "agent.status": () => ({ agentId: "a1", projectId: "chimera", spec: { cwd: "/repo/.chimera/worktrees/abc" } }),
      "project.list": () => [{ name: "chimera", path: "/repo/chimera" }, { name: "other", path: "/repo/other" }],
      "checkpoint.status": (params) => {
        expect(params).toEqual({ cwd: "/repo/chimera" });
        return { supported: true, cwd: "/repo/chimera", count: 1, latest: row() };
      },
    });
    await h.cmds.refreshForAgent("a1");
    expect(h.cmds.getState()).toMatchObject({ cwd: "/repo/chimera", supported: true, count: 1 });
  });

  it("an agent with no projectId falls back to spec.cwd, without ever calling project.list", async () => {
    const h = harness({
      "agent.status": () => ({ agentId: "a1", projectId: null, spec: { cwd: "/home/user" } }),
      "checkpoint.status": (params) => {
        expect(params).toEqual({ cwd: "/home/user" });
        return { supported: false, cwd: "/home/user" };
      },
    });
    await h.cmds.refreshForAgent("a1");
    expect(h.cmds.getState()).toMatchObject({ cwd: "/home/user", supported: false });
    expect(h.calls.some((c) => c.method === "project.list")).toBe(false);
  });

  it("a projectId that resolves to no known project falls back to spec.cwd", async () => {
    const h = harness({
      "agent.status": () => ({ agentId: "a1", projectId: "ghost", spec: { cwd: "/somewhere" } }),
      "project.list": () => [{ name: "chimera", path: "/repo/chimera" }],
      "checkpoint.status": (params) => {
        expect(params).toEqual({ cwd: "/somewhere" });
        return { supported: false, cwd: "/somewhere" };
      },
    });
    await h.cmds.refreshForAgent("a1");
    expect(h.cmds.getState()).toMatchObject({ cwd: "/somewhere", supported: false });
  });

  it("a rejected agent.status resolves to dark rather than throwing", async () => {
    const h = harness({ "agent.status": (): never => { throw new Error("no such agent"); } });
    await h.cmds.refreshForAgent("ghost-id");
    expect(h.cmds.getState()).toMatchObject({ supported: false, count: 0, latest: null, cwd: null });
  });

  it("a rejected project.list falls back to spec.cwd rather than dropping the resolution entirely", async () => {
    const h = harness({
      "agent.status": () => ({ agentId: "a1", projectId: "chimera", spec: { cwd: "/repo/.chimera/worktrees/abc" } }),
      "project.list": (): never => { throw new Error("boom"); },
      "checkpoint.status": (params) => {
        expect(params).toEqual({ cwd: "/repo/.chimera/worktrees/abc" });
        return { supported: true, cwd: "/repo/.chimera/worktrees/abc", count: 1, latest: row() };
      },
    });
    await h.cmds.refreshForAgent("a1");
    expect(h.cmds.getState()).toMatchObject({ cwd: "/repo/.chimera/worktrees/abc", supported: true });
  });
});

describe("toggle / list", () => {
  it("open fetches checkpoint.list for the current cwd", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 1, latest: row() }),
      "checkpoint.list": (): CheckpointRecord[] => [row({ id: "2" }), row({ id: "1" })],
    });
    await h.cmds.refreshStatus("/repo");
    h.cmds.toggle();
    await settle();
    expect(h.cmds.getState().open).toBe(true);
    expect(h.cmds.getState().items.map((r) => r.id)).toEqual(["2", "1"]);
  });

  it("closing clears any open confirm gate too", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 1, latest: row() }),
      "checkpoint.list": (): CheckpointRecord[] => [row()],
    });
    await h.cmds.refreshStatus("/repo");
    h.cmds.toggle();
    await settle();
    h.cmds.requestRevert("1");
    expect(h.cmds.getState().confirmId).toBe("1");
    h.cmds.toggle(); // closes
    expect(h.cmds.getState().open).toBe(false);
    expect(h.cmds.getState().confirmId).toBeNull();
  });
});

describe("select / move", () => {
  it("move clamps within the list bounds", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 2, latest: row() }),
      "checkpoint.list": (): CheckpointRecord[] => [row({ id: "2" }), row({ id: "1" })],
    });
    await h.cmds.refreshStatus("/repo");
    h.cmds.toggle();
    await settle();
    h.cmds.move(-1);
    expect(h.cmds.getState().selected).toBe(0);
    h.cmds.move(5);
    expect(h.cmds.getState().selected).toBe(1);
  });

  it("select is a no-op out of range", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 1, latest: row() }),
      "checkpoint.list": (): CheckpointRecord[] => [row()],
    });
    await h.cmds.refreshStatus("/repo");
    h.cmds.toggle();
    await settle();
    h.cmds.select(9);
    expect(h.cmds.getState().selected).toBe(0);
  });
});

describe("createManual — mod+k", () => {
  it("no-ops for a dark (unsupported) repo, no RPC call", async () => {
    const h = harness({ "checkpoint.status": (): CheckpointStatus => ({ supported: false, cwd: "/x" }) });
    await h.cmds.refreshStatus("/x");
    await h.cmds.createManual("a1");
    expect(h.calls.some((c) => c.method === "checkpoint.create")).toBe(false);
  });

  it("creates a manual checkpoint, toasts a notice, and re-fetches status", async () => {
    let statusCalls = 0;
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => {
        statusCalls++;
        return statusCalls === 1
          ? { supported: true, cwd: "/repo", count: 0, latest: null }
          : { supported: true, cwd: "/repo", count: 1, latest: row() };
      },
      "checkpoint.create": (params) => {
        expect(params).toMatchObject({ cwd: "/repo", trigger: "manual", agentId: "a1" });
        return row();
      },
    });
    await h.cmds.refreshStatus("/repo");
    await h.cmds.createManual("a1");
    expect(h.dispatched).toContainEqual({ type: "notice", message: "checkpoint created" });
    expect(h.cmds.getState().count).toBe(1);
  });

  it("a rejected create dispatches commandError", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 0, latest: null }),
      "checkpoint.create": (): never => { throw new Error("disk full"); },
    });
    await h.cmds.refreshStatus("/repo");
    await h.cmds.createManual("a1");
    expect(h.dispatched).toContainEqual({ type: "commandError", message: "disk full" });
  });
});

describe("revert — requestRevert → confirmRevert (the ONE guarded path)", () => {
  it("requestRevert only opens the confirm gate — no RPC call yet", async () => {
    const h = harness({ "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 1, latest: row() }) });
    await h.cmds.refreshStatus("/repo");
    h.cmds.requestRevert("1");
    expect(h.cmds.getState().confirmId).toBe("1");
    expect(h.calls.some((c) => c.method === "checkpoint.revert")).toBe(false);
  });

  it("cancelRevert closes the gate without calling revert", async () => {
    const h = harness({ "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 1, latest: row() }) });
    await h.cmds.refreshStatus("/repo");
    h.cmds.requestRevert("1");
    h.cmds.cancelRevert();
    expect(h.cmds.getState().confirmId).toBeNull();
    expect(h.calls.some((c) => c.method === "checkpoint.revert")).toBe(false);
  });

  it("confirmRevert calls checkpoint.revert, closes the gate, and toasts a notice", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 1, latest: row() }),
      "checkpoint.revert": (params) => {
        expect(params).toEqual({ cwd: "/repo", id: "1" });
        return { id: "1", ref: "refs/chimera/checkpoints/1", restoredFiles: 12 };
      },
    });
    await h.cmds.refreshStatus("/repo");
    h.cmds.requestRevert("1");
    await h.cmds.confirmRevert();
    expect(h.cmds.getState().confirmId).toBeNull();
    expect(h.dispatched).toContainEqual({ type: "notice", message: "reverted to checkpoint cp-1" });
  });

  it("a busy-repo refusal toasts the guard message verbatim (F20's toast requirement)", async () => {
    const h = harness({
      "checkpoint.status": (): CheckpointStatus => ({ supported: true, cwd: "/repo", count: 1, latest: row() }),
      "checkpoint.revert": (): never => {
        throw new Error('refusing to revert "/repo": an agent is running in this repo — kill it first');
      },
    });
    await h.cmds.refreshStatus("/repo");
    h.cmds.requestRevert("1");
    await h.cmds.confirmRevert();
    expect(h.cmds.getState().confirmId).toBeNull(); // the gate still closes
    expect(h.dispatched).toContainEqual({
      type: "commandError",
      message: 'refusing to revert "/repo": an agent is running in this repo — kill it first',
    });
  });
});

// ---------------------------------------------------------------------------
// useFilesSinceMeta — fetch-once-per-id cache keyed by joined row ids
// (mirrors commands.artifacts.test.ts's useDiffMeta harness: a real render
// pass via react-test-renderer, no DOM).
// ---------------------------------------------------------------------------

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

const checkpointRowFixture = (over: Partial<CheckpointRow> = {}): CheckpointRow => ({
  id: "1",
  ref: "refs/chimera/checkpoints/1",
  trigger: "manual",
  ts: 1000,
  message: "chimera checkpoint: manual",
  ...over,
});

describe("useFilesSinceMeta", () => {
  it("fetches a row's files-since count once, keyed by its ref", async () => {
    const calls: Array<{ cwd: string; ref: string }> = [];
    const fetchFilesSince = (cwd: string, ref: string): Promise<number> => {
      calls.push({ cwd, ref });
      return Promise.resolve(3);
    };
    const rows = [checkpointRowFixture()];
    const h = renderHook(() => useFilesSinceMeta("/repo", rows, fetchFilesSince));
    await flush();
    expect(calls).toEqual([{ cwd: "/repo", ref: "refs/chimera/checkpoints/1" }]);
    expect(h.result.current["1"]).toBe(3);
  });

  it("does not fetch without a resolved cwd", async () => {
    const calls: string[] = [];
    const fetchFilesSince = (_cwd: string, ref: string): Promise<number> => {
      calls.push(ref);
      return Promise.resolve(0);
    };
    const h = renderHook(() => useFilesSinceMeta(null, [checkpointRowFixture()], fetchFilesSince));
    await flush();
    expect(calls).toEqual([]);
    expect(h.result.current).toEqual({});
  });

  it("caches by id: a rerender with the SAME rows does not re-fetch", async () => {
    const calls: string[] = [];
    const fetchFilesSince = (_cwd: string, ref: string): Promise<number> => {
      calls.push(ref);
      return Promise.resolve(2);
    };
    const rows = [checkpointRowFixture()];
    const h = renderHook(() => useFilesSinceMeta("/repo", rows, fetchFilesSince));
    await flush();
    expect(calls).toHaveLength(1);
    await h.rerender();
    await flush();
    expect(calls).toHaveLength(1); // no second fetch for the same id
  });

  it("a rejected fetch is swallowed rather than throwing — the row stays undefined", async () => {
    const fetchFilesSince = (): Promise<number> => Promise.reject(new Error("git error"));
    const h = renderHook(() => useFilesSinceMeta("/repo", [checkpointRowFixture()], fetchFilesSince));
    await flush();
    expect(h.result.current["1"]).toBeUndefined();
  });
});
