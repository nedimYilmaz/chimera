import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ChimeraClient } from "@chimera/client";
import { makeEngineHome } from "../../core/test/helpers.js";

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" } as Record<string, string>;

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("MCP federation surface", () => {
  it("exposes the engine arg on agent_spawn and keeps local spawns working", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", SERVER], env }));

    const tools = (await client.listTools()).tools;
    const spawn = tools.find((t) => t.name === "agent_spawn")!;
    expect(JSON.stringify(spawn.inputSchema)).toContain('"engine"');    // new optional arg is advertised

    const spawned = await client.callTool({ name: "agent_spawn", arguments: { prompt: "local one", cwd: "/tmp", isolation: "none" } });
    const rec = JSON.parse((spawned.content as Array<{ text: string }>)[0]!.text);
    expect(rec.agentId).toBeTruthy();
    expect(String(rec.agentId)).not.toContain("/");                     // engine omitted -> local

    const st = await client.callTool({ name: "daemon_status", arguments: {} });
    const status = JSON.parse((st.content as Array<{ text: string }>)[0]!.text);
    expect(status).toHaveProperty("peers");                             // unfederated home -> []
    expect(status.peers).toEqual([]);

    const bad = await client.callTool({ name: "agent_spawn", arguments: { prompt: "x", cwd: "/tmp", isolation: "none", engine: "ghost" } });
    expect(bad.isError).toBe(true);                                     // unknown engine -> typed daemon error via isError
    await client.close();
  }, 30_000);
});

// ---------- fake daemon for exact-wire-param coverage of the `engine` passthrough. Same
// reasoning as mcp-coordination.test.ts's startFakeDaemon: a real chimerad+FakeAgentBackend
// round-trip can't assert the EXACT wire shape (specifically: that `engine` lands as a
// TOP-LEVEL sibling of `spec`, never folded inside it). Duplicated locally (not imported)
// because @chimera/mcp intentionally does not depend on @chimera/protocol.
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
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-fed-fake-"));
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

async function connectMcp(extraEnv: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", SERVER],
    env: { ...process.env, ...extraEnv } as Record<string, string>,
  }));
  return client;
}

describe("agent_spawn — engine passthrough exact wire shape", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;
  let client: Client;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
    client = await connectMcp({ CHIMERA_HOME: fake.home });
  });

  afterAll(async () => {
    await client.close();
    await fake.close();
  });

  it("engine provided -> top-level sibling of spec/depth/maxDepthCap, NOT folded into spec", async () => {
    const before = fake.requests.length;
    const res = await client.callTool({ name: "agent_spawn", arguments: { prompt: "remote", cwd: "/tmp", engine: "studio" } });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ depth: 0, engine: "studio", spec: { prompt: "remote", cwd: "/tmp" } });
    expect((req.params as { spec: Record<string, unknown> }).spec).not.toHaveProperty("engine");
  }, 20_000);

  it("engine omitted -> the engine key is entirely absent from the wire params", async () => {
    const before = fake.requests.length;
    const res = await client.callTool({ name: "agent_spawn", arguments: { prompt: "local", cwd: "/tmp" } });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ depth: 0, spec: { prompt: "local", cwd: "/tmp" } });
    expect(req.params).not.toHaveProperty("engine");
  }, 20_000);

  it('engine: "" (empty string) is treated as absent, not forwarded (falsy check, not a nullish check)', async () => {
    const before = fake.requests.length;
    const res = await client.callTool({ name: "agent_spawn", arguments: { prompt: "empty engine", cwd: "/tmp", engine: "" } });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).not.toHaveProperty("engine");
  }, 20_000);
});
