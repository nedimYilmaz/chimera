import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { CrashLoopPolicy } from "@chimera/core/failover";
import { SnapshotScheduler } from "@chimera/core/snapshot";
import { encodeFrame, decodeFrames, type RpcFrame, type RpcResponse } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeEngineHome } from "../../core/test/helpers.js";

// Deterministic full-boot blackbox rig — real RPC over the real daemon socket, driven with a
// FakeAgentBackend, exactly mirroring restart-recovery.test.ts's shape (per the QA gate's
// requirement that a daemon/system-behavior feature ship a test in this style rather than one
// that reaches into engine internals).
function rpcClient(socketPath: string) {
  const sock = createConnection(socketPath);
  let buf = ""; const waiters: Array<(f: RpcFrame) => void> = []; const inbox: RpcFrame[] = [];
  sock.on("data", (d) => {
    buf += d.toString();
    const { frames, rest } = decodeFrames(buf); buf = rest;
    for (const f of frames) { const w = waiters.shift(); w ? w(f) : inbox.push(f); }
  });
  const next = () => new Promise<RpcFrame>((r) => { const f = inbox.shift(); f ? r(f) : waiters.push(r); });
  let id = 0;
  const request = async (method: string, params: unknown = {}): Promise<RpcResponse> => {
    sock.write(encodeFrame({ id: String(++id), type: "request", method, params }));
    let f = await next();
    while (f.type !== "response") f = await next();
    return f as RpcResponse;
  };
  return { request, end: () => sock.end() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) throw new Error("condition not met before deadline");
    await sleep(20);
  }
}

describe("R2 self-healing supervision: daemon-level blackbox", () => {
  it("a backend-crash-then-recover cycle is observable via health.status, and replay.agentsAsOf matches the final live state", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    const crashLoopPolicy: CrashLoopPolicy = { maxRestarts: 5, baseDelayMs: 15, maxDelayMs: 200 };
    const crashScenario: FakeStep[] = [{ fail: { message: "process exited with code 1" } }];
    const recoverScenario: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "s-recovered" } } },
      { end: { resultText: "recovered-over-rpc", costUsd: 0.03 } },
    ];
    const fake = new FakeAgentBackend([crashScenario, recoverScenario]);
    const engine = new Engine({
      home, backends: new Map<string, AgentBackend>([["claude", fake]]), crashLoopPolicy,
    });
    const server = await startRpcServer({ socketPath, engine });
    // R2: replay.agentsAsOf reads state.json off disk — a real daemon boot always has a
    // SnapshotScheduler running (main.ts); this test wires the same one directly so the RPC has
    // an actual baseline to fold events onto.
    const snapshotScheduler = new SnapshotScheduler(engine, join(home, "state.json"));
    snapshotScheduler.start();
    const c = rpcClient(socketPath);

    const spawned = await c.request("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } });
    const agentId = (spawned.result as { agentId: string }).agentId;
    // Snapshot EARLY (mirrors reattach.test.ts's own FEATURE-4 divergence-test precedent) —
    // right after the record exists, then STOP the scheduler so state.json stays frozen here
    // while the crash/backoff/recovery events keep landing in the log. Whatever exact point
    // this lands at, replayAgentsAsOf folding everything after it must still reconstruct the
    // same final state agent.status observes live.
    snapshotScheduler.flush();
    snapshotScheduler.stop();

    // 1. health.status surfaces the crash-loop pause (crashCount:1, not yet recovered).
    type HealthRow = { agentId: string; state: string; crashCount: number; circuitOpen: boolean; pauseReason: string | null };
    const observedHealth = await until(
      async () => (await c.request("health.status")).result as HealthRow[],
      (rows) => rows.some((r) => r.agentId === agentId && r.crashCount >= 1),
    );
    // Inspect the response that met the predicate, not a second RPC taken
    // after the short backoff may already have resumed the next attempt.
    const midFlight = observedHealth.find((r) => r.agentId === agentId);
    expect(midFlight?.crashCount).toBeGreaterThanOrEqual(1);
    expect(midFlight?.pauseReason === "crash-loop-backoff" || midFlight?.state === "running").toBe(true);

    // 2. it eventually recovers and finishes, crashCount reset to 0.
    await until(
      async () => (await c.request("agent.status", { agentId })).result as { state: string; resultText?: string },
      (r) => r.state === "done",
    );
    const finalStatus = (await c.request("agent.status", { agentId })).result as { state: string; resultText: string; sessionId: string; costUsd: number };
    expect(finalStatus.resultText).toBe("recovered-over-rpc");

    const finalHealth = ((await c.request("health.status")).result as HealthRow[]).find((r) => r.agentId === agentId);
    expect(finalHealth?.state).toBe("done");
    expect(finalHealth?.crashCount).toBe(0);
    expect(finalHealth?.circuitOpen).toBe(false);

    // 3. replay.agentsAsOf, driven purely off the EARLY-frozen state.json + the event log
    // written since, reconstructs the SAME final state the live agent.status just returned —
    // the divergence property, exercised end-to-end through the wire protocol.
    const replayed = ((await c.request("replay.agentsAsOf")).result as Array<Record<string, unknown>>).find((r) => r["agentId"] === agentId);
    expect(replayed?.["state"]).toBe(finalStatus.state);
    expect(replayed?.["sessionId"]).toBe(finalStatus.sessionId);
    expect(replayed?.["resultText"]).toBe(finalStatus.resultText);
    expect(replayed?.["costUsd"]).toBe(finalStatus.costUsd);

    c.end();
    await server.close();
  }, 20_000);

  it("crossing maxRestarts trips the circuit breaker end-to-end: health.status shows circuitOpen, agent.status shows failed", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    const crashLoopPolicy: CrashLoopPolicy = { maxRestarts: 1, baseDelayMs: 10, maxDelayMs: 50 };
    const fake = new FakeAgentBackend([
      [{ fail: { message: "process exited with code 1" } }],
      [{ fail: { message: "process exited with code 1" } }],
      [{ fail: { message: "process exited with code 1" } }],
    ]);
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", fake]]), crashLoopPolicy });
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);

    const spawned = await c.request("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } });
    const agentId = (spawned.result as { agentId: string }).agentId;

    await until(
      async () => (await c.request("agent.status", { agentId })).result as { state: string },
      (r) => r.state === "failed",
    );

    const health = ((await c.request("health.status")).result as Array<{ agentId: string; circuitOpen: boolean; crashCount: number }>)
      .find((r) => r.agentId === agentId);
    expect(health?.circuitOpen).toBe(true);
    expect(health?.crashCount).toBe(2);

    const tail = (await c.request("agent.tail", { agentId, n: 50 })).result as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(tail.some((e) => e.kind === "circuit_breaker_tripped")).toBe(true);

    c.end();
    await server.close();
  }, 20_000);
});
