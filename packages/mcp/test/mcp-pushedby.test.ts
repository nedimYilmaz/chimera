import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// WD Stage 1 (coverage B9, task inspector "pushed by"): queue_push stamps the calling
// agent's id (CHIMERA_AGENT_ID) as `pushedBy` on the queue.push params — the EXACT
// createdBy discipline team_create uses (T9d, pinned in mcp-coordination.test.ts).
// Same fake-daemon wire-assert harness as that file (duplicated locally for the same
// reason it duplicates it: @chimera/mcp intentionally has no @chimera/protocol dep).

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

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

async function startFakeDaemon(): Promise<{ home: string; requests: FakeRpcRequest[]; close: () => Promise<void> }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-pushedby-"));
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
        sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { echo: req.method, params: req.params } }));
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

describe("queue_push pushedBy injection (WD Stage 1 — task provenance stamp)", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;

  beforeAll(async () => {
    fake = await startFakeDaemon();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("with CHIMERA_AGENT_ID set, forwards pushedBy stamped with the caller id", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "pusher1" });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "queue_push", arguments: { queue: "work", prompt: "job" } });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.method).toBe("queue.push");
      expect(req.params).toEqual({ queue: "work", prompt: "job", pushedBy: "pusher1" });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("without CHIMERA_AGENT_ID, forwards WITHOUT a pushedBy key (a human/CLI push keeps null provenance)", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "queue_push", arguments: { queue: "work", prompt: "job", priority: 2 } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]!.params).toEqual({ queue: "work", prompt: "job", priority: 2 });
    } finally {
      await client.close();
    }
  }, 20_000);
});
