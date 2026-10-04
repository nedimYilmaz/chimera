import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// F25: review_get/review_finding_add/review_finding_resolve — exact wire params over a fake
// daemon, cloning the harness from mcp-cluster-c.test.ts (duplicated locally for the same
// reason: @chimera/mcp's package.json intentionally does not depend on @chimera/protocol).

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

async function startFakeDaemon(
  respond: (req: FakeRpcRequest) => { result?: unknown; error?: { code: string; message: string } },
): Promise<{ home: string; requests: FakeRpcRequest[]; close: () => Promise<void> }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-review-fake-"));
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

function viaMeta(client: Client, tool: string, toolArgs: Record<string, unknown>) {
  return client.callTool({ name: "chimera_call", arguments: { tool, args: toolArgs } });
}

describe("review_get/review_finding_add/review_finding_resolve — exact wire params", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;
  let client: Client;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
    client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "agent-a" });
  });

  afterAll(async () => {
    await client.close();
    await fake.close();
  });

  it("all three review tools are extended tier (reachable only via chimera_call)", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("review_get");
    expect(tools).not.toContain("review_finding_add");
    expect(tools).not.toContain("review_finding_resolve");
  }, 20_000);

  it("review_get with a taskId forwards taskId + agentId from CHIMERA_AGENT_ID", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "review_get", { taskId: "t1" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("review.get");
    expect(req.params).toEqual({ taskId: "t1", agentId: "agent-a" });
  }, 20_000);

  it("review_get with NO taskId forwards only agentId (engine resolves the binding)", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "review_get", {});
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ agentId: "agent-a" });
  }, 20_000);

  it("review_finding_add stamps authorAgentId from CHIMERA_AGENT_ID", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "review_finding_add", {
      taskId: "t1", path: "src/x.ts", severity: "blocking", body: "fix this",
    });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("review.finding.add");
    expect(req.params).toEqual({
      taskId: "t1", path: "src/x.ts", severity: "blocking", body: "fix this", authorAgentId: "agent-a",
    });
  }, 20_000);

  it("review_finding_resolve stamps actorAgentId from CHIMERA_AGENT_ID", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "review_finding_resolve", { taskId: "t1", findingId: "f1" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("review.finding.resolve");
    expect(req.params).toEqual({ taskId: "t1", findingId: "f1", actorAgentId: "agent-a" });
  }, 20_000);
});

describe("review tools without CHIMERA_AGENT_ID (operator/no-identity caller)", () => {
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

  it("review_get without CHIMERA_AGENT_ID forwards only taskId", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "review_get", { taskId: "t1" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]!.params).toEqual({ taskId: "t1" });
  }, 20_000);

  it("review_finding_resolve without CHIMERA_AGENT_ID forwards without actorAgentId", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "review_finding_resolve", { taskId: "t1", findingId: "f1" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]!.params).toEqual({ taskId: "t1", findingId: "f1" });
  }, 20_000);
});
