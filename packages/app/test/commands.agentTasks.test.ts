import { describe, expect, it } from "vitest";
import { createAgentTasksCommands, createAgentTasksLocal } from "../src/state/commands.agentTasks";

// W20 (AgentList workflow-step indicator) — the loadAgentTasks command:
// queue.list -> queue.status per queue, flattened into ONE tasks array so an
// arbitrary agent's current task can be resolved without the caller knowing
// its queue up front. Mirrors commands.workflows.test.ts's harness (a stub
// RequestFn, no bridge.ts import) — createAgentTasksLocal gives each test its
// own store instead of reaching for the app-wide singleton.

type Call = { method: string; params: unknown };

function harness(handlers: Partial<Record<string, (params: unknown) => unknown>>) {
  const calls: Call[] = [];
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    const h = handlers[method];
    if (!h) return Promise.reject(new Error(`unexpected method ${method}`));
    const result = h(params);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result as T);
  };
  const local = createAgentTasksLocal();
  const cmds = createAgentTasksCommands(local, request);
  return { cmds, local, calls };
}

describe("loadAgentTasks / refresh", () => {
  it("flattens queue.status across every queue.list entry", async () => {
    const h = harness({
      "queue.list": () => [{ name: "dev" }, { name: "qa" }],
      "queue.status": (params) => {
        const { queue } = params as { queue: string };
        return { tasks: [{ taskId: `${queue}-1`, queue }] };
      },
    });
    await h.cmds.loadAgentTasks();
    expect(h.local.getState().tasks.map((t) => t["taskId"])).toEqual(["dev-1", "qa-1"]);
    expect(h.calls).toEqual([
      { method: "queue.list", params: {} },
      { method: "queue.status", params: { queue: "dev" } },
      { method: "queue.status", params: { queue: "qa" } },
    ]);
  });

  it("refresh is the same operation as loadAgentTasks", async () => {
    const h = harness({
      "queue.list": () => [{ name: "dev" }],
      "queue.status": () => ({ tasks: [{ taskId: "t1" }] }),
    });
    await h.cmds.refresh();
    expect(h.local.getState().tasks).toEqual([{ taskId: "t1" }]);
  });

  it("a single queue's status failing doesn't blank the others", async () => {
    const h = harness({
      "queue.list": () => [{ name: "dev" }, { name: "broken" }],
      "queue.status": (params) => {
        const { queue } = params as { queue: string };
        if (queue === "broken") return new Error("boom");
        return { tasks: [{ taskId: "dev-1" }] };
      },
    });
    await h.cmds.loadAgentTasks();
    expect(h.local.getState().tasks).toEqual([{ taskId: "dev-1" }]);
  });

  it("queue.list itself failing (Phase-2 disabled / transient) leaves the previous snapshot in place, silently", async () => {
    const h = harness({ "queue.list": () => new Error("unknown method queue.list") });
    await h.cmds.loadAgentTasks();
    expect(h.local.getState().tasks).toEqual([]);
  });
});

describe("loadAgentTasks coalesces bursts", () => {
  // Every coordination event re-ran this, and each run fetches EVERY queue's full task list
  // (MBs per queue). Overlapping runs during an event burst fed the daemon ~2.6 MB/s of
  // responses its unread write queue then had to hold; one round in flight plus one trailing
  // round keeps the result fresh without stacking rounds.
  it("runs one round in flight and one trailing round for any number of calls meanwhile", async () => {
    let release: () => void = () => {};
    let round = 0;
    let listCalls = 0;
    const local = createAgentTasksLocal();
    const request = <T = unknown>(method: string): Promise<T> => {
      if (method === "queue.list") {
        listCalls++;
        const mine = ++round;
        return (mine === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve()).then(() => [{ name: "dev" }] as T);
      }
      return Promise.resolve({ tasks: [{ taskId: `t-round-${round}` }] } as T);
    };
    const cmds = createAgentTasksCommands(local, request);
    const calls = [cmds.loadAgentTasks(), cmds.loadAgentTasks(), cmds.loadAgentTasks(), cmds.loadAgentTasks(), cmds.loadAgentTasks()];
    expect(listCalls).toBe(1);
    release();
    await Promise.all(calls);
    expect(listCalls).toBe(2);
    expect(local.getState().tasks).toEqual([{ taskId: "t-round-2" }]);
  });
});
