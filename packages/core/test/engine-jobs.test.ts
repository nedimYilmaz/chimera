import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { WakeSchedulingSchema, type JobRecord, type WakeScheduling } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

const TEAM_SPEC = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 2, queue: "work" };
const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);

describe("Engine job.* RPC family (D10)", () => {
  it("create/list/status/update/delete/runNow lifecycle over a team target", async () => {
    const home = makeEngineHome();
    const e = new Engine({ home, backends: backends(new FakeAgentBackend([])) });   // unscripted fake → "fake:<prompt>"
    await e.handle("queue.create", { spec: { name: "work" } });
    await e.handle("team.create", { spec: TEAM_SPEC });

    const created = (await e.handle("job.create", {
      spec: {
        name: "nightly", schedule: { every: { unit: "hours", n: 1 } },
        target: { team: "crew" }, prompt: "sweep", overlapPolicy: "skip",
      },
    })) as JobRecord;
    expect(created.name).toBe("nightly");
    expect(created.nextRunTs).toBeGreaterThan(Date.now());

    const listed = (await e.handle("job.list", {})) as JobRecord[];
    expect(listed.map((j) => j.name)).toEqual(["nightly"]);

    const status = (await e.handle("job.status", { name: "nightly" })) as JobRecord & { wakeScheduling: WakeScheduling };
    expect(status.name).toBe("nightly");
    // F01(a): the machine-level capability rides alongside the record on EVERY job.status read, so
    // a caller can tell "this schedule is exact" from "this fires whenever the lid opens" without
    // a second call. Unavailable here because makeEngineHome turns the OS power seam off.
    expect(WakeSchedulingSchema.parse(status.wakeScheduling)).toMatchObject({ available: false, scheduledFor: null });
    // job.list deliberately does NOT carry it: N jobs would repeat one machine fact N times.
    expect(listed[0]).not.toHaveProperty("wakeScheduling");

    const run = (await e.handle("job.runNow", { name: "nightly" })) as { started: boolean; taskId?: string };
    expect(run.started).toBe(true);
    await waitUntil(() => e.queues.status("work").counts.done === 1);
    await waitUntil(() => ((e as unknown as { jobs: { get(n: string): JobRecord } }).jobs.get("nightly")).lastRuns.length === 1);

    const updated = (await e.handle("job.update", { name: "nightly", patch: { enabled: false } })) as JobRecord;
    expect(updated.enabled).toBe(false);
    expect(updated.nextRunTs).toBeNull();

    expect(await e.handle("job.delete", { name: "nightly" })).toEqual({ ok: true });
    expect((await e.handle("job.list", {})) as JobRecord[]).toEqual([]);
  });

  it("typed {code:protocol} errors for a ghost job name / bad schedule / unknown team", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends(new FakeAgentBackend([])) });
    await expect(e.handle("job.status", { name: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("job.runNow", { name: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("job.delete", { name: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("job.create", {
      spec: { name: "bad", schedule: { cron: "nonsense" }, target: { team: "crew" }, prompt: "x" },
    })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("job.create", {
      spec: { name: "orphan", schedule: { cron: "* * * * *" }, target: { team: "ghost-team" }, prompt: "x" },
    })).rejects.toMatchObject({ code: "protocol" });
  });
});
