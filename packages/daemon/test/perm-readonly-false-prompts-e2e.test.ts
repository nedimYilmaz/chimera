import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { encodeFrame, decodeFrames, type RpcFrame, type RpcResponse } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeEngineHome } from "../../core/test/helpers.js";

// PERM-READONLY-FALSE-PROMPTS end-to-end proof: a REAL chimerad-shaped process (Engine +
// startRpcServer, the actual production RPC/supervisor wiring — the same startRpcServer
// main.ts boots) spawning a REAL agent record and exercising the REAL decidePermission gate,
// via the wire protocol exactly as a client (app/tui) would. The backend is FakeAgentBackend
// (scripted, no real LLM call) rather than a live Claude/Codex backend — deliberately: the
// permission GATE's decision is made from the Bash command STRING alone, BEFORE anything
// executes (hosttools.ts classifyCloudMutation/isReadOnlyBash never run the command), so a
// scripted tool call reaching the gate is behaviorally identical to a real LLM emitting the
// same tool call. This proves the actual bug (a screenshot-exact aws athena call raising a
// false permission card) is fixed in the real server path, not just in a unit-level classifier
// test — without spending real API tokens or requiring live AWS/GCP credentials.
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

describe("PERM-READONLY-FALSE-PROMPTS: real daemon process, full-permission agent", () => {
  it("does not raise a permission card for the screenshot's read-only aws command, but does for a mutating one", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    const readCmd = "aws athena batch-get-query-execution --query-execution-ids abc123 --profile prod --region eu-west-1";
    const mutateCmd = "aws ec2 terminate-instances --instance-ids i-0123456789abcdef0";
    const fake = new FakeAgentBackend([
      [{ askPermission: { toolName: "Bash", input: { command: readCmd } } }, { end: { resultText: "read done" } }],
      [{ askPermission: { toolName: "Bash", input: { command: mutateCmd } } }, { end: { resultText: "mutate done" } }],
    ]);
    const backends = new Map<string, AgentBackend>([["claude", fake]]);
    const engine = new Engine({ home, backends });
    const server = await startRpcServer({ socketPath, engine });
    const client = rpcClient(socketPath);

    // --- agent 1: full permission, screenshot's read-only command ---
    const spawn1 = await client.request("agent.spawn", {
      spec: {
        prompt: "run the read command", cwd: "/tmp", isolation: "none",
        permissionProfile: "full", on: { permissionRequest: "auto" },
      },
    });
    const agentId1 = (spawn1.result as { agentId: string }).agentId;
    let final1: { state: string } | undefined;
    for (let i = 0; i < 100; i++) {
      final1 = (await client.request("agent.status", { agentId: agentId1 })).result as { state: string };
      if (final1.state === "done" || final1.state === "failed") break;
      await sleep(20);
    }
    expect(final1?.state).toBe("done");
    const tail1 = (await client.request("agent.tail", { agentId: agentId1, n: 100 })).result as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(tail1.some((e) => e.kind === "permission_request")).toBe(false);
    expect(tail1.some((e) => e.kind === "tool_call")).toBe(true);

    // --- agent 2: full permission, a real mutating cloud command ---
    const spawn2 = await client.request("agent.spawn", {
      spec: {
        prompt: "run the mutating command", cwd: "/tmp", isolation: "none",
        permissionProfile: "full", on: { permissionRequest: "auto" },
      },
    });
    const agentId2 = (spawn2.result as { agentId: string }).agentId;
    // Let the CLOUD-MUTATION-GATE's card actually appear before deciding — don't respond,
    // just observe it, then deny explicitly so the (fake) mutation never "runs".
    let sawCard = false;
    for (let i = 0; i < 100; i++) {
      const tail = (await client.request("agent.tail", { agentId: agentId2, n: 100 })).result as Array<{ kind: string; data: Record<string, unknown> }>;
      const req = tail.find((e) => e.kind === "permission_request");
      if (req) { sawCard = true; await client.request("agent.permissionRespond", { requestId: req.data["requestId"], allow: false }); break; }
      await sleep(20);
    }
    expect(sawCard).toBe(true);

    client.end();
    await server.close();
  }, 20_000);
});
