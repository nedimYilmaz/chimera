import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Cluster C: project.* lifecycle, host.tools/host.setPolicy, agent.interrupt/
// agent.close, events.replay. Same fake-daemon exact-wire-param pattern as
// mcp.test.ts/mcp-coordination.test.ts's startFakeDaemon (duplicated locally
// for the same reason: @chimera/mcp's package.json intentionally does not
// depend on @chimera/protocol).

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
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-clusterc-fake-"));
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

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
}

// TOKEN-OPT-P2/W2-5: Cluster C is extended tier -- not registered directly, only
// reachable via chimera_call.
function viaMeta(client: Client, tool: string, toolArgs: Record<string, unknown>) {
  return client.callTool({ name: "chimera_call", arguments: { tool, args: toolArgs } });
}

describe("Cluster C tools — exact wire params via a fake daemon", () => {
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

  it("all Cluster C tools are extended tier (reachable via chimera_call)", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of [
      "project_create", "project_import", "project_list", "project_status",
      "project_assign_team", "project_archive", "host_tools", "host_set_policy",
      "agent_interrupt", "agent_close", "events_replay",
    ]) expect(tools).not.toContain(t);
  }, 20_000);

  it("project_create -> project.create({ name, path }) minimal (teams/queue omitted)", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_create", { name: "proj1", path: "/tmp/proj1" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("project.create");
    expect(req.params).toEqual({ name: "proj1", path: "/tmp/proj1" });
  }, 20_000);

  it("project_create forwards teams and queue when provided", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_create", { name: "proj2", path: "/tmp/proj2", teams: ["crew"], queue: "work" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ name: "proj2", path: "/tmp/proj2", teams: ["crew"], queue: "work" });
  }, 20_000);

  it("project_import -> project.import({ source }) minimal (name/team omitted)", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_import", { source: "https://example.com/repo.git" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("project.import");
    expect(req.params).toEqual({ source: "https://example.com/repo.git" });
  }, 20_000);

  it("project_import forwards name and team when provided", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_import", { source: "/local/dir", name: "imported", team: "crew" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ source: "/local/dir", name: "imported", team: "crew" });
  }, 20_000);

  it("project_list -> project.list({})", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_list", {});
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "project.list", params: {} });
  }, 20_000);

  it("project_status -> project.status({ name })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_status", { name: "proj1" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "project.status", params: { name: "proj1" } });
  }, 20_000);

  it("project_assign_team -> project.assignTeam({ project, team })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_assign_team", { project: "proj1", team: "crew" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "project.assignTeam", params: { project: "proj1", team: "crew" } });
  }, 20_000);

  it("project_archive -> project.archive({ name })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "project_archive", { name: "proj1" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "project.archive", params: { name: "proj1" } });
  }, 20_000);

  it("host_tools -> host.tools({})", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "host_tools", {});
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "host.tools", params: {} });
  }, 20_000);

  it("host_set_policy -> host.setPolicy({ tool, profile, mode })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "host_set_policy", { tool: "git", profile: "*", mode: "ask" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("host.setPolicy");
    expect(req.params).toEqual({ tool: "git", profile: "*", mode: "ask" });
    expect(textOf(res)).toEqual({ echo: "host.setPolicy", params: { tool: "git", profile: "*", mode: "ask" } });
  }, 20_000);

  it("host_set_policy rejects an unrecognized mode (union validated by zod inside chimera_call, no RPC issued)", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "host_set_policy", { tool: "git", profile: "*", mode: "bogus" });
    expect(res.isError).toBe(true);
    expect(fake.requests.length).toBe(before);
  }, 20_000);

  // PARITY WS-H: agent_interrupt must forward to agent.interrupt (NOT agent.kill) —
  // the whole point of this tool is that it is non-destructive and distinct from kill.
  it("agent_interrupt (extended tier) -> agent.interrupt({ agentId}), distinct from agent.kill", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "agent_interrupt", { agentId: "agent-i1" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("agent.interrupt");
    expect(req.method).not.toBe("agent.kill");
    expect(req.params).toEqual({ agentId: "agent-i1" });
  }, 20_000);

  it("agent_close -> agent.close({ agentId })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "agent_close", { agentId: "agent-c1" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "agent.close", params: { agentId: "agent-c1" } });
  }, 20_000);

  it("events_replay -> events.replay({}) minimal (all fields omitted)", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "events_replay", {});
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("events.replay");
    expect(req.params).toEqual({});
  }, 20_000);

  it("events_replay forwards fromSeq, toSeq, agentId and limit when provided", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "events_replay", { fromSeq: 10, toSeq: 20, agentId: "agent-r1", limit: 100 });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ fromSeq: 10, toSeq: 20, agentId: "agent-r1", limit: 100 });
  }, 20_000);

  it("engine_help's tools array includes all 11 Cluster C tools", async () => {
    const res = await client.callTool({ name: "engine_help", arguments: {} });
    const help = textOf(res) as { tools: string[] };
    for (const t of [
      "project_create", "project_import", "project_list", "project_status",
      "project_assign_team", "project_archive", "host_tools", "host_set_policy",
      "agent_interrupt", "agent_close", "events_replay",
    ]) expect(help.tools).toContain(t);
  }, 20_000);
});
