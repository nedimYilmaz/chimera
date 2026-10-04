import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type ChimeraApi } from "@chimera/ui-state";
import { createProjectsCommands, createProjectsLocal } from "../src/state/commands.projects";

// W7 gate (app unit tests): the projects command layer against the REAL shared
// store + a fresh local store with a scripted request — proves the import
// inline+toast error contract, the archive conflict toast, the `r` run-team
// mechanism (queue.push per role with cwd/isolation overrides vs direct spawns
// for a queueless team) and the plugins catalog/toggle cadence.

function harness(auto: Record<string, unknown | ((params: unknown) => unknown)> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const api: ChimeraApi = {
    request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method in auto) {
        const v = auto[method];
        const out = typeof v === "function" ? (v as (p: unknown) => unknown)(params) : v;
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out as T);
      }
      return Promise.resolve([] as unknown as T);
    },
    subscribe: () => Promise.resolve(() => {}),
  };
  const store = createStore(api);
  const local = createProjectsLocal();
  const commands = createProjectsCommands(local, store, api.request);
  return { store, local, commands, calls };
}

describe("search query — cursor stays honest against the filtered list", () => {
  it("setQuery stores the query and resets the cursor to the top", async () => {
    const { local, commands } = harness();
    local.set({ cursor: 3 });
    commands.setQuery("widg");
    expect(local.getState()).toMatchObject({ query: "widg", cursor: 0 });
  });

  it("loadProjects clamps the cursor against the FILTERED count, not the raw list", async () => {
    const { local, commands } = harness({
      "project.list": [
        { name: "chimera", path: "/code/chimera", teams: [], sessions: 0, archived: false },
        { name: "widgets", path: "/code/widgets", teams: [], sessions: 0, archived: false },
        { name: "widget-lib", path: "/code/widget-lib", teams: [], sessions: 0, archived: false },
      ],
    });
    local.set({ query: "widget", cursor: 5 });
    await commands.loadProjects();
    // 5 raw items would clamp to 2, but only 2 rows match "widget" — cursor
    // must never point past the last VISIBLE row.
    expect(local.getState().cursor).toBe(1);
  });
});

describe("project.import error contract", () => {
  it("REJECTS (inline form error) AND raises the commandError toast", async () => {
    const { store, commands } = harness({ "project.import": Object.assign(new Error("git clone failed: fatal: repo not found"), { code: "git" }) });
    await expect(commands.importProject({ source: "git@nope:x/y.git", name: "", team: "" })).rejects.toThrow(/clone failed/);
    expect(store.getState().lastError).toMatch(/clone failed/);
  });

  it("reloads the list after a successful import", async () => {
    const { local, commands, calls } = harness({
      "project.import": { name: "x", path: "/tmp/x" },
      "project.list": [{ name: "x", path: "/tmp/x", teams: [], sessions: 0, archived: false }],
    });
    await commands.importProject({ source: "/tmp/x", name: "", team: "" });
    expect(calls.map((c) => c.method)).toEqual(["project.import", "project.list"]);
    expect(local.getState().items.map((p) => p.name)).toEqual(["x"]);
  });

  // PROJECT-DEFAULT-DIR: an empty source routes to project.create (no `path` —
  // the daemon defaults it under the configured import dir), never project.import.
  it("an empty source routes to project.create with no path, and reloads the list", async () => {
    const { local, commands, calls } = harness({
      "project.create": { name: "blank-proj", path: "/home/projects/blank-proj" },
      "project.list": [{ name: "blank-proj", path: "/home/projects/blank-proj", teams: [], sessions: 0, archived: false }],
    });
    await commands.importProject({ source: "", name: "blank-proj", team: "crew" });
    expect(calls.map((c) => c.method)).toEqual(["project.create", "project.list"]);
    expect(calls[0]?.params).toEqual({ name: "blank-proj", teams: ["crew"] });
    expect(local.getState().items.map((p) => p.name)).toEqual(["blank-proj"]);
  });
});

// NEW-PROJECT-CONDUCTOR-WINDOW: a freshly-created project eager-spawns its
// auto-conductor server-side, so project.create/import returns a spec carrying
// its conductorId. Creating a project must drop the user straight into that
// conductor's transcript on the Agents tab — otherwise the Agents tab is empty
// of any window to type into (the user-reported bug).
describe("NEW-PROJECT-CONDUCTOR-WINDOW: creating a project opens its conductor", () => {
  it("focuses the returned conductorId on the Agents tab after create", async () => {
    const { store, commands } = harness({
      "project.create": { name: "blank-proj", path: "/home/projects/blank-proj", conductorId: "cond-123" },
      "project.list": [{ name: "blank-proj", path: "/home/projects/blank-proj", teams: [], sessions: 0, archived: false }],
    });
    await commands.importProject({ source: "", name: "blank-proj", team: "" });
    expect(store.getState().selectedAgentId).toBe("cond-123");
    expect(store.getState().activeTab).toBe("agents");
  });

  it("focuses the returned conductorId after a git import too", async () => {
    const { store, commands } = harness({
      "project.import": { name: "x", path: "/tmp/x", conductorId: "cond-xyz" },
      "project.list": [{ name: "x", path: "/tmp/x", teams: [], sessions: 0, archived: false }],
    });
    await commands.importProject({ source: "/tmp/x", name: "", team: "" });
    expect(store.getState().selectedAgentId).toBe("cond-xyz");
    expect(store.getState().activeTab).toBe("agents");
  });

  it("does NOT navigate when the project has no conductor (autoConductor:false ⇒ conductorId null)", async () => {
    const { store, commands } = harness({
      "project.create": { name: "manual", path: "/home/projects/manual", conductorId: null },
      "project.list": [{ name: "manual", path: "/home/projects/manual", teams: [], sessions: 0, archived: false }],
    });
    const tabBefore = store.getState().activeTab;
    await commands.importProject({ source: "", name: "manual", team: "" });
    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().activeTab).toBe(tabBefore);
  });
});

describe("loadImportDirHint", () => {
  it("fetches config.projectImportDir into the local store, best-effort on failure", async () => {
    const { local, commands } = harness({ "config.get": { projectImportDir: "/configured/dir" } });
    await commands.loadImportDirHint();
    expect(local.getState().importDirHint).toBe("/configured/dir");
  });

  it("a failed fetch leaves the hint untouched instead of throwing", async () => {
    const { local, commands } = harness({ "config.get": new Error("boom") });
    await expect(commands.loadImportDirHint()).resolves.toBeUndefined();
    expect(local.getState().importDirHint).toBe(null);
  });
});

describe("project.archive conflict refusal", () => {
  it("surfaces the daemon's {code:'conflict'} refusal as the error toast (guarded, no crash)", async () => {
    const { store, commands } = harness({
      "project.archive": Object.assign(new Error('project "x" has 2 live session(s)'), { code: "conflict" }),
    });
    await commands.archiveProject("x");
    expect(store.getState().lastError).toMatch(/live session/);
  });
});

describe("PROJECT-DELETE-UI: deleteProject", () => {
  it("registration-only delete omits deleteFiles from the RPC params", async () => {
    const { local, commands, calls } = harness({
      "project.delete": { deleted: true },
      "project.list": [],
    });
    local.set({ confirmDelete: "x", confirmDeleteFiles: false, deleteError: "stale" });
    await commands.deleteProject("x", false);
    expect(calls.find((c) => c.method === "project.delete")?.params).toEqual({ name: "x" });
    // success clears the confirm gate + any stale inline error
    expect(local.getState()).toMatchObject({ confirmDelete: null, confirmDeleteFiles: false, deleteError: null });
  });

  it("deleteFiles:true rides the RPC params only when the toggle is on", async () => {
    const { commands, calls } = harness({ "project.delete": { deleted: true }, "project.list": [] });
    await commands.deleteProject("x", true);
    expect(calls.find((c) => c.method === "project.delete")?.params).toEqual({ name: "x", deleteFiles: true });
  });

  it("clears the open detail pane when the deleted project was drilled into", async () => {
    const { local, commands } = harness({
      "project.status": { spec: { name: "x", path: "/repo/x", teams: [] }, sessions: [], teams: [] },
      "project.delete": { deleted: true },
      "project.list": [],
    });
    await commands.openDetail("x");
    expect(local.getState().detail).not.toBeNull();
    await commands.deleteProject("x", false);
    expect(local.getState().detail).toBeNull();
  });

  it("on {code:'conflict'} sets the INLINE deleteError (dialog stays open) AND the error toast — never retries", async () => {
    const { store, local, commands, calls } = harness({
      "project.delete": Object.assign(new Error('project "x" has 1 live session(s) under /repo/x — kill or finish them before deleting'), { code: "conflict" }),
    });
    local.set({ confirmDelete: "x", confirmDeleteFiles: false });
    await commands.deleteProject("x", false);
    expect(local.getState().confirmDelete).toBe("x");   // dialog stays open
    expect(local.getState().deleteError).toMatch(/live session/);
    expect(store.getState().lastError).toMatch(/live session/);
    expect(calls.filter((c) => c.method === "project.delete")).toHaveLength(1);   // no retry
  });

  // DOUBLE-SUBMIT-SWEEP: unlike archiveProject/dissolveTeam/etc, deleteProject
  // deliberately keeps confirmDelete non-null (dialog mounted, ConfirmCard's
  // confirm chip still clickable) for the WHOLE round-trip on a refusal, so
  // confirmDelete's presence can't double as the re-entrancy guard here —
  // nothing blocked a second confirm click from firing project.delete again
  // while the first was still in flight. `deleting` is the added guard.
  it("a second call while the first delete is still in flight does not fire project.delete twice", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let resolveDelete!: (v: unknown) => void;
    const pendingDelete = new Promise((r) => { resolveDelete = r; });
    const api: ChimeraApi = {
      request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "project.delete") return pendingDelete as Promise<T>;
        return Promise.resolve([] as unknown as T);
      },
      subscribe: () => Promise.resolve(() => {}),
    };
    const store = createStore(api);
    const local = createProjectsLocal();
    const commands = createProjectsCommands(local, store, api.request);
    local.set({ confirmDelete: "x", confirmDeleteFiles: false });

    const first = commands.deleteProject("x", false);
    expect(local.getState().deleting).toBe(true);
    const second = commands.deleteProject("x", false); // re-entrant, as a rapid double-click would trigger
    expect(calls.filter((c) => c.method === "project.delete")).toHaveLength(1); // still 1 — the guard must block it

    resolveDelete({ deleted: true });
    await Promise.all([first, second]);
    expect(local.getState()).toMatchObject({ deleting: false, confirmDelete: null });
  });
});

describe("PROJTEAM-T7: setLoadProjectSettings toggle", () => {
  it("writes the toggle via project.setLoadProjectSettings and refreshes the open drill", async () => {
    const { local, commands, calls } = harness({
      "project.status": {
        spec: { name: "alpha", path: "/repo/alpha", teams: [], loadProjectSettings: false },
        sessions: [], teams: [],
      },
      "project.list": [{ name: "alpha", path: "/repo/alpha", teams: [], sessions: 0, archived: false }],
    });
    await commands.openDetail("alpha");
    await commands.setLoadProjectSettings("alpha", false);
    expect(calls.map((c) => c.method)).toContain("project.setLoadProjectSettings");
    expect(calls.find((c) => c.method === "project.setLoadProjectSettings")?.params).toEqual({ project: "alpha", value: false });
    expect(local.getState().detail?.spec["loadProjectSettings"]).toBe(false);
  });

  it("surfaces a daemon refusal as the error toast (guarded, no crash)", async () => {
    const { store, commands } = harness({
      "project.setLoadProjectSettings": Object.assign(new Error('unknown project "ghost"'), { code: "protocol" }),
    });
    await commands.setLoadProjectSettings("ghost", true);
    expect(store.getState().lastError).toMatch(/unknown project/);
  });
});

describe("F26: setSetupHook", () => {
  it("writes the hook via project.setSetupHook and refreshes the open drill", async () => {
    const { local, commands, calls } = harness({
      "project.status": {
        spec: { name: "alpha", path: "/repo/alpha", teams: [], worktreeSetup: { command: "npm i", timeoutSec: 120, enabled: true } },
        sessions: [], teams: [],
      },
      "project.list": [{ name: "alpha", path: "/repo/alpha", teams: [], sessions: 0, archived: false }],
    });
    await commands.openDetail("alpha");
    await commands.setSetupHook("alpha", { command: "npm i", timeoutSec: 120, enabled: true });
    expect(calls.find((c) => c.method === "project.setSetupHook")?.params).toEqual({
      project: "alpha",
      hook: { command: "npm i", timeoutSec: 120, enabled: true },
    });
    expect(local.getState().detail?.spec["worktreeSetup"]).toEqual({ command: "npm i", timeoutSec: 120, enabled: true });
  });

  it("clears the hook by passing null", async () => {
    const { commands, calls } = harness({
      "project.status": { spec: { name: "alpha", path: "/repo/alpha", teams: [], worktreeSetup: null }, sessions: [], teams: [] },
      "project.list": [{ name: "alpha", path: "/repo/alpha", teams: [], sessions: 0, archived: false }],
    });
    await commands.setSetupHook("alpha", null);
    expect(calls.find((c) => c.method === "project.setSetupHook")?.params).toEqual({ project: "alpha", hook: null });
  });

  it("surfaces a daemon refusal as the error toast (guarded, no crash)", async () => {
    const { store, commands } = harness({
      "project.setSetupHook": Object.assign(new Error('unknown project "ghost"'), { code: "protocol" }),
    });
    await commands.setSetupHook("ghost", null);
    expect(store.getState().lastError).toMatch(/unknown project/);
  });
});

describe("`r` — run the assigned team in this project", () => {
  const detail = (teams: string[]) => ({
    spec: { name: "proj", path: "/repo/proj", teams, queue: null },
    sessions: [],
    teams: teams.map((name) => ({ name, running: 0 })),
    queuePending: null,
    checkpoints: null,
    files: { dirs: {}, selected: null },
  });

  it("team WITH a queue → one queue.push per role with overrides {cwd: project path, isolation none}", async () => {
    const { local, commands, calls } = harness({
      "team.list": [{ name: "crew", queue: "bugfix", roles: { dev: { cwd: "/elsewhere" }, reviewer: { cwd: "/elsewhere" } } }],
      "project.list": [],
      "project.status": { spec: detail(["crew"]).spec, sessions: [], teams: [] },
    });
    local.set({ detail: detail(["crew"]) });
    await commands.runTeam();
    const pushes = calls.filter((c) => c.method === "queue.push");
    expect(pushes).toHaveLength(2);
    for (const p of pushes) {
      expect(p.params).toMatchObject({ queue: "bugfix", overrides: { cwd: "/repo/proj", isolation: "none" }, pushedBy: "app" });
    }
    expect(pushes.map((p) => (p.params as { role: string }).role).sort()).toEqual(["dev", "reviewer"]);
    expect(calls.some((c) => c.method === "agent.spawn")).toBe(false);
  });

  it("team WITHOUT a queue → direct agent.spawn per role, cwd=project path, scheduling fields stripped", async () => {
    const { local, commands, calls } = harness({
      "team.list": [{ name: "crew", queue: null, roles: { dev: { cwd: "/elsewhere", poolSize: 2, persistent: true, model: "m1" } } }],
      "project.list": [],
      "project.status": { spec: detail(["crew"]).spec, sessions: [], teams: [] },
    });
    local.set({ detail: detail(["crew"]) });
    await commands.runTeam();
    const spawns = calls.filter((c) => c.method === "agent.spawn");
    expect(spawns).toHaveLength(1);
    const spec = (spawns[0]!.params as { spec: Record<string, unknown> }).spec;
    expect(spec).toMatchObject({ cwd: "/repo/proj", isolation: "none", model: "m1" });
    expect(spec["poolSize"]).toBeUndefined();
    expect(spec["persistent"]).toBeUndefined();
    expect(typeof spec["prompt"]).toBe("string");
  });

  it("no assigned team → error toast, no daemon calls", async () => {
    const { store, local, commands, calls } = harness();
    local.set({ detail: detail([]) });
    await commands.runTeam();
    expect(store.getState().lastError).toMatch(/no assigned team/);
    expect(calls.filter((c) => c.method !== "project.list")).toEqual([]);
  });
});

describe("P3-T4 — openDetail fetches THIS project's checkpoints, independent of agent selection", () => {
  it("a git project path populates detail.checkpoints from checkpoint.status/list", async () => {
    const { local, commands, calls } = harness({
      "project.status": { spec: { name: "proj", path: "/repo/proj", teams: [], queue: null }, sessions: [], teams: [] },
      "checkpoint.status": (params: unknown) => {
        expect(params).toEqual({ cwd: "/repo/proj" });
        return { supported: true, cwd: "/repo/proj", count: 1 };
      },
      "checkpoint.list": (params: unknown) => {
        expect(params).toEqual({ cwd: "/repo/proj" });
        return [{ id: "1", ref: "refs/chimera/checkpoints/1", trigger: "manual", ts: 1000, agentId: "a1", taskId: null, message: "chimera checkpoint: manual" }];
      },
    });
    await commands.openDetail("proj");
    expect(local.getState().detail?.checkpoints).toEqual([
      { id: "1", ref: "refs/chimera/checkpoints/1", trigger: "manual", ts: 1000, message: "chimera checkpoint: manual" },
    ]);
    expect(calls.map((c) => c.method)).toContain("checkpoint.list");
  });

  it("a non-git project path (supported:false) leaves detail.checkpoints null and never calls checkpoint.list", async () => {
    const { local, commands, calls } = harness({
      "project.status": { spec: { name: "proj", path: "/repo/proj", teams: [], queue: null }, sessions: [], teams: [] },
      "checkpoint.status": { supported: false, cwd: "/repo/proj" },
    });
    await commands.openDetail("proj");
    expect(local.getState().detail?.checkpoints).toBeNull();
    expect(calls.some((c) => c.method === "checkpoint.list")).toBe(false);
  });

  it("a failed checkpoint.status degrades to detail.checkpoints:null rather than breaking the drill", async () => {
    const { local, commands } = harness({
      "project.status": { spec: { name: "proj", path: "/repo/proj", teams: [], queue: null }, sessions: [], teams: [] },
      "checkpoint.status": Object.assign(new Error("git error"), {}),
    });
    await commands.openDetail("proj");
    expect(local.getState().detail?.checkpoints).toBeNull();
    expect(local.getState().detail?.spec["name"]).toBe("proj");
  });
});

describe("plugins catalog + toggle", () => {
  it("loadPluginCatalog feeds the card rows AND the slash-popup command cache for the selected agent", async () => {
    const { store, local, commands, calls } = harness({
      "agent.status": { agentId: "a1", spec: { cwd: "/repo/proj" } },
      "plugins.list": [
        { id: "skill:s", kind: "skill", name: "s", source: "/sk", enabled: true },
        { id: "command:deploy", kind: "command", name: "deploy", source: ".claude/commands/deploy.md", enabled: true },
      ],
    });
    store.dispatch({ type: "selectAgent", agentId: "a1" });
    local.set({ items: [{ name: "proj", path: "/repo/proj", origin: null, teams: [], queue: null, sessions: 0, archived: false }] });
    await commands.loadPluginCatalog();
    expect(calls.find((c) => c.method === "plugins.list")!.params).toEqual({ cwd: "/repo/proj" });
    const s = local.getState();
    expect(s.pluginCatalog.map((r) => r.id)).toEqual(["skill:s", "command:deploy"]);
    expect(s.pluginCatalog[1]!.scope).toBe("proje · proj");   // cwd matched the registered project
    expect(s.commandsForAgent).toMatchObject({ agentId: "a1" });
    expect(s.commandsForAgent!.rows.map((r) => r.name)).toEqual(["deploy"]);
  });

  it("togglePlugin patches both the card rows and the popup cache from the RPC reply", async () => {
    const { local, commands } = harness({ "plugins.toggle": { id: "command:deploy", enabled: false } });
    const row = { id: "command:deploy", kind: "command", name: "deploy", scope: "proje · p", source: "x", enabled: true };
    local.set({ pluginCatalog: [row], commandsForAgent: { agentId: "a1", rows: [row] } });
    await commands.togglePlugin("command:deploy", false);
    expect(local.getState().pluginCatalog[0]!.enabled).toBe(false);
    expect(local.getState().commandsForAgent!.rows[0]!.enabled).toBe(false);
  });
});


describe("FILEBROWSER-T5 — files panel (fs.list/fs.read over the projections store)", () => {
  const projectStatus = { spec: { name: "proj", path: "/repo/proj", teams: [], queue: null }, sessions: [], teams: [] };

  describe("FILEBROWSER-T9: refreshDebounced collapses a burst of events into one refresh", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("a rapid-fire burst produces exactly ONE project.list, ~300ms after the LAST call", async () => {
      const { local, commands, calls } = harness({
        "project.status": projectStatus,
        "fs.list": { path: "", entries: [], truncated: false },
      });
      await commands.openDetail("proj");
      calls.length = 0;

      commands.refreshDebounced();
      vi.advanceTimersByTime(200);
      commands.refreshDebounced(); // resets the timer — the first call must NOT fire
      vi.advanceTimersByTime(200);
      commands.refreshDebounced(); // resets again
      vi.advanceTimersByTime(200);
      expect(calls.filter((c) => c.method === "project.list")).toHaveLength(0);

      vi.advanceTimersByTime(100); // 300ms since the LAST call — now it fires
      await vi.runOnlyPendingTimersAsync();
      expect(calls.filter((c) => c.method === "project.list")).toHaveLength(1);
      expect(local.getState().items).toBeDefined();
    });
  });

  it("selecting a project (openDetail) populates the root file listing", async () => {
    const { local, commands } = harness({
      "project.status": projectStatus,
      "fs.list": (params: unknown) => {
        expect(params).toEqual({ project: "proj", path: "" });
        return { path: "", entries: [{ name: "src", kind: "dir", sizeBytes: null, gitStatus: null }], truncated: false };
      },
    });
    await commands.openDetail("proj");
    expect(local.getState().detail?.files.dirs[""]).toEqual({
      status: "ok",
      entries: [{ name: "src", kind: "dir", sizeBytes: null, gitStatus: null }],
      truncated: false,
    });
  });

  it("expandDir lazily fetches a dir only on its FIRST expand, never again once cached", async () => {
    const { local, commands, calls } = harness({
      "project.status": projectStatus,
      "fs.list": (params: unknown) => ({ path: (params as { path: string }).path, entries: [], truncated: false }),
    });
    await commands.openDetail("proj");
    await commands.expandDir("src");
    await commands.expandDir("src");
    expect(calls.filter((c) => c.method === "fs.list" && (c.params as { path: string }).path === "src")).toHaveLength(1);
    expect(local.getState().detail?.files.dirs["src"]).toEqual({ status: "ok", entries: [], truncated: false });
  });

  it("refresh re-lists every previously-expanded dir, not just the root", async () => {
    const { local, commands, calls } = harness({
      "project.status": projectStatus,
      "fs.list": (params: unknown) => ({ path: (params as { path: string }).path, entries: [], truncated: false }),
    });
    await commands.openDetail("proj");
    await commands.expandDir("src");
    calls.length = 0;
    await commands.refresh();
    const paths = calls.filter((c) => c.method === "fs.list").map((c) => (c.params as { path: string }).path).sort();
    expect(paths).toEqual(["", "src"]);
  });

  it("a fs.list failure degrades that ONE dir to an inline error state — never throws", async () => {
    const { local, commands } = harness({
      "project.status": projectStatus,
      "fs.list": (params: unknown) => {
        const p = (params as { path: string }).path;
        if (p === "bad") return new Error("fs.list refused: outside project root");
        return { path: p, entries: [], truncated: false };
      },
    });
    await commands.openDetail("proj");
    await expect(commands.expandDir("bad")).resolves.toBeUndefined();
    expect(local.getState().detail?.files.dirs["bad"]).toEqual({ status: "error", message: "fs.list refused: outside project root" });
  });

  it("selectFile drives the viewer on success and sets an inline error on failure; closeFile clears it", async () => {
    const { local, commands } = harness({
      "project.status": projectStatus,
      "fs.list": { path: "", entries: [], truncated: false },
      "fs.read": (params: unknown) => {
        const p = (params as { path: string }).path;
        if (p === "missing.ts") return new Error("ENOENT");
        return { path: p, encoding: "utf8", content: "hello", sizeBytes: 5, binary: false, mediaType: "text/plain", truncated: false };
      },
    });
    await commands.openDetail("proj");
    await commands.selectFile("a.ts");
    expect(local.getState().detail?.files.selected).toEqual({
      path: "a.ts",
      status: "ok",
      result: { path: "a.ts", encoding: "utf8", content: "hello", sizeBytes: 5, binary: false, mediaType: "text/plain", truncated: false },
    });

    await commands.selectFile("missing.ts");
    expect(local.getState().detail?.files.selected).toEqual({ path: "missing.ts", status: "error", message: "ENOENT" });

    commands.closeFile();
    expect(local.getState().detail?.files.selected).toBeNull();
  });
});
