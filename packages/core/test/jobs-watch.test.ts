import { describe, it, expect, afterEach } from "vitest";
import { makeJobRig, waitUntil } from "./jobs-helpers.js";
import type { WatchHandle, WatchSpawner } from "@chimera/core/job-watch";

// JOB-OUTPUT-TRIGGER / JOB-WATCH — the integrated behaviour, driven through the process seam so no
// real command runs. What is proved here is the part the pure unit tests cannot: that a match
// actually reaches an agent, that throttling holds, and that a supervised process is started,
// restarted and — critically — STOPPED when it should be.

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** A fake supervised process the test drives by hand. */
function fakeWatch() {
  const live: Array<{ emit: (line: string) => void; die: (code: number | null) => void; stopped: boolean }> = [];
  const spawner: WatchSpawner = (_t, onLine, onExit) => {
    const entry = { emit: onLine, die: onExit, stopped: false };
    live.push(entry);
    const handle: WatchHandle = { stop: () => { entry.stopped = true; }, pid: 4242 };
    return handle;
  };
  return { spawner, live, latest: () => live[live.length - 1]! };
}

const rigs: Array<{ jobs: { detach(): void } }> = [];
afterEach(() => { for (const r of rigs.splice(0)) r.jobs.detach(); });

function watchRig(spawner: WatchSpawner) {
  const rig = makeJobRig([[{ kind: "text", text: "ok" }], [{ kind: "text", text: "ok" }]], T0, { spawnWatch: spawner });
  rigs.push(rig);
  return rig;
}

const watchJob = (trigger: Record<string, unknown> | null = {}) => ({
  name: "k8s-watch",
  schedule: { watch: true },
  target: {
    command: "kubectl get pods -w",
    ...(trigger === null ? {} : {
      trigger: {
        when: { matches: "pod (?<pod>\\S+) is (CrashLoopBackOff)" },
        dispatch: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } },
        prompt: "{{pod}} is unhealthy. Line: {{output}}",
        minIntervalMs: 0,
        ...trigger,
      },
    }),
  },
});

describe("a watch job supervises its process", () => {
  it("starts the process on create and reports it running — with no nextRun, because there is none", () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    const rec = rig.jobs.create(watchJob());
    expect(rec.nextRunTs).toBeNull();
    expect(w.live).toHaveLength(1);
    expect(rig.jobs.watchStatus("k8s-watch")).toEqual({ running: true, pid: 4242 });
  });

  it("wakes an agent when a line matches, with the captured values in the prompt", async () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    rig.jobs.create(watchJob());
    w.latest().emit("pod api-7f9 is CrashLoopBackOff");
    await waitUntil(() => rig.sup.list().length > 0, 2000);
    const spawned = rig.sup.list()[0]!;
    expect(spawned.spec.prompt).toContain("api-7f9 is unhealthy");
    expect(spawned.spec.prompt).toContain("pod api-7f9 is CrashLoopBackOff");
  });

  it("ignores lines that do not match", async () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    rig.jobs.create(watchJob());
    w.latest().emit("pod api-7f9 is Running");
    w.latest().emit("nothing interesting here");
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.sup.list()).toHaveLength(0);
  });

  it("throttles a chatty process instead of spawning an agent per line", async () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    rig.jobs.create(watchJob({ minIntervalMs: 60_000 }));
    w.latest().emit("pod a is CrashLoopBackOff");
    await waitUntil(() => rig.sup.list().length === 1, 2000);
    w.latest().emit("pod b is CrashLoopBackOff");
    w.latest().emit("pod c is CrashLoopBackOff");
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.sup.list()).toHaveLength(1);
    // and it SAYS it throttled — a watcher that looks idle because it is throttling is
    // indistinguishable from one whose condition never matches.
    expect(rig.events.tail(null, 200).some((e) => e.kind === "job_trigger_throttled")).toBe(true);
  });

  it("restarts the process when it dies, rather than counting a failure toward auto-disable", async () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    rig.jobs.create(watchJob(null));   // no trigger: a plain supervised process
    expect(w.live).toHaveLength(1);
    w.latest().die(1);
    // the exit is reported...
    expect(rig.events.tail(null, 50).some((e) => e.kind === "job_watch_exited")).toBe(true);
    // ...and the job is NOT disabled: a monitor exiting is normal for plenty of tools, and
    // disabling after three would mute the alert exactly when things are unhealthy.
    expect(rig.jobs.get("k8s-watch").enabled).toBe(true);
    await waitUntil(() => w.live.length === 2, 20_000);
  }, 30_000);

  it("stops the process when the job is disabled — otherwise the disable does nothing visible", () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    rig.jobs.create(watchJob());
    const proc = w.latest();
    rig.jobs.update("k8s-watch", { enabled: false });
    expect(proc.stopped).toBe(true);
    expect(rig.jobs.watchStatus("k8s-watch")).toEqual({ running: false, pid: null });
  });

  it("stops the process when the job is deleted", () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    rig.jobs.create(watchJob());
    const proc = w.latest();
    rig.jobs.delete("k8s-watch");
    expect(proc.stopped).toBe(true);
  });

  it("stops every process on detach — a supervised process outliving its supervisor is an orphan", () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    rig.jobs.create(watchJob());
    const proc = w.latest();
    rig.jobs.detach();
    expect(proc.stopped).toBe(true);
  });

  it("refuses a trigger whose dispatch names a team that does not exist — at CREATE, not at 3am", () => {
    const w = fakeWatch();
    const rig = watchRig(w.spawner);
    expect(() => rig.jobs.create(watchJob({ dispatch: { team: "no-such-team" } }))).toThrow();
    expect(w.live).toHaveLength(0);
  });
});

describe("a scheduled command job can also trigger", () => {
  const scheduledJob = (when: unknown) => ({
    name: "disk-check",
    schedule: { every: { unit: "minutes" as const, n: 5 } },
    target: {
      command: "df -h /",
      trigger: { when, dispatch: { agentSpec: { cwd: "/tmp", account: "main", isolation: "none" } }, prompt: "disk: {{output}} (exit {{exitCode}})", minIntervalMs: 0 },
    },
  });

  it("wakes an agent when the output matches, and passes the output and exit code", async () => {
    const rig = makeJobRig([[{ kind: "text", text: "ok" }]], T0, {
      runCommand: async () => ({ exitCode: 0, output: "/dev/disk1  98% /" }),
    });
    rigs.push(rig);
    rig.jobs.create(scheduledJob({ matches: "\\b9[0-9]% " }));
    await rig.jobs.runNow("disk-check");
    await waitUntil(() => rig.sup.list().length > 0, 2000);
    expect(rig.sup.list()[0]!.spec.prompt).toBe("disk: /dev/disk1  98% / (exit 0)");
  });

  it("does not wake anything when the output is unremarkable — but still records the run", async () => {
    const rig = makeJobRig([[{ kind: "text", text: "ok" }]], T0, {
      runCommand: async () => ({ exitCode: 0, output: "/dev/disk1  12% /" }),
    });
    rigs.push(rig);
    rig.jobs.create(scheduledJob({ matches: "\\b9[0-9]% " }));
    await rig.jobs.runNow("disk-check");
    await waitUntil(() => rig.jobs.get("disk-check").lastRuns.length > 0, 2000);
    expect(rig.sup.list()).toHaveLength(0);
    expect(rig.jobs.get("disk-check").lastRuns[0]!.result).toBe("ok");
  });

  it("fires on a specific exit code", async () => {
    const rig = makeJobRig([[{ kind: "text", text: "ok" }]], T0, {
      runCommand: async () => ({ exitCode: 2, output: "expired", error: "exited 2" }),
    });
    rigs.push(rig);
    rig.jobs.create(scheduledJob({ exitCode: 2 }));
    await rig.jobs.runNow("disk-check");
    await waitUntil(() => rig.sup.list().length > 0, 2000);
    expect(rig.sup.list()[0]!.spec.prompt).toContain("exit 2");
  });
});
