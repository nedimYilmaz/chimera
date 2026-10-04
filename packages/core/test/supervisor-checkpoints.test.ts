import { describe, it, expect, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { CFG, fakeExec } from "./helpers.js";

// F20 D16 (coverage §C18): the two auto-checkpoint triggers wired into the supervisor —
// task start (fire-and-forget, mirrors stampGitBranch) and destructive Bash (AWAITED
// inside decidePermission, so the checkpoint is guaranteed to land BEFORE the command
// itself runs). Both go through the injected checkpointCreate seam — CheckpointStore's
// own git-plumbing correctness is covered separately in checkpoints.test.ts.
//
// D16 fix (checkpoint auto-trigger scoping): both triggers are ALSO gated on the
// injected isGitRepo seam BEFORE checkpointCreate is ever called — a non-git cwd must
// never attempt (and swallow-fail) a checkpoint. Unless a test overrides it, isGitRepo
// defaults to `async () => true` here so the existing fire/order assertions below (using
// the non-existent "/tmp/proj" cwd) stay exactly as they were; the gate itself is
// exercised by the "checkpoint auto-trigger scoping" describe block further down.

// CORE-SUITE-BASELINE: the "against real git (unmocked)" block below shells out to real
// `git` — under this machine's concurrent-agent load that can exceed vitest's 5000ms
// default; widened per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 20_000 });

type Call = { cwd: string; trigger: "task_start" | "destructive_bash"; agentId: string; command?: string };

function makeSup(
  scenarios: FakeStep[][],
  checkpointCreate?: (input: Call) => Promise<void>,
  isGitRepo?: (cwd: string) => Promise<boolean>,
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-ckptsup-"));
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend(scenarios)]]),
    events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    ...(checkpointCreate ? { checkpointCreate, isGitRepo: isGitRepo ?? (async () => true) } : {}),
  });
  return { sup, events };
}

// permissionProfile:"full" so a Bash call auto-allows without ALSO exercising the
// standard permission_request round-trip — these tests are about the checkpoint
// trigger, not permission flow (that's supervisor-toolpolicy.test.ts's job).
const SPEC = { prompt: "x", cwd: "/tmp/proj", account: "main", isolation: "none", permissionProfile: "full" } as const;
const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });
const destructiveCalls = (calls: Call[]) => calls.filter((c) => c.trigger === "destructive_bash");

describe("D16 task-start checkpoint trigger", () => {
  it("fires once on spawn with trigger:task_start, fire-and-forget (spawn resolves before it lands)", async () => {
    const calls: Call[] = [];
    let resolveCall: (() => void) | undefined;
    const gate = new Promise<void>((r) => { resolveCall = r; });
    const { sup } = makeSup([[{ end: { resultText: "done" } }]], async (input) => {
      calls.push(input);
      await gate;   // never resolves during this test — proves spawn() doesn't await it
    });
    const rec = await sup.spawn(SPEC);   // must resolve even though the checkpoint call is still pending
    expect(calls).toEqual([{ cwd: "/tmp/proj", trigger: "task_start", agentId: rec.agentId }]);
    resolveCall?.();
  });

  it("a rejecting checkpointCreate never fails or delays the spawn", async () => {
    const { sup } = makeSup([[{ end: { resultText: "done" } }]], async () => { throw new Error("boom"); });
    const rec = await sup.spawn(SPEC);
    expect(rec.agentId).toBeTruthy();
  });

  it("no checkpointCreate seam wired → spawn is unaffected (existing deployments byte-identical)", async () => {
    const { sup } = makeSup([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn(SPEC);
    expect(rec.agentId).toBeTruthy();
  });
});

describe("D16 destructive-Bash checkpoint trigger", () => {
  it("a destructive command triggers checkpointCreate(trigger:destructive_bash) and AWAITS it before the tool runs", async () => {
    const calls: Call[] = [];
    const order: string[] = [];
    const { sup, events } = makeSup(
      [[bash("rm -rf build"), { end: { resultText: "done" } }]],
      async (input) => {
        calls.push(input);
        if (input.trigger === "destructive_bash") { order.push("checkpoint"); await Promise.resolve(); }
      },
    );
    events.subscribe((e) => { if (e.kind === "tool_call") order.push("tool_call"); });
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(destructiveCalls(calls)).toEqual([{ cwd: "/tmp/proj", trigger: "destructive_bash", agentId: rec.agentId, command: "rm -rf build" }]);
    expect(order).toEqual(["checkpoint", "tool_call"]);   // checkpoint landed BEFORE the destructive command ran
  });

  it("a harmless Bash command never triggers a checkpoint", async () => {
    const calls: Call[] = [];
    const { sup } = makeSup([[bash("git status"), { end: { resultText: "done" } }]], async (input) => { calls.push(input); });
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(destructiveCalls(calls)).toEqual([]);
  });

  it("fires once per destructive segment, even when the eventual permission is denied", async () => {
    const calls: Call[] = [];
    const { sup, events } = makeSup(
      [[bash("git reset --hard"), { end: { resultText: "done" } }]],
      async (input) => { calls.push(input); },
    );
    events.subscribe((e) => { if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), false); });
    const rec = await sup.spawn({ ...SPEC, on: { permissionRequest: "tui" } });
    await sup.waitFor(rec.agentId, 1000);
    const destructive = destructiveCalls(calls);
    expect(destructive).toHaveLength(1);
    expect(destructive[0]).toMatchObject({ trigger: "destructive_bash", command: "git reset --hard" });
  });

  it("no checkpointCreate seam wired → the destructive-Bash gate is a no-op (existing deployments byte-identical)", async () => {
    const { sup, events } = makeSup([[bash("rm -rf build"), { end: { resultText: "done" } }]]);
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });
});

// D16 fix (checkpoint auto-trigger scoping): the isGitRepo pre-check gate itself — a
// non-git cwd must never even ATTEMPT checkpointCreate (not attempt-then-swallow), so
// checkpointCreate must simply never be called for it, for BOTH triggers.
describe("D16 fix: checkpoint auto-trigger scoping (isGitRepo gate)", () => {
  it("task-start: isGitRepo:false → checkpointCreate is never called", async () => {
    const calls: Call[] = [];
    const { sup } = makeSup(
      [[{ end: { resultText: "done" } }]],
      async (input) => { calls.push(input); },
      async () => false,
    );
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(calls).toEqual([]);
  });

  it("task-start: isGitRepo:true → checkpointCreate fires as before", async () => {
    const calls: Call[] = [];
    const { sup } = makeSup(
      [[{ end: { resultText: "done" } }]],
      async (input) => { calls.push(input); },
      async () => true,
    );
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(calls).toEqual([{ cwd: "/tmp/proj", trigger: "task_start", agentId: rec.agentId }]);
  });

  it("destructive-Bash: isGitRepo:false → checkpointCreate is never called, command still runs", async () => {
    const calls: Call[] = [];
    const { sup, events } = makeSup(
      [[bash("rm -rf build"), { end: { resultText: "done" } }]],
      async (input) => { calls.push(input); },
      async () => false,
    );
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(destructiveCalls(calls)).toEqual([]);
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  it("destructive-Bash: isGitRepo:true → checkpointCreate fires as before", async () => {
    const calls: Call[] = [];
    const { sup } = makeSup(
      [[bash("rm -rf build"), { end: { resultText: "done" } }]],
      async (input) => { calls.push(input); },
      async () => true,
    );
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(destructiveCalls(calls)).toHaveLength(1);
  });

  it("a rejecting isGitRepo never fails the spawn (treated as false — no checkpoint attempt)", async () => {
    const calls: Call[] = [];
    const { sup } = makeSup(
      [[{ end: { resultText: "done" } }]],
      async (input) => { calls.push(input); },
      async () => { throw new Error("git binary missing"); },
    );
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(rec.agentId).toBeTruthy();
    expect(calls).toEqual([]);
  });

  // End-to-end against REAL git (no isGitRepo override — exercises the default
  // execFile-backed probe wired in supervisor.ts) — proves the whole seam, not just a
  // mocked contract: a genuinely non-git cwd never attempts a checkpoint; a genuine git
  // working tree does.
  describe("against real git (default isGitRepo probe, unmocked)", () => {
    it("non-git cwd → checkpointCreate never attempted", async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), "chimera-nongit-"));
      const calls: Call[] = [];
      const dir = mkdtempSync(join(tmpdir(), "chimera-ckptsup-"));
      const events = new EventLog(dir);
      const sup = new AgentSupervisor({
        registry: new AccountRegistry(CFG),
        credentials: new CredentialResolver(fakeExec),
        backends: new Map([["claude", new FakeAgentBackend([[{ end: { resultText: "done" } }]])]]),
        events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
        permissionTimeoutMs: 100,
        checkpointCreate: async (input) => { calls.push(input); },
      });
      const rec = await sup.spawn({ ...SPEC, cwd: nonGitDir });
      await sup.waitFor(rec.agentId, 1000);
      expect(calls).toEqual([]);
    });

    it("real git working tree cwd → checkpointCreate fires", async () => {
      const gitDir = mkdtempSync(join(tmpdir(), "chimera-realgit-"));
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["init", "-q"], { cwd: gitDir }, (err) => (err ? reject(err) : resolve()));
      });
      const calls: Call[] = [];
      const dir = mkdtempSync(join(tmpdir(), "chimera-ckptsup-"));
      const events = new EventLog(dir);
      const sup = new AgentSupervisor({
        registry: new AccountRegistry(CFG),
        credentials: new CredentialResolver(fakeExec),
        backends: new Map([["claude", new FakeAgentBackend([[{ end: { resultText: "done" } }]])]]),
        events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
        permissionTimeoutMs: 100,
        checkpointCreate: async (input) => { calls.push(input); },
      });
      const rec = await sup.spawn({ ...SPEC, cwd: gitDir });
      await sup.waitFor(rec.agentId, 5000);
      // task-start is fire-and-forget, and here it's gated behind a REAL execFile("git",
      // ...) probe — unlike the mocked-isGitRepo tests above, that subprocess can still be
      // in flight after waitFor resolves, so poll instead of asserting immediately.
      // CORE-SUITE-BASELINE: widened from 50x20ms (1s) — under this machine's concurrent-agent
      // load the real subprocess probe can take much longer than 1s to land.
      for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(calls).toEqual([{ cwd: gitDir, trigger: "task_start", agentId: rec.agentId }]);
    });
  });
});
