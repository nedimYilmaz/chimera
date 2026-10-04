import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { encodeFrame, decodeFrames, type RpcFrame, type RpcResponse } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeEngineHome } from "../../core/test/helpers.js";

// R2 EFFORT — deterministic full-boot blackbox rig: real RPC over the real daemon socket,
// driven with a FakeAgentBackend, mirroring self-heal-blackbox.test.ts's exact shape (per the
// QA gate's requirement that a daemon/system-behavior feature ship a test in this style rather
// than one that reaches into engine internals).
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

describe("R2 EFFORT: agent.setEffort — daemon-level blackbox", () => {
  it("respawns the SAME agentId under the new effort, resuming its session, over the real RPC socket", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    // Scenario 1 (initial spawn): reports a sessionId, then parks (stays "running") so
    // setEffort has a live session to kill+resume. Scenario 2 (post-setEffort respawn):
    // same shape, under a NEW sessionId, so the resumed turn is observably distinct.
    const initial: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "sess-initial" } } },
      { awaitSend: true },
    ];
    const respawned: FakeStep[] = [
      { emit: { kind: "agent_started", data: { sessionId: "sess-resumed" } } },
      { awaitSend: true },
    ];
    const fake = new FakeAgentBackend([initial, respawned]);
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", fake]]) });
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);

    // 1. spawn with an initial effort — asserts the field survives the RPC round-trip.
    const spawned = await c.request("agent.spawn", {
      spec: { prompt: "x", cwd: "/tmp", isolation: "none", effort: "low" },
    });
    const agentId = (spawned.result as { agentId: string; spec: { effort: string } }).agentId;
    expect((spawned.result as { spec: { effort: string } }).spec.effort).toBe("low");

    await until(
      async () => (await c.request("agent.status", { agentId })).result as { sessionId?: string },
      (r) => r.sessionId === "sess-initial",
    );

    // 2. change effort over the wire.
    const setResp = await c.request("agent.setEffort", { agentId, effort: "xhigh" });
    const updated = setResp.result as { agentId: string; spec: { effort: string } };

    // (a) the RPC response record reflects the new effort.
    expect(updated.agentId).toBe(agentId);           // SAME agentId — transcript/identity continuity
    expect(updated.spec.effort).toBe("xhigh");

    // (b) the actual ResolvedAgentSpec the SECOND spawn received carries the new effort and
    // resumes the prior session — the "next turn carries the new effort" contract from the plan,
    // observed via the FakeAgentBackend's own spawns[] record (never reaching into engine
    // internals — this is the backend's own public spawn-call log).
    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1]?.effort).toBe("xhigh");
    expect(fake.spawns[1]?.resume).toBe("sess-initial");
    expect(fake.spawns[1]?.resumeOnly).toBe(true);

    // (c) agent.status for the SAME agentId shows the new effort and the resumed session.
    await until(
      async () => (await c.request("agent.status", { agentId })).result as { sessionId?: string },
      (r) => r.sessionId === "sess-resumed",
    );
    const finalStatus = (await c.request("agent.status", { agentId })).result as {
      agentId: string; sessionId: string; spec: { effort: string }; state: string;
    };
    expect(finalStatus.agentId).toBe(agentId);        // (d) same agentId end to end
    expect(finalStatus.spec.effort).toBe("xhigh");
    expect(finalStatus.state).toBe("running");

    c.end();
    await server.close();
  }, 20_000);
});
