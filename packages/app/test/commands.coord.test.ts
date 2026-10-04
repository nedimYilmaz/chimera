import { describe, expect, it } from "vitest";
import { createStore, type ChimeraApi, type MemoryHit } from "@chimera/ui-state";
import { createCoordCommands, type MemoryIndexView } from "../src/state/commands.coord";

// W5 gate (a): the coordination command layer against the REAL shared store
// (createStore + reducer) with a scripted request — proves the memory
// out-of-order seq guard, the Phase-1 unknown-method classification, the
// mutation→refresh cadence, and the error channels (guarded vs rethrow).

type Pending = { method: string; params: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };

function harness(auto: Record<string, unknown> = {}) {
  const pending: Pending[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  const api: ChimeraApi = {
    request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method in auto) {
        const v = auto[method];
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(v as T);
      }
      return new Promise<T>((resolve, reject) =>
        pending.push({ method, params, resolve: resolve as (v: unknown) => void, reject }),
      );
    },
    subscribe: () => Promise.resolve(() => {}),
  };
  const store = createStore(api);
  const coord = createCoordCommands(store, api.request);
  return { store, coord, pending, calls };
}

const hit = (id: string, text: string): MemoryHit =>
  ({ record: { id, author: "a", text, tags: [], kind: "note", treeId: null, taskId: null, createdAt: 1, updatedAt: 1 }, score: 0 });

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("memory search seq guard (TUI memorySearchSeq port)", () => {
  it("drops a stale reply that resolves AFTER a newer search", async () => {
    const { store, coord, pending } = harness();
    const p1 = coord.memorySearch({ query: "old" });
    const p2 = coord.memorySearch({ query: "new" });
    expect(pending.map((p) => p.method)).toEqual(["memory.search", "memory.search"]);
    // newer reply lands first…
    pending[1]!.resolve([hit("n", "new-note")]);
    await flush();
    expect(store.getState().memory.items.map((h) => h.record.id)).toEqual(["n"]);
    // …then the STALE reply arrives: it must NOT clobber the newer result
    pending[0]!.resolve([hit("o", "old-note")]);
    await Promise.all([p1, p2]);
    expect(store.getState().memory.items.map((h) => h.record.id)).toEqual(["n"]);
  });
  it("commits in-order replies normally and drops empty queries from params", async () => {
    const { store, coord, calls } = harness({ "memory.search": [hit("x", "x")] });
    await coord.memorySearch({ query: "  " });
    expect(calls[0]!.params).toEqual({});
    expect(store.getState().memory.items).toHaveLength(1);
  });
});

describe("Phase-1 tolerance (unknown-method flips available; transient keeps)", () => {
  it("flips teams.available false ONLY on the locked unknown-method error", async () => {
    const { store, coord } = harness({ "team.list": Object.assign(new Error('unknown method "team.list"'), { code: "protocol", message: 'unknown method "team.list"' }) });
    await coord.loadTeams();
    expect(store.getState().teams.available).toBe(false);
  });
  it("keeps previous items on a transient error", async () => {
    const { store, coord, pending } = harness();
    const p = coord.loadTeams();
    pending[0]!.resolve([{ name: "crew" }]);
    await p;
    expect(store.getState().teams.items).toHaveLength(1);
    const p2 = coord.loadTeams();
    pending[1]!.reject(new Error("socket closed"));
    await p2;
    expect(store.getState().teams.items).toHaveLength(1);
    expect(store.getState().teams.available).toBe(true);
  });
});

describe("mutations → refresh cadence", () => {
  it("createTeam rethrows for the inline form error and refreshes on success", async () => {
    const bad = harness({ "team.create": Object.assign(new Error("duplicate team"), { message: "duplicate team" }) });
    await expect(bad.coord.createTeam({ name: "x", roles: { dev: { cwd: "/" } } })).rejects.toThrow("duplicate team");
    const ok = harness({ "team.create": { name: "x" }, "team.list": [{ name: "x" }] });
    await ok.coord.createTeam({ name: "x", roles: { dev: { cwd: "/" } } });
    expect(ok.calls.map((c) => c.method)).toEqual(["team.create", "team.list"]);
    expect(ok.store.getState().teams.items).toEqual([{ name: "x" }]);
  });
  it("pushTask reloads the OPEN queue drill (and only then)", async () => {
    const detail = { spec: { name: "gateq", retryLimit: 2 }, counts: { pending: 1 }, tasks: [] };
    const h = harness({ "queue.status": detail, "queue.push": { taskId: "t1" }, "queue.list": [] });
    await h.coord.openQueueDetail("gateq");
    expect(h.store.getState().queueDetail?.spec["name"]).toBe("gateq");
    await h.coord.pushTask({ queue: "gateq", prompt: "p" });
    expect(h.calls.filter((c) => c.method === "queue.status")).toHaveLength(2); // open + post-push reload
    await h.coord.pushTask({ queue: "otherq", prompt: "p" });
    expect(h.calls.filter((c) => c.method === "queue.status")).toHaveLength(2); // not our open drill
  });
  it("editTask issues queue.editTask and reloads the OPEN queue drill (TASK-EDIT-VERSIONING)", async () => {
    const detail = { spec: { name: "gateq", retryLimit: 2 }, counts: { pending: 1 }, tasks: [] };
    const h = harness({ "queue.status": detail, "queue.editTask": { taskId: "t1", versions: [{ version: 1 }] } });
    await h.coord.openQueueDetail("gateq");
    await h.coord.editTask({ taskId: "t1", queue: "gateq", patch: { prompt: "revised" } });
    const editCall = h.calls.find((c) => c.method === "queue.editTask");
    expect(editCall?.params).toEqual({ taskId: "t1", patch: { prompt: "revised" } }); // no editedBy — UI edit records null
    expect(h.calls.filter((c) => c.method === "queue.status")).toHaveLength(2); // open + post-edit reload
    // an edit for a DIFFERENT (not-open) queue must not reload our drill
    await h.coord.editTask({ taskId: "t9", queue: "otherq", patch: { priority: 1 } });
    expect(h.calls.filter((c) => c.method === "queue.status")).toHaveLength(2);
  });
  it("editTask REJECTS on failure so the inline form error can show (no guard)", async () => {
    const h = harness({ "queue.editTask": Object.assign(new Error("task is in_progress"), { code: "protocol", message: "task is in_progress" }) });
    await expect(h.coord.editTask({ taskId: "t1", queue: "gateq", patch: { prompt: "x" } })).rejects.toThrow("task is in_progress");
    expect(h.store.getState().lastError).toBeNull(); // rethrow only — not the guarded toast channel
  });
  it("cancelTask is guarded: an RPC failure lands in lastError, never throws", async () => {
    const h = harness({ "queue.cancelTask": Object.assign(new Error("unknown task"), { message: "unknown task" }) });
    await h.coord.cancelTask("t-x", "gateq");
    expect(h.store.getState().lastError).toBe("unknown task");
  });
  it("dissolveTeam clears the drill and refreshes the list", async () => {
    const h = harness({
      "team.status": { spec: { name: "crew" }, running: 0, agents: [] },
      "team.dissolve": { ok: true },
      "team.list": [],
    });
    await h.coord.openTeamDetail("crew");
    expect(h.store.getState().teamDetail).not.toBeNull();
    await h.coord.dissolveTeam("crew");
    expect(h.store.getState().teamDetail).toBeNull();
    expect(h.calls.map((c) => c.method)).toContain("team.dissolve");
  });
});

describe("W16 (F15/D11) CRUD mutations", () => {
  it("updateTeam rejects for the inline error AND surfaces a toast; refreshes list+drill on success", async () => {
    const bad = harness({ "team.update": Object.assign(new Error("running members"), { message: "running members" }) });
    await expect(bad.coord.updateTeam("t1", { maxConcurrent: 3 })).rejects.toThrow("running members");
    expect(bad.store.getState().lastError).toBe("running members");

    const ok = harness({
      "team.update": { name: "t1" }, "team.list": [{ name: "t1" }],
      "team.status": { spec: { name: "t1" }, running: 0, agents: [] },
    });
    await ok.coord.openTeamDetail("t1");
    await ok.coord.updateTeam("t1", { maxConcurrent: 3 });
    expect(ok.calls.map((c) => c.method)).toEqual(["team.status", "team.update", "team.list", "team.status"]);
  });

  it("createQueue/updateQueue reject inline on failure and relist on success", async () => {
    const bad = harness({ "queue.create": Object.assign(new Error("duplicate"), { message: "duplicate" }) });
    await expect(bad.coord.createQueue({ name: "q1" })).rejects.toThrow("duplicate");

    const ok = harness({ "queue.create": { name: "q1" }, "queue.list": [{ name: "q1" }] });
    await ok.coord.createQueue({ name: "q1" });
    expect(ok.store.getState().queues.items).toEqual([{ name: "q1" }]);

    const upd = harness({ "queue.update": { name: "q1", retryLimit: 5 }, "queue.list": [{ name: "q1", retryLimit: 5 }] });
    await upd.coord.updateQueue("q1", { retryLimit: 5 });
    expect(upd.calls.map((c) => c.method)).toEqual(["queue.update", "queue.list"]);
  });

  it("deleteQueue rejects + toasts on the engine's pending-tasks guard; clears an open drill on success", async () => {
    const bad = harness({ "queue.delete": Object.assign(new Error("has pending tasks"), { message: "has pending tasks" }) });
    await expect(bad.coord.deleteQueue("q1")).rejects.toThrow("has pending tasks");
    expect(bad.store.getState().lastError).toBe("has pending tasks");

    const ok = harness({
      "queue.status": { spec: { name: "q1" }, counts: {}, tasks: [] },
      "queue.delete": { deleted: true }, "queue.list": [],
    });
    await ok.coord.openQueueDetail("q1");
    expect(ok.store.getState().queueDetail).not.toBeNull();
    await ok.coord.deleteQueue("q1");
    expect(ok.store.getState().queueDetail).toBeNull();
  });

  it("memoryUpdate/memoryDelete reload the current search", async () => {
    const upd = harness({ "memory.update": { id: "m1" }, "memory.search": [hit("m1", "edited")] });
    await upd.coord.memoryUpdate({ id: "m1", text: "edited" });
    expect(upd.store.getState().memory.items.map((h) => h.record.id)).toEqual(["m1"]);

    const del = harness({ "memory.delete": { deleted: true }, "memory.search": [] });
    await del.coord.memoryDelete("m1");
    expect(del.calls.map((c) => c.method)).toEqual(["memory.delete", "memory.search"]);
  });
});

// MEM-5: the search composes the mode chip + folder-rail selection from state,
// and the new stats/get/titles/index commands.
const filedHit = (id: string, folder: string | null): MemoryHit =>
  ({ record: { id, author: "a", title: null, text: id, tags: [], kind: "note", folder, treeId: null, taskId: null, createdAt: 1, updatedAt: 1 } as never, score: 0 });

describe("MEM-5 memory commands (mode + folder + stats/get/titles/index)", () => {
  it("memorySearch folds the state mode + folder into the RPC params", async () => {
    const { store, coord, calls } = harness({ "memory.search": [hit("m1", "n")] });
    store.dispatch({ type: "memoryMode", mode: "lexical" });
    store.dispatch({ type: "memoryFolder", folder: { kind: "folder", path: "ops" } });
    await coord.memorySearch({ query: "retry" });
    expect(calls[0]!.params).toEqual({ query: "retry", mode: "lexical", folder: "ops" });
  });

  it("the 'unfiled' folder post-filters the reply to null-folder records (no folder param)", async () => {
    const { store, coord, calls } = harness({ "memory.search": [filedHit("a", null), filedHit("b", "ops"), filedHit("c", null)] });
    store.dispatch({ type: "memoryFolder", folder: { kind: "unfiled" } });
    await coord.memorySearch({ query: "" });
    expect(calls[0]!.params).toEqual({});                     // no folder param sent
    expect(store.getState().memory.items.map((h) => h.record.id)).toEqual(["a", "c"]);
  });

  it("memoryTitles dedupes (case-insensitive), keeping titled records only", async () => {
    const titled = (id: string, title: string | null): MemoryHit =>
      ({ record: { id, author: "a", title, text: id, tags: [], kind: "note", folder: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 1 } as never, score: 0 });
    const { coord } = harness({ "memory.search": [titled("1", "Alpha"), titled("2", null), titled("3", "alpha"), titled("4", "Beta")] });
    expect(await coord.memoryTitles()).toEqual([{ title: "Alpha", id: "1" }, { title: "Beta", id: "4" }]);
  });

  it("memoryStats + memoryGet pass through the RPC result", async () => {
    const stats = { total: 12, byKind: { note: 12 }, byFolder: [], topTags: [] };
    const got = { record: { id: "m1" }, links: [], backlinks: [] };
    const { coord, calls } = harness({ "memory.stats": stats, "memory.get": got });
    expect(await coord.memoryStats()).toBe(stats);
    expect(await coord.memoryGet("m1")).toBe(got);
    expect(calls.map((c) => c.method)).toEqual(["memory.stats", "memory.get"]);
    expect(calls[1]!.params).toEqual({ id: "m1" });
  });

  it("memoryIndexStatus degrades to null when the daemon lacks memory.index", async () => {
    const { coord } = harness({ "memory.index": new Error("unknown method: memory.index") });
    expect(await coord.memoryIndexStatus()).toBeNull();
  });

  it("memoryIndexRebuild passes the rebuild action and returns the fresh status", async () => {
    const status: MemoryIndexView = { state: "building", embedded: 0, total: 12, pending: 12, degraded: false };
    const { coord, calls } = harness({ "memory.index": status });
    expect(await coord.memoryIndexRebuild()).toBe(status);
    expect(calls).toEqual([{ method: "memory.index", params: { action: "rebuild" } }]);
  });

  // MEMORY-REBUILD-SILENT-FAIL: unlike memoryIndexStatus (a background poll, safe to degrade
  // silently), rebuild is a user-initiated click — swallowing the error to null left the caller
  // with no way to tell the user it failed, so it now rejects and the screen surfaces it.
  it("memoryIndexRebuild rejects when the daemon lacks memory.index", async () => {
    const { coord } = harness({ "memory.index": new Error("unknown method: memory.index") });
    await expect(coord.memoryIndexRebuild()).rejects.toThrow("unknown method: memory.index");
  });

  it("memoryIndexRebuild rejects on any transient error too", async () => {
    const { coord } = harness({ "memory.index": new Error("socket hang up") });
    await expect(coord.memoryIndexRebuild()).rejects.toThrow("socket hang up");
  });
});

describe("openAgent (shared mouse/keyboard path)", () => {
  it("dispatches selectAgent + selectTab agents", () => {
    const { store, coord } = harness();
    coord.openAgent("abc");
    expect(store.getState().selectedAgentId).toBe("abc");
    expect(store.getState().activeTab).toBe("agents");
  });
});
