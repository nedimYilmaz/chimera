import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ChimeraClient } from "@chimera/client";
import { makeMultiProviderHome } from "../../core/test/helpers.js";

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const home = makeMultiProviderHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" } as Record<string, string>;

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("chimera MCP provider args", () => {
  it("agent_spawn accepts provider and crossProviderFailover and routes to codex", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", SERVER], env,
    }));

    const spawned = await client.callTool({
      name: "agent_spawn",
      arguments: { prompt: "via mcp codex", cwd: "/tmp", isolation: "none", provider: "codex", crossProviderFailover: true },
    });
    const rec = JSON.parse((spawned.content as Array<{ text: string }>)[0]!.text);
    expect(rec.provider).toBe("codex");
    expect(rec.spec.crossProviderFailover).toBe(true);

    const waited = await client.callTool({ name: "agent_wait", arguments: { agentId: rec.agentId, timeoutMs: 5000 } });
    const final = JSON.parse((waited.content as Array<{ text: string }>)[0]!.text);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("fake:via mcp codex");
    await client.close();
  }, 30_000);

  // ---------- additional coverage beyond the brief's one example test ----------

  it("agent_spawn with explicit provider \"claude\" and no crossProviderFailover routes to claude, unaffected by the multi-provider home's autoOrder", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", SERVER], env,
    }));
    try {
      const spawned = await client.callTool({
        name: "agent_spawn",
        arguments: { prompt: "via mcp claude", cwd: "/tmp", isolation: "none", provider: "claude" },
      });
      const rec = JSON.parse((spawned.content as Array<{ text: string }>)[0]!.text);
      expect(rec.provider).toBe("claude");
      // crossProviderFailover was never sent, but AgentSpecSchema fills its own
      // default(false) once the record round-trips through the daemon — the
      // resolved spec always carries the key, just at its default value.
      expect(rec.spec.crossProviderFailover).toBe(false);

      const waited = await client.callTool({ name: "agent_wait", arguments: { agentId: rec.agentId, timeoutMs: 5000 } });
      const final = JSON.parse((waited.content as Array<{ text: string }>)[0]!.text);
      expect(final.state).toBe("done");
      expect(final.resultText).toBe("fake:via mcp claude");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("agent_spawn rejects a provider value outside claude|codex (zod enum, before any daemon round-trip)", async () => {
    expect.assertions(2);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", SERVER], env,
    }));
    try {
      // The SDK's own inputSchema validation catches this BEFORE server.ts's handler
      // runs at all — surfaced as a tool result with isError:true (not a rejected
      // promise), carrying the zod issue text so a caller can see WHY it was rejected.
      const res = await client.callTool({
        name: "agent_spawn",
        arguments: { prompt: "bad provider", cwd: "/tmp", isolation: "none", provider: "gpt4" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain("provider");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("agent_spawn's tool description documents the codex onPermissionRequest no-op", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", SERVER], env,
    }));
    try {
      const tools = (await client.listTools()).tools;
      const spawnTool = tools.find((t) => t.name === "agent_spawn");
      expect(spawnTool?.description).toContain("onPermissionRequest is ignored");
      expect(spawnTool?.description).toContain("permissionProfile");
    } finally {
      await client.close();
    }
  }, 30_000);
});

// ---------- param-building coverage via a fake daemon: mirrors mcp.test.ts's
// pattern (spawning a real chimerad+FakeAgentBackend for every provider/
// crossProviderFailover combination would race the fake backend's near-instant
// script and gives no way to assert the EXACT wire params sent). This minimal
// net.createServer stands in for chimerad, answering daemon.hello and echoing
// back every other request so agent_spawn's provider/crossProviderFailover
// param-building branches are verifiable independent of daemon-side routing.
type FakeRpcRequest = { id: string; type: "request"; method: string; params?: unknown };
type FakeRpcFrame =
  | FakeRpcRequest
  | { id: string; type: "response"; ok: boolean; result?: unknown; error?: { code: string; message: string } };

function encodeFrame(frame: FakeRpcFrame): string {
  return JSON.stringify(frame) + "\n";
}

function decodeFrames(buffer: string): { frames: FakeRpcFrame[]; rest: string } {
  const frames: FakeRpcFrame[] = [];
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line.length > 0) frames.push(JSON.parse(line) as FakeRpcFrame);
  }
  return { frames, rest };
}

async function startFakeDaemon(
  respond: (req: FakeRpcRequest) => { result?: unknown; error?: { code: string; message: string } },
): Promise<{ home: string; requests: FakeRpcRequest[]; close: () => Promise<void> }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-provider-fake-"));
  const socketPath = join(fakeHome, "daemon.sock");
  const requests: FakeRpcRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        const req = f as FakeRpcRequest;
        if (req.type !== "request") continue;
        if (req.method === "daemon.hello") {
          sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
          continue;
        }
        requests.push(req);
        const r = respond(req);
        sock.write(encodeFrame(r.error
          ? { id: req.id, type: "response", ok: false, error: r.error }
          : { id: req.id, type: "response", ok: true, result: r.result }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    home: fakeHome,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

describe("agent_spawn provider / crossProviderFailover — param-building via a fake daemon", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;
  let client: Client;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
    client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", SERVER],
      env: { ...process.env, CHIMERA_HOME: fake.home } as Record<string, string>,
    }));
  });

  afterAll(async () => {
    await client.close();
    await fake.close();
  });

  it("neither provider nor crossProviderFailover given -> both keys entirely absent from spec", async () => {
    const before = fake.requests.length;
    const res = await client.callTool({ name: "agent_spawn", arguments: { prompt: "neither", cwd: "/tmp" } });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ depth: 0, spec: { prompt: "neither", cwd: "/tmp" } });
    expect((req.params as { spec: Record<string, unknown> }).spec).not.toHaveProperty("provider");
    expect((req.params as { spec: Record<string, unknown> }).spec).not.toHaveProperty("crossProviderFailover");
  }, 20_000);

  it("provider \"claude\" alone forwards spec.provider without touching crossProviderFailover", async () => {
    const before = fake.requests.length;
    await client.callTool({ name: "agent_spawn", arguments: { prompt: "claude-only", cwd: "/tmp", provider: "claude" } });
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ depth: 0, spec: { prompt: "claude-only", cwd: "/tmp", provider: "claude" } });
  }, 20_000);

  it("provider \"codex\" alone forwards spec.provider", async () => {
    const before = fake.requests.length;
    await client.callTool({ name: "agent_spawn", arguments: { prompt: "codex-only", cwd: "/tmp", provider: "codex" } });
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ depth: 0, spec: { prompt: "codex-only", cwd: "/tmp", provider: "codex" } });
  }, 20_000);

  it("crossProviderFailover:true alone forwards spec.crossProviderFailover without a provider key", async () => {
    const before = fake.requests.length;
    await client.callTool({ name: "agent_spawn", arguments: { prompt: "cpf-true", cwd: "/tmp", crossProviderFailover: true } });
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ depth: 0, spec: { prompt: "cpf-true", cwd: "/tmp", crossProviderFailover: true } });
  }, 20_000);

  it("crossProviderFailover:false is forwarded explicitly (not dropped as a falsy value)", async () => {
    const before = fake.requests.length;
    await client.callTool({ name: "agent_spawn", arguments: { prompt: "cpf-false", cwd: "/tmp", crossProviderFailover: false } });
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ depth: 0, spec: { prompt: "cpf-false", cwd: "/tmp", crossProviderFailover: false } });
  }, 20_000);

  it("provider and crossProviderFailover both given forward both keys alongside every other optional spec field", async () => {
    const before = fake.requests.length;
    const res = await client.callTool({
      name: "agent_spawn",
      arguments: {
        prompt: "both", cwd: "/work", account: "second", isolation: "worktree", model: "opus",
        instructions: "careful", permissionProfile: "full", deliverTo: "caller-agent",
        onPermissionRequest: "poke:caller", orchestrationAllow: true, orchestrationMaxDepth: 4,
        provider: "codex", crossProviderFailover: true,
      },
    });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({
      depth: 0,
      spec: {
        prompt: "both", cwd: "/work", account: "second", isolation: "worktree", model: "opus",
        instructions: "careful", permissionProfile: "full", deliverTo: "caller-agent",
        on: { permissionRequest: "poke:caller" }, orchestration: { allow: true, maxDepth: 4 },
        provider: "codex", crossProviderFailover: true,
      },
    });
  }, 20_000);
});
