import { describe, expect, it, vi } from "vitest";
import { emptyAgent, initialState, reduce, type Action, type UiState, type UiStore } from "@chimera/ui-state";
import { BLOCKED_TASK_ASSIGNMENT, CommandRegistry, entitiesFromState, executePaletteResult, keymapCommands, mergeEntities, searchDaemonEntities, searchPalette, validateArguments } from "../src/state/commands.palette";

function store(): UiStore & { state: UiState } {
  let state = initialState;
  return { getState: () => state, dispatch: (a: Action) => { state = reduce(state, a); }, subscribe: () => () => {}, connectAndLoad: async () => {}, get state() { return state; } };
}

describe("universal command registry", () => {
  it("rejects duplicate ids and indexes every warm ui-state domain", () => {
    const registry = new CommandRegistry();
    registry.register({ id: "open", name: "Open", description: "open", category: "global" });
    expect(() => registry.register({ id: "open", name: "Again", description: "duplicate", category: "global" })).toThrow("duplicate command id");
    const state: UiState = { ...initialState, agents: { a1: emptyAgent("a1") }, agentOrder: ["a1"], teams: { available: true, items: [{ name: "ui" }] }, queues: { available: true, items: [{ name: "q" }] }, tasks: { t1: { taskId: "t1", queue: "q", state: "blocked", agentId: null, attempts: 0, priority: 1, subject: "task", updatedAt: 1 } }, events: [{ seq: 7, ts: 1, agentId: "a1", kind: "status", data: {} }], memory: { query: "", items: [{ id: "m1", text: "decision" } as never], mode: "hybrid", folder: { kind: "all" } } };
    expect(new Set(entitiesFromState(state).map((e) => e.kind))).toEqual(new Set(["agent", "team", "queue", "task", "event", "memory"]));
  });

  it("caps event entities at the most recent 200 instead of scaling with the full 5000-entry ring", () => {
    const events = Array.from({ length: 6000 }, (_, i) => ({ seq: i, ts: i, agentId: "a1", kind: "status", data: {} }));
    const state: UiState = { ...initialState, events };
    const eventEntities = entitiesFromState(state).filter((e) => e.kind === "event");
    expect(eventEntities).toHaveLength(200);
    // newest (highest seq) kept, not the oldest
    expect(eventEntities.map((e) => e.id)).toEqual(events.slice(-200).map((e) => String(e.seq)));
  });

  it("ranks exact ids, filters modes, and explains contextual unavailability", () => {
    const registry = new CommandRegistry();
    for (const command of keymapCommands([{ chord: "ctrl+k", action: "agents.kill", scope: "agents", label: "kill" }])) registry.register(command);
    const entities = [{ kind: "task" as const, id: "task-123", name: "Build palette", description: "blocked", deepLink: { kind: "task" as const, taskId: "task-123" } }];
    const context = { state: { ...initialState, activeTab: "queues" as const }, hasHandler: () => false };
    const exact = searchPalette({ query: "task-123", mode: "all", registry, entities, context });
    expect(exact[0]?.kind).toBe("entity");
    const commands = searchPalette({ query: "kill", mode: "commands", registry, entities, context });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.availability).toEqual({ available: false, reason: "available on agents" });
    expect(searchPalette({ query: "kill", mode: "entities", registry, entities, context })).toEqual([]);
  });

  it("fans out daemon search, tolerates a failed domain, and deduplicates", async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === "artifact.list") throw new Error("offline");
      if (method === "project.list") return [{ name: "chimera", path: "/code/chimera" }];
      if (method === "workflow.list") return [{ name: "qa", version: 3 }];
      return [];
    });
    const found = await searchDaemonEntities(rpc, "chi");
    expect(found.map((e) => `${e.kind}:${e.id}`)).toEqual(expect.arrayContaining(["project:chimera", "workflow:qa"]));
    expect(mergeEntities(found, found)).toHaveLength(found.length);
  });

  it("validates typed args, dispatches deep links, and keeps unsupported bulk assignment disabled", async () => {
    expect(validateArguments(BLOCKED_TASK_ASSIGNMENT, {})).toBe("Blocked tasks is required");
    expect(BLOCKED_TASK_ASSIGNMENT.availability?.({ state: initialState })).toEqual({ available: false, reason: "Task assignment is not supported by the daemon yet" });
    const registry = new CommandRegistry();
    const entity = { kind: "queue" as const, id: "features", name: "features", description: "queue", deepLink: { kind: "queue" as const, name: "features" } };
    const result = searchPalette({ query: "features", mode: "entities", registry, entities: [entity], context: { state: initialState } })[0]!;
    const s = store();
    await executePaletteResult(result, {}, { state: s.state }, s);
    expect(s.state.activeTab).toBe("queues");
    expect(s.state.navigation.target).toEqual(entity.deepLink);
  });
});
