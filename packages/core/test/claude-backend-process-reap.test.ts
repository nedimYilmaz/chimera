import { describe, it, expect, vi } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend, terminateProcessGroup } from "@chimera/core/backends/claude";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { REPO_BACKED_CWD } from "./repo-backed-cwd.js";

// AGENT-PROCESS-NOT-REAPED: proves the actual OS-level gap this fix closes. Every OTHER
// claude-backend test injects a fake queryFn whose returned stream never calls
// options.spawnClaudeCodeProcess at all — so cliProcess stays null and terminateProcessGroup is
// never reached, which is exactly why those tests never regress from this change. These tests
// instead build a fake queryFn that DOES call spawnClaudeCodeProcess, with a REAL script that
// spawns its own child (standing in for one of the 5-6 MCP server children the real `claude` CLI
// spawns) — so "the process group actually terminates" is asserted against real OS pids, not a
// mocked kill() call.

function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: REPO_BACKED_CWD, isolation: "none", ...over }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}

// Stands in for the real `claude` CLI: spawns one plain (non-detached) child of its own —
// exactly how the real CLI spawns its MCP server children without detaching them itself, only
// relying on ITS OWN process (spawned detached by claude.ts) to be the group leader — then
// prints that child's pid on a line of its own stdout so the test can identify it, and idles
// forever (never exits on its own) until signalled.
const CHILD_TREE_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 60000);'], { stdio: 'ignore' });",
  "process.stdout.write(String(child.pid) + '\\n');",
  "setInterval(() => {}, 60000);",
].join("\n");

type SpawnedLike = { pid?: number; stdout: NodeJS.ReadableStream; once(event: string, cb: (...a: unknown[]) => void): void };

// fn that actually calls options.spawnClaudeCodeProcess with the real script above, capturing
// the resulting SpawnedProcess so the test can read its pid and its grandchild's pid off stdout.
function realProcessTreeQuery(streamBody: (input: AsyncIterable<unknown>) => AsyncIterable<Record<string, unknown>>) {
  let spawned: SpawnedLike | undefined;
  const fn = ((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const spawnFn = args.options["spawnClaudeCodeProcess"] as (o: unknown) => SpawnedLike;
    spawned = spawnFn({
      command: process.execPath, args: ["-e", CHILD_TREE_SCRIPT], cwd: process.cwd(), env: process.env,
      signal: new AbortController().signal,
    });
    return { [Symbol.asyncIterator]: () => streamBody(args.prompt)[Symbol.asyncIterator](), interrupt: async () => {} };
  }) as never;
  return { fn, getSpawned: () => spawned };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !isAlive(pid);
}
function waitForGrandchildPid(spawned: SpawnedLike, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("grandchild pid never printed")), timeoutMs);
    spawned.stdout.on("data", (chunk: unknown) => {
      buf += String(chunk);
      const m = buf.match(/(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
}

describe("AGENT-PROCESS-NOT-REAPED: real OS process-tree termination", () => {
  it("explicit kill() terminates the CLI process AND its child (MCP-server stand-in) — not just the JS handle", async () => {
    const { fn, getSpawned } = realProcessTreeQuery(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1", model: "m1" };
      await new Promise(() => {});   // park like a real running turn
    });
    const backend = new ClaudeAgentBackend({ queryFn: fn, processTerminationGraceMs: 300 });
    const evs: BackendEvent[] = [];
    const handle = backend.spawn(spec(), (e) => evs.push(e), async () => ({ behavior: "allow" }));

    const spawned = getSpawned();
    expect(spawned?.pid).toBeTypeOf("number");
    expect(handle.processPid).toBe(spawned?.pid);
    const grandchildPid = await waitForGrandchildPid(spawned!, 5000);
    expect(isAlive(spawned!.pid!)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    await handle.kill();

    expect(await waitUntilDead(spawned!.pid!, 3000)).toBe(true);
    expect(await waitUntilDead(grandchildPid, 3000)).toBe(true);
    await vi.waitFor(() => expect(handle.processPid).toBeNull());
  }, 15000);

  it("a NATURAL turn completion (no explicit kill()) still terminates the process tree — the exact gap measured live: terminal records with days-old live processes", async () => {
    // Gated on capturing the grandchild pid FIRST — otherwise the natural "result" can end the
    // loop (and hard-terminate the tree) before the child script even finishes spawning its own
    // grandchild and printing its pid, racing the assertion below for the wrong reason.
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
    const { fn, getSpawned } = realProcessTreeQuery(async function* () {
      yield { type: "system", subtype: "init", session_id: "s1", model: "m1" };
      await resultGate;
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
      // generator returns here — the for-await loop ends NATURALLY, with no kill() ever called.
    });
    const backend = new ClaudeAgentBackend({ queryFn: fn, processTerminationGraceMs: 300 });
    const evs: BackendEvent[] = [];
    backend.spawn(spec(), (e) => evs.push(e), async () => ({ behavior: "allow" }));

    const spawned = getSpawned();
    const grandchildPid = await waitForGrandchildPid(spawned!, 5000);
    releaseResult();

    expect(await waitUntilDead(spawned!.pid!, 3000)).toBe(true);
    expect(await waitUntilDead(grandchildPid, 3000)).toBe(true);
  }, 15000);
});

// AGENT-FAILURE-REACHES-CONDUCTOR: a process-layer death used to surface as a bare "exited with
// code 1" — the SDK's own rejection carries no stderr. Mirrors the file's own precedent above: a
// REAL child process (not a mock) writes to stderr and exits non-zero, proving claude.ts's own
// stderr listener (attached in spawnClaudeCodeProcess) actually captures live process output
// rather than a scripted/mocked stand-in.
const CHILD_STDERR_CRASH_SCRIPT = [
  "process.stderr.write('FATAL crash: leaked credential token=tok-secret-xyz\\n');",
  "process.exit(1);",
].join("\n");

function stderrCrashQuery() {
  let spawned: SpawnedLike | undefined;
  const fn = ((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const spawnFn = args.options["spawnClaudeCodeProcess"] as (o: unknown) => SpawnedLike;
    spawned = spawnFn({
      command: process.execPath, args: ["-e", CHILD_STDERR_CRASH_SCRIPT], cwd: process.cwd(), env: process.env,
      signal: new AbortController().signal,
    });
    return {
      [Symbol.asyncIterator]: () => (async function* () {
        yield { type: "system", subtype: "init", session_id: "s1", model: "m1" };
        // Wait for the REAL child to fully exit+close its stdio (guarantees its stderr 'data'
        // event has already fired) before simulating the SDK's own rejection — exactly the
        // ordering claude.ts's real stderr listener relies on in production.
        await new Promise((resolve) => spawned!.once("close", resolve));
        throw new Error("Claude Code process exited with code 1");
      })()[Symbol.asyncIterator](),
      interrupt: async () => {},
    };
  }) as never;
  return { fn, getSpawned: () => spawned };
}

describe("AGENT-FAILURE-REACHES-CONDUCTOR: claude.ts stderr capture on real process death", () => {
  it("a real spawned process that writes to stderr and exits non-zero surfaces a bounded stderrTail + exitCode on the emitted 'error' event", async () => {
    const { fn, getSpawned } = stderrCrashQuery();
    const backend = new ClaudeAgentBackend({ queryFn: fn, processTerminationGraceMs: 300 });
    const evs: BackendEvent[] = [];
    backend.spawn(spec(), (e) => evs.push(e), async () => ({ behavior: "allow" }));

    const spawned = getSpawned();
    expect(spawned?.pid).toBeTypeOf("number");
    expect(await waitUntilDead(spawned!.pid!, 5000)).toBe(true);

    const start = Date.now();
    while (!evs.some((e) => e.kind === "error") && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const err = evs.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    expect(String(err?.data["message"])).toContain("token=tok-secret-xyz");
    expect(String(err?.data["stderrTail"])).toContain("token=tok-secret-xyz");
    expect(err?.data["exitCode"]).toBe(1);
  }, 15000);
});

describe("terminateProcessGroup", () => {
  it("signals SIGTERM to the NEGATIVE pid immediately (the whole process group, not just the pid)", () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    terminateProcessGroup({ pid: 4242, once: () => {} }, { kill: (p, s) => calls.push([p, s]) });
    expect(calls).toEqual([[-4242, "SIGTERM"]]);
  });

  it("escalates to SIGKILL after graceMs when the process never reports exit", () => {
    vi.useFakeTimers();
    try {
      const calls: Array<[number, NodeJS.Signals]> = [];
      terminateProcessGroup({ pid: 4242, once: () => {} }, { kill: (p, s) => calls.push([p, s]), graceMs: 5000 });
      vi.advanceTimersByTime(5000);
      expect(calls).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
    } finally { vi.useRealTimers(); }
  });

  it("never escalates to SIGKILL once the process reports exit within the grace window", () => {
    vi.useFakeTimers();
    try {
      const calls: Array<[number, NodeJS.Signals]> = [];
      const listeners: Array<() => void> = [];
      terminateProcessGroup(
        { pid: 4242, once: (_e, cb) => listeners.push(cb) },
        { kill: (p, s) => calls.push([p, s]), graceMs: 5000 },
      );
      listeners.forEach((cb) => cb());   // simulate the 'exit' event firing
      vi.advanceTimersByTime(5000);
      expect(calls).toEqual([[-4242, "SIGTERM"]]);
    } finally { vi.useRealTimers(); }
  });

  it("no-ops when pid is undefined (the process failed to spawn)", () => {
    const calls: Array<[number, NodeJS.Signals]> = [];
    terminateProcessGroup({ pid: undefined, once: () => {} }, { kill: (p, s) => calls.push([p, s]) });
    expect(calls).toEqual([]);
  });
});
