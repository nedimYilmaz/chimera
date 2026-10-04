import { describe, expect, it, beforeEach } from "vitest";
import { createStore, type UiStore } from "@chimera/ui-state";
import { createAgentCommands, resolveTargetIds } from "../src/state/commands.agents";

// AGENT-MARK: acting on SEVERAL agents at once — tick a set, then send/kill/hold/resume it.
//
// Two selections exist on purpose. `selectedAgentId` is "the one I am looking at" and drives the
// transcript; `markedAgentIds` is "the set I am about to act on". Folding them together would mean
// reading an agent's transcript could not help changing what a kill applies to.

function storeWith(agents: Array<{ agentId: string; state: string; shadow?: boolean }>): UiStore {
  const store = createStore();
  store.dispatch({
    type: "agentRecords",
    records: agents.map((a) => ({ ...a, accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 })) as never,
  });
  return store;
}

describe("the mark set", () => {
  it("toggles one agent without touching which one is SELECTED", () => {
    const store = storeWith([{ agentId: "a", state: "running" }, { agentId: "b", state: "running" }]);
    store.dispatch({ type: "selectAgent", agentId: "a" });
    store.dispatch({ type: "toggleAgentMark", agentId: "b" });
    expect(store.getState().markedAgentIds).toEqual(["b"]);
    expect(store.getState().selectedAgentId).toBe("a");   // looking at one, acting on another
    store.dispatch({ type: "toggleAgentMark", agentId: "b" });
    expect(store.getState().markedAgentIds).toEqual([]);
  });

  it("clearing an already-empty set is a no-op dispatch", () => {
    // The store's own rule: a dispatch that changes nothing must not hand back a new object, or
    // every subscriber repaints for a change that never happened.
    const store = storeWith([{ agentId: "a", state: "running" }]);
    const before = store.getState();
    store.dispatch({ type: "clearAgentMarks" });
    expect(store.getState()).toBe(before);
  });
});

describe("sending to the marked set", () => {
  it("resolves to the LIVE marked agents, so a broadcast reaches what the chip promises", () => {
    const store = storeWith([
      { agentId: "live", state: "running" },
      { agentId: "finished", state: "done" },
      { agentId: "ghostly", state: "running", shadow: true },
    ]);
    for (const id of ["live", "finished", "ghostly"]) store.dispatch({ type: "toggleAgentMark", agentId: id });
    // A mark on a row that has since finished must not turn a broadcast into a stream of "not
    // running" errors, and a shadow is not independently addressable at all.
    expect(resolveTargetIds(store.getState(), "marked").ids).toEqual(["live"]);
  });

  it("resolves to nothing when nothing is marked, rather than falling back to main", () => {
    const store = storeWith([{ agentId: "a", state: "running" }]);
    const res = resolveTargetIds(store.getState(), "marked");
    expect(res.ids).toEqual([]);
    expect(res.lazyMain).toBe(false);   // never silently redirect a broadcast at the conductor
  });
});

describe("batch operations over the marked set", () => {
  let calls: Array<{ method: string; params: unknown }>;
  let store: UiStore;

  // createAgentCommands, not agentCommands: the latter is a SINGLETON that keeps the first
  // store it ever saw, so every case after the first would silently assert against a stale one.
  const commandsWith = (reply: (method: string) => unknown) => {
    calls = [];
    return createAgentCommands(store, async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return reply(method) as never;
    });
  };

  beforeEach(() => {
    store = storeWith([{ agentId: "a", state: "running" }, { agentId: "b", state: "running" }]);
    for (const id of ["a", "b"]) store.dispatch({ type: "toggleAgentMark", agentId: id });
  });

  it("kills every marked agent and then clears the marks", async () => {
    // After a kill the rows are gone, so keeping them ticked leaves a selection pointing at
    // nothing — the next batch would act on ids that no longer exist.
    const cmds = commandsWith(() => ({ requested: 2, succeeded: ["a", "b"], failed: [] }));
    await cmds.runOnMarked("kill");
    expect(calls[0]).toMatchObject({ method: "agent.killMany", params: { agentIds: ["a", "b"] } });
    expect(store.getState().markedAgentIds).toEqual([]);
  });

  it("KEEPS the marks after a hold, because the same set is usually wanted again", async () => {
    const cmds = commandsWith(() => ({ held: ["a", "b"], skipped: [] }));
    await cmds.runOnMarked("hold");
    expect(store.getState().markedAgentIds).toEqual(["a", "b"]);
  });

  it("reads hold's OWN result shape — the mismatch that would have reported '0 agents'", async () => {
    // killMany/resumeMany answer {succeeded, failed}; hold and release, which predate them, answer
    // {held|released, skipped}. Reading only the first shape made a working hold report doing
    // nothing, which is worse than an error because it invites the operator to do it again.
    const cmds = commandsWith(() => ({ held: ["a", "b"], skipped: [] }));
    await cmds.runOnMarked("hold");
    expect(store.getState().notice).toContain("held 2");
  });

  it("reports a PARTIAL result with the reason, not just a count", async () => {
    // Partial success is the normal outcome of a fan-out. "1 failed" sends the operator hunting;
    // the daemon already knows why, so say it.
    const cmds = commandsWith(() => ({ requested: 2, succeeded: ["a"], failed: [{ agentId: "b", error: "agent b is running, not terminal" }] }));
    await cmds.runOnMarked("resume");
    const note = store.getState().notice ?? "";
    expect(note).toContain("resumed 1");
    expect(note).toContain("not terminal");
  });

  it("resumes with a default brief when none is given, and the operator's when one is", async () => {
    const cmds = commandsWith(() => ({ requested: 2, succeeded: ["a", "b"], failed: [] }));
    await cmds.runOnMarked("resume");
    expect((calls[0]!.params as { prompt: string }).prompt).toBe("Continue where you left off.");
    await cmds.runOnMarked("resume", "  pick up the refactor  ");
    expect((calls[1]!.params as { prompt: string }).prompt).toBe("pick up the refactor");
  });

  it("refuses to fan out over an empty set instead of calling the daemon", async () => {
    store.dispatch({ type: "clearAgentMarks" });
    const cmds = commandsWith(() => ({}));
    await cmds.runOnMarked("kill");
    expect(calls).toEqual([]);
    expect(store.getState().notice).toContain("nothing marked");
  });
});

// Two bugs the operator hit within a minute of the feature shipping.
describe("resume means CARRY ON, whichever way the agent stopped", () => {
  it("RELEASES a paused agent instead of trying to respawn it", async () => {
    // Reported verbatim: "note: resume failed: agent ... is paused, not terminal — interrupt or
    // kill it before resuming". A held agent still has its process and its turn; the way to
    // continue it is to lift the hold. Sending it down the respawn path produced a refusal that
    // told the operator to DESTROY the thing they had just asked to continue.
    const store = storeWith([{ agentId: "held", state: "paused" }]);
    const calls: Array<{ method: string; params: unknown }> = [];
    const cmds = createAgentCommands(store, async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return { released: ["held"], skipped: [] } as never;
    });
    await cmds.releaseAgent("held");
    expect(calls[0]).toMatchObject({ method: "agent.release", params: { agentIds: ["held"] } });
  });

  it("respawns a TERMINAL agent into its own session", async () => {
    const store = storeWith([{ agentId: "dead", state: "done" }]);
    const calls: Array<{ method: string; params: unknown }> = [];
    const cmds = createAgentCommands(store, async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return {} as never;
    });
    await cmds.resumeAgent("dead", "carry on");
    expect(calls[0]).toMatchObject({ method: "agent.resume", params: { agentId: "dead", prompt: "carry on" } });
  });
});

