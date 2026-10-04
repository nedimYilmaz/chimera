import { describe, it, expect } from "vitest";
import { JobError, tailOutput, runShellCommand } from "@chimera/core/jobs";
import { makeJobRig, waitUntil } from "./jobs-helpers.js";

// JOB-COMMAND-TARGET: a scheduled job with no agent. The recurring chores around a fleet —
// renewing a cloud login, pruning worktrees, rotating a log — do not need a model to read their
// output, and spending an agent turn on them buys nothing. Unlike every other target this one is
// SYNCHRONOUS: it starts nothing external and settles its own run.

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);

const rigWith = (result: { exitCode: number | null; output: string; error?: string }, calls: unknown[] = []) =>
  makeJobRig([], T0, { runCommand: async (t) => { calls.push(t); return result; } });

describe("a command job runs and reports its own outcome", () => {
  it("records exit code and output on success", async () => {
    const seen: unknown[] = [];
    const rig = rigWith({ exitCode: 0, output: "logged in" }, seen);
    rig.jobs.create({ name: "sso", schedule: { cron: "0 9 * * *" }, target: { command: "aws sso login --no-browser" } });

    await rig.jobs.runNow("sso");
    await waitUntil(() => rig.jobs.get("sso").lastRuns.length > 0);
    const run = rig.jobs.get("sso").lastRuns.at(-1)!;
    expect(run.result).toBe("ok");
    expect(run.exitCode).toBe(0);
    expect(run.output).toBe("logged in");
    expect(seen[0]).toMatchObject({ command: "aws sso login --no-browser", timeoutMs: 10 * 60_000 });
  });

  it("a NON-ZERO exit is a failed RUN, not a failure to start — the command did run", async () => {
    const rig = rigWith({ exitCode: 2, output: "Unable to locate credentials", error: "exited 2" });
    rig.jobs.create({ name: "sso", schedule: { cron: "0 9 * * *" }, target: { command: "aws sts get-caller-identity" } });

    await rig.jobs.runNow("sso");
    await waitUntil(() => rig.jobs.get("sso").lastRuns.length > 0);
    const run = rig.jobs.get("sso").lastRuns.at(-1)!;
    expect(run.result).toBe("failed");
    expect(run.exitCode).toBe(2);
    expect(run.output).toContain("Unable to locate credentials");   // the part you can act on
    expect(rig.jobs.get("sso").consecutiveFailures).toBe(1);
  });

  it("a timeout has no exit code and says so, rather than reporting a number it never got", async () => {
    const rig = rigWith({ exitCode: null, output: "", error: "timed out after 1000ms" });
    rig.jobs.create({ name: "hang", schedule: { cron: "0 9 * * *" }, target: { command: "sleep 999", timeoutMs: 1000 } });

    await rig.jobs.runNow("hang");
    await waitUntil(() => rig.jobs.get("hang").lastRuns.length > 0);
    const run = rig.jobs.get("hang").lastRuns.at(-1)!;
    expect(run.exitCode).toBeNull();
    expect(run.error).toContain("timed out");
  });

  it("inherits the shared job machinery: three failures in a row disable it", async () => {
    const rig = rigWith({ exitCode: 1, output: "nope", error: "exited 1" });
    rig.jobs.create({ name: "flaky", schedule: { cron: "0 9 * * *" }, target: { command: "false" } });
    for (let i = 0; i < 3; i++) {
      await rig.jobs.runNow("flaky");
      await waitUntil(() => rig.jobs.get("flaky").lastRuns.length === i + 1);
    }
    expect(rig.jobs.get("flaky").enabled).toBe(false);
    // F05.0 replaced the bare "3 consecutive failures" wording with the dead-letter sentence (and
    // the run's own error), which is what an operator needs to act on. Assertion was left stale.
    expect(rig.jobs.get("flaky").disabledReason).toContain("dead-letter after 3 attempts");
    expect(rig.jobs.get("flaky").failure!.deadLetterAt).not.toBeNull();
  });

  it("survives a daemon restart with its history intact", async () => {
    const rig = rigWith({ exitCode: 0, output: "ok" });
    rig.jobs.create({ name: "prune", schedule: { cron: "0 3 * * *" }, target: { command: "git worktree prune" } });
    await rig.jobs.runNow("prune");
    await waitUntil(() => rig.jobs.get("prune").lastRuns.length > 0);

    const { reopenJobs } = await import("./jobs-helpers.js");
    const reopened = reopenJobs(rig);
    const job = reopened.get("prune");
    expect(job.target).toMatchObject({ command: "git worktree prune" });
    expect(job.lastRuns.at(-1)!.exitCode).toBe(0);
    reopened.detach();
  });
});

describe("what a command job refuses", () => {
  it("drops the old agent prompt on an explicit switch to a command, and validates the reverse switch", () => {
    const rig = rigWith({ exitCode: 0, output: "" });
    rig.jobs.create({ name: "switch", schedule: { cron: "0 9 * * *" }, target: { agentSpec: { cwd: "/tmp", isolation: "none" } }, prompt: "review" });
    expect(rig.jobs.update("switch", { target: { command: "echo ok", timeoutMs: 1000 } }).prompt).toBeUndefined();
    expect(() => rig.jobs.update("switch", { target: { agentSpec: { cwd: "/tmp", isolation: "none" } } })).toThrow(/prompt is required/);
    expect(rig.jobs.get("switch").target).toHaveProperty("command");
  });
  it("rejects a prompt — its command IS the instruction", () => {
    const rig = rigWith({ exitCode: 0, output: "" });
    expect(() => rig.jobs.create({
      name: "x", schedule: { cron: "0 9 * * *" }, target: { command: "ls" }, prompt: "please list",
    })).toThrow(JobError);
  });

  it("still REQUIRES a prompt for an agent target — caught at create, not hours later at first fire", () => {
    const rig = rigWith({ exitCode: 0, output: "" });
    expect(() => rig.jobs.create({
      name: "y", schedule: { cron: "0 9 * * *" }, target: { agentSpec: { cwd: "/tmp", isolation: "none" } },
    })).toThrow(/prompt is required/);
  });
});

describe("output is bounded", () => {
  it("keeps the TAIL — when a command fails, what it said last says why", () => {
    const capped = tailOutput("x".repeat(50) + "THE REASON", 20);
    expect(capped).toContain("THE REASON");
    expect(capped).toContain("earlier chars dropped");
    expect(capped.length).toBeLessThan(120);
  });

  it("leaves short output exactly as it was", () => {
    expect(tailOutput("all good", 100)).toBe("all good");
  });
});

// One end-to-end run through the REAL shell, so the injected-runner tests above are not the only
// thing standing between this feature and a process that never spawns.
describe("the real shell runner", () => {
  it("runs a command and captures its output and exit code", async () => {
    const r = await runShellCommand({ command: "echo hello-from-chimera", timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("hello-from-chimera");
  });

  it("reports a non-zero exit with the stderr that explains it", async () => {
    const r = await runShellCommand({ command: "echo to-stderr 1>&2; exit 3", timeoutMs: 10_000 });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("to-stderr");
    expect(r.error).toContain("3");
  });

  it("kills a command that overruns its timeout instead of holding the job's slot forever", async () => {
    const r = await runShellCommand({ command: "sleep 30", timeoutMs: 300 });
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain("timed out");
  });
});

// SECURITY: a scheduled command is the widest-privilege thing in this system — arbitrary shell,
// unattended, with the daemon's own rights. These pin the containment around it: what it may
// leak, and what it must leave behind.
describe("what a command run must not leak", () => {
  it("redacts the job's OWN env values out of captured output — a command that echoes its environment cannot leak it", async () => {
    const SECRET = "sk-live-abcdef0123456789";
    const rig = makeJobRig([], T0, {
      runCommand: async () => ({ exitCode: 0, output: `using key ${SECRET} against prod` }),
    });
    rig.jobs.create({
      name: "leaky", schedule: { cron: "0 9 * * *" },
      target: { command: "deploy.sh", env: { API_KEY: SECRET } },
    });

    await rig.jobs.runNow("leaky");
    await waitUntil(() => rig.jobs.get("leaky").lastRuns.length > 0);
    const run = rig.jobs.get("leaky").lastRuns.at(-1)!;
    expect(run.output).not.toContain(SECRET);
    expect(run.output).toContain("against prod");     // everything else survives — this is redaction, not truncation
  });

  it("redacts them out of the ERROR text too — a failing command often names what it was handed", async () => {
    const SECRET = "ghp_tokenvalue1234567890";
    const rig = makeJobRig([], T0, {
      runCommand: async () => ({ exitCode: 1, output: "", error: `auth failed for ${SECRET}` }),
    });
    rig.jobs.create({ name: "e", schedule: { cron: "0 9 * * *" }, target: { command: "gh api /user", env: { GH_TOKEN: SECRET } } });

    await rig.jobs.runNow("e");
    await waitUntil(() => rig.jobs.get("e").lastRuns.length > 0);
    expect(rig.jobs.get("e").lastRuns.at(-1)!.error ?? "").not.toContain(SECRET);
  });

  it("keeps the raw command OUT of the event stream — the widest-read surface in the system", async () => {
    const rig = makeJobRig([], T0, { runCommand: async () => ({ exitCode: 0, output: "" }) });
    rig.jobs.create({
      name: "inline", schedule: { cron: "0 9 * * *" },
      target: { command: 'curl -H "Authorization: Bearer sk-inline-secret" https://x' },
    });
    await rig.jobs.runNow("inline");
    await waitUntil(() => rig.jobs.get("inline").lastRuns.length > 0);

    const serialized = JSON.stringify(rig.events.tail(null, 200));
    expect(serialized).not.toContain("sk-inline-secret");
    expect(serialized).toContain("inline");           // the job is still observable BY NAME
  });
});
