import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChimeraClient } from "@chimera/client";
import { makeEngineHome } from "../../core/test/helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cli(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", CLI, ...args], { env }, (err, stdout) =>
      resolve({ stdout, code: err ? (err as { code?: number }).code ?? 1 : 0 }));
  });
}

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("chimera team/queue CLI", () => {
  it("creates a queue and team, pushes a task, and watches it drain to done", async () => {
    let r = await cli(["queue", "create", "--name", "work", "--retry-limit", "1"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).retryLimit).toBe(1);

    r = await cli(["team", "create", "--spec",
      JSON.stringify({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" })]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).name).toBe("crew");

    r = await cli(["queue", "push", "work", "--prompt", "cli task", "--priority", "2"]);
    expect(r.code).toBe(0);
    const task = JSON.parse(r.stdout);
    expect(task.priority).toBe(2);

    let done: { state: string; resultText: string | null } | undefined;
    for (let i = 0; i < 100; i++) {
      const st = JSON.parse((await cli(["queue", "status", "work"])).stdout);
      done = st.tasks.find((t: { taskId: string }) => t.taskId === task.taskId);
      if (done?.state === "done") break;
      await sleep(50);
    }
    expect(done?.state).toBe("done");
    // The fake backend echoes spec.prompt, so exact equality guards the authored
    // task body against team-context prefixes on the CLI queue path.
    expect(done?.resultText).toBe("fake:cli task");

    const teams = JSON.parse((await cli(["team", "list"])).stdout);
    expect(teams[0]).toMatchObject({ name: "crew", running: 0 });
    expect(JSON.parse((await cli(["team", "status", "crew"])).stdout).running).toBe(0);
    expect(JSON.parse((await cli(["team", "dissolve", "crew"])).stdout)).toEqual({ ok: true });
  }, 60_000);

  it("cancels a pending task on an unbound queue and fails loudly on unknown queues", async () => {
    await cli(["queue", "create", "--name", "loose"]);
    const task = JSON.parse((await cli(["queue", "push", "loose", "--prompt", "later"])).stdout);
    expect(JSON.parse((await cli(["queue", "cancel", task.taskId])).stdout)).toEqual({ cancelled: true });
    const queues = JSON.parse((await cli(["queue", "list"])).stdout) as Array<{ name: string }>;
    expect(queues.map((q) => q.name)).toContain("loose");        // queue.list over the CLI (Phase 3 dependency)
    const bad = await cli(["queue", "status", "ghost"]);
    expect(bad.code).toBe(1);
  }, 60_000);
});
