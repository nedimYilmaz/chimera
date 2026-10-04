import { describe, expect, it } from "vitest";
import { createStore, type ChimeraApi } from "@chimera/ui-state";
import { createJobsCommands, createJobsLocal } from "../src/state/commands.jobs";

// W16 (F15/D11) — the schedules "e" edit chip's command layer: job.status
// fetch-on-demand (getJob) and job.update (updateJob), against the REAL
// jobsLocal store + shared ui-state store with a scripted request (same
// harness shape as commands.coord.test.ts).

type Pending = { method: string; params: unknown; resolve: (v: unknown) => void };

function harness(auto: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const api: ChimeraApi = {
    request: <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method in auto) {
        const v = auto[method];
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(v as T);
      }
      return Promise.reject(new Error(`unscripted method ${method}`));
    },
    subscribe: () => Promise.resolve(() => {}),
  };
  const store = createStore(api);
  const local = createJobsLocal();
  const jobs = createJobsCommands(local, store, api.request);
  return { store, local, jobs, calls };
}

describe("getJob (job.status on-demand fetch)", () => {
  it("returns the raw spec without dispatching to the local store", async () => {
    const raw = { name: "nightly", target: { team: "crew" }, schedule: { cron: "0 3 * * *" }, prompt: "run it", enabled: true };
    const { jobs, calls } = harness({ "job.status": raw });
    const result = await jobs.getJob("nightly");
    expect(result).toEqual(raw);
    expect(calls).toEqual([{ method: "job.status", params: { name: "nightly" } }]);
  });
});

describe("updateJob (job.update, W16/F15 edit chip)", () => {
  it("rejects for the inline error and does NOT reload the list", async () => {
    const { jobs, calls } = harness({ "job.update": Object.assign(new Error("invalid cron"), { message: "invalid cron" }) });
    await expect(jobs.updateJob("nightly", { schedule: { cron: "bogus" } })).rejects.toThrow("invalid cron");
    expect(calls.map((c) => c.method)).toEqual(["job.update"]);
  });
  it("relists on success", async () => {
    const { jobs, local, calls } = harness({
      "job.update": { name: "nightly" },
      "job.list": [{ name: "nightly", enabled: false, target: { team: "crew" }, schedule: { cron: "0 3 * * *" }, prompt: "p" }],
    });
    await jobs.updateJob("nightly", { enabled: false });
    expect(calls.map((c) => c.method)).toEqual(["job.update", "job.list"]);
    expect(local.getState().items).toHaveLength(1);
    expect(local.getState().items[0]).toMatchObject({ name: "nightly", enabled: false });
  });
});

describe("requeueJob (F05: space on a dead-lettered row)", () => {
  it("calls job.requeue then relists", async () => {
    const { jobs, local, calls } = harness({
      "job.requeue": { name: "nightly" },
      "job.list": [{ name: "nightly", enabled: true, target: { team: "crew" }, schedule: { cron: "0 3 * * *" }, prompt: "p" }],
    });
    await jobs.requeueJob("nightly");
    expect(calls).toEqual([
      { method: "job.requeue", params: { name: "nightly" } },
      { method: "job.list", params: {} },
    ]);
    expect(local.getState().items).toHaveLength(1);
    expect(local.getState().items[0]).toMatchObject({ name: "nightly", enabled: true });
  });

  it("surfaces a rejection via commandError, without throwing", async () => {
    const { jobs, store, calls } = harness({ "job.requeue": Object.assign(new Error("not dead-lettered"), { message: "not dead-lettered" }) });
    await jobs.requeueJob("nightly");
    expect(calls.map((c) => c.method)).toEqual(["job.requeue"]);
    expect(store.getState().lastError).toBe("not dead-lettered");
  });
});

describe("loadJobs loading/error state (F05.UI)", () => {
  it("ignores an older response and keeps selection by name when rows reorder", async () => {
    const { local, store } = harness();
    const pending: Array<(value: unknown) => void> = [];
    const jobs = createJobsCommands(local, store, <T,>() => new Promise<T>(resolve => pending.push(value => resolve(value as T))));
    const first = jobs.loadJobs();
    pending.shift()!([{ name: "a" }, { name: "b" }]);
    await first;
    local.set({ cursor: 1 });
    const stale = jobs.loadJobs();
    const latest = jobs.loadJobs();
    pending[1]!([{ name: "b" }, { name: "a" }]);
    await latest;
    pending[0]!([{ name: "obsolete" }]);
    await stale;
    expect(local.getState().items.map(row => row.name)).toEqual(["b", "a"]);
    expect(local.getState().cursor).toBe(0);
  });
  it("starts unloaded so the panel can say loading instead of 'no schedules'", () => {
    const { local } = harness();
    expect(local.getState()).toMatchObject({ loaded: false, listError: null, items: [] });
  });

  it("marks loaded with no error on success", async () => {
    const { jobs, local } = harness({ "job.list": [] });
    await jobs.loadJobs();
    expect(local.getState()).toMatchObject({ loaded: true, listError: null });
  });

  it("keeps the reason and still flips loaded on failure, so the panel never hangs", async () => {
    const { jobs, local, store } = harness({ "job.list": Object.assign(new Error("daemon offline"), { message: "daemon offline" }) });
    await jobs.loadJobs();
    expect(local.getState()).toMatchObject({ loaded: true, listError: "daemon offline" });
    expect(store.getState().lastError).toBe("daemon offline");
  });

  it("clears a stale listError once a later list succeeds", async () => {
    const { jobs, local } = harness({ "job.list": [] });
    local.set({ listError: "daemon offline" });
    await jobs.loadJobs();
    expect(local.getState().listError).toBeNull();
  });
});
