import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { encodeFrame, decodeFrames, type RpcFrame, type RpcResponse } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeEngineHome } from "../../core/test/helpers.js";

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
const backends = (fake: FakeAgentBackend) => new Map<string, AgentBackend>([["claude", fake]]);
const TEAM = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" };

describe("daemon restart recovery (spec §3)", () => {
  it("reverts in_progress tasks to pending and re-drains after the startup tick", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");

    // --- daemon #1: task gets stuck in_progress on a hanging agent ---
    const engine1 = new Engine({ home, backends: backends(new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "never" } }]])) });
    const server1 = await startRpcServer({ socketPath, engine: engine1 });
    const c1 = rpcClient(socketPath);
    expect((await c1.request("queue.create", { spec: { name: "work" } })).ok).toBe(true);
    expect((await c1.request("team.create", { spec: TEAM })).ok).toBe(true);
    const pushed = await c1.request("queue.push", { queue: "work", prompt: "interrupted" });
    const taskId = (pushed.result as { taskId: string }).taskId;
    for (let i = 0; i < 100; i++) {
      const st = (await c1.request("queue.status", { queue: "work" })).result as { counts: { in_progress: number } };
      if (st.counts.in_progress === 1) break;
      await sleep(20);
    }
    c1.end();
    engine1.scheduler.detach();
    await server1.close();                                   // daemon dies with the agent mid-flight

    // --- daemon #2: same home, fresh engine — revert happens on load, tick re-drains ---
    const engine2 = new Engine({ home, backends: backends(new FakeAgentBackend([])) });
    const server2 = await startRpcServer({ socketPath, engine: engine2 });
    engine2.scheduler.tick().catch(() => {});                // exactly what chimerad main.ts does on startup
    const c2 = rpcClient(socketPath);

    let final: { state: string; resultText: string | null; attempts: number } | undefined;
    for (let i = 0; i < 200; i++) {
      const st = (await c2.request("queue.status", { queue: "work" })).result as {
        tasks: Array<{ taskId: string; state: string; resultText: string | null; attempts: number }>;
      };
      final = st.tasks.find((t) => t.taskId === taskId);
      if (final?.state === "done") break;
      await sleep(20);
    }
    expect(final?.state).toBe("done");
    // The fake backend echoes spec.prompt, so exact equality guards the authored
    // task body against team-context prefixes when recovery re-drains the queue.
    expect(final?.resultText).toBe("fake:interrupted");
    expect(final?.attempts).toBe(0);                         // the restart consumed no retry budget

    const tail = (await c2.request("agent.tail", { agentId: `task:${taskId}`, n: 50 })).result as Array<{ data: Record<string, unknown> }>;
    expect(tail.some((e) => e.data["reason"] === "daemon-restart" && e.data["state"] === "pending")).toBe(true);

    c2.end();
    await server2.close();
  }, 20_000);
});
