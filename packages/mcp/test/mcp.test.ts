import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ChimeraClient } from "@chimera/client";
import { CORE_MCP_TOOL_NAMES, EXTENDED_MCP_TOOL_NAMES } from "@chimera/protocol/mcp-tools";
import { makeEngineHome } from "../../core/test/helpers.js";

const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("../bin/chimera-mcp.js", import.meta.url));
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" } as Record<string, string>;

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("chimera MCP server", () => {
  it("lists tools and drives a spawn end-to-end over stdio", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", SERVER], env,
    }));
    expect(client.getInstructions()).toBeUndefined();

    // TOKEN-OPT-P2: only "core" tools (+ the chimera_tools/chimera_call meta-pair) are
    // registered directly; extended (admin/CRUD) tools like accounts_list/agent_set_model
    // are NOT top-level tool names anymore -- covered separately via chimera_call below.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["agent_spawn", "agent_wait", "agent_result", "agent_send", "daemon_status", "ask_human", "answer_question", "engine_help", "chimera_tools", "chimera_call"])
      expect(tools).toContain(t);
    for (const t of ["accounts_list", "agent_list", "agent_kill", "agent_permission_respond", "agent_set_permission", "agent_set_model", "agent_remote_control", "answer_dialog"])
      expect(tools).not.toContain(t);

    const spawned = await client.callTool({ name: "agent_spawn", arguments: { prompt: "via mcp", cwd: "/tmp", isolation: "none" } });
    const rec = JSON.parse((spawned.content as Array<{ text: string }>)[0]!.text);
    expect(rec.agentId).toBeTruthy();

    const waited = await client.callTool({ name: "agent_wait", arguments: { agentId: rec.agentId, timeoutMs: 5000 } });
    const final = JSON.parse((waited.content as Array<{ text: string }>)[0]!.text);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("fake:via mcp");

    const bad = await client.callTool({ name: "agent_status", arguments: { agentId: "ghost" } });
    expect(bad.isError).toBe(true);

    // an extended (demoted) tool is still reachable -- via chimera_tools discovery, then chimera_call.
    const discovered = await client.callTool({ name: "chimera_tools", arguments: { query: "accounts_list" } });
    const catalog = JSON.parse((discovered.content as Array<{ text: string }>)[0]!.text) as { tools: Array<{ name: string }> };
    expect(catalog.tools.map((t) => t.name)).toContain("accounts_list");
    const viaMeta = await client.callTool({ name: "chimera_call", arguments: { tool: "accounts_list", args: {} } });
    expect(viaMeta.isError).toBeFalsy();

    // W2-5: a formerly direct lifecycle tool remains discoverable and callable after
    // the eager-name trim, not merely present in a static catalog.
    const discoveredLifecycle = await client.callTool({ name: "chimera_tools", arguments: { query: "agent_list" } });
    const lifecycleCatalog = JSON.parse((discoveredLifecycle.content as Array<{ text: string }>)[0]!.text) as { tools: Array<{ name: string }> };
    expect(lifecycleCatalog.tools.map((t) => t.name)).toContain("agent_list");
    const listedViaMeta = await client.callTool({ name: "chimera_call", arguments: { tool: "agent_list", args: {} } });
    expect(listedViaMeta.isError).toBeFalsy();

    await client.close();
  }, 30_000);

  it("discovers and executes diagnostics over real stdio MCP without changing live state", async () => {
    const client = new Client({ name: "diagnostics", version: "0.0.1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", SERVER], env }));
    const rpc = await ChimeraClient.connect({ home, env, autostart: false });
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: "chimera_call", arguments: { tool, args } });
      expect(result.isError, `${tool}: ${JSON.stringify(result.content)}`).toBeFalsy();
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    try {
      const spawned = await rpc.call("agent.spawn", { spec: { prompt: "diagnostic-needle", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
      await rpc.call("agent.wait", { agentId: spawned.agentId, timeoutMs: 5000 });
      await call("queue_create", { spec: { name: "diagnostic-evidence" } });
      const task = await rpc.call("queue.push", { queue: "diagnostic-evidence", prompt: "pending evidence" }) as { taskId: string };
      const names = ["health_status", "events_search", "events_search_export", "evidence_get", "audit_verify", "replay_agents_as_of", "chronicle_status", "sli_rollup", "memory_stats", "memory_graph", "memory_index_status", "mcp_store_monitor"];
      const direct = (await client.listTools()).tools.map(t => t.name);
      for (const name of names) {
        expect(direct).not.toContain(name);
        const found = await client.callTool({ name: "chimera_tools", arguments: { query: name } });
        const catalog = JSON.parse((found.content as Array<{ text: string }>)[0]!.text);
        expect(catalog.tools.map((t: { name: string }) => t.name)).toContain(name);
      }
      const health = await call("health_status");
      expect(health).toContainEqual(expect.objectContaining({ agentId: spawned.agentId, state: "done", crashCount: 0 }));
      const hits = await call("events_search", { query: "diagnostic-needle", scope: { agentIds: [spawned.agentId] }, limit: 1 });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0].agentId).toBe(spawned.agentId);
      const empty = await call("events_search", { query: "diagnostic-needle", scope: { agentIds: ["not-this-agent"] } });
      expect(empty.hits).toEqual([]);
      const exported = await call("events_search_export", { query: "diagnostic-needle", maxResults: 1 });
      expect(exported.filename).toMatch(/\.md$/);
      expect(exported.content).toContain("diagnostic-needle");
      expect((await call("evidence_get", { taskId: task.taskId })).taskId).toBe(task.taskId);
      expect(await call("audit_verify")).toHaveProperty("ok", true);
      expect(Array.isArray(await call("replay_agents_as_of"))).toBe(true);
      expect(await call("chronicle_status")).toBeTypeOf("object");
      expect(await call("sli_rollup", { groupBy: "provider" })).toBeTypeOf("object");
      expect(await call("memory_stats")).toBeTypeOf("object");
      expect(await call("memory_graph", { folder: "diagnostic-empty" })).toMatchObject({ nodes: [], edges: [] });
      expect(await call("memory_index_status", { action: "rebuild" })).toMatchObject({ state: "off" });
      expect(await call("mcp_store_monitor")).toMatchObject({ held: false, owner: null, busy: false, activities: [] });
      // Diagnosis must not wake an agent or take a desktop lease.
      expect(await call("health_status")).toEqual(health);
      const bad = await client.callTool({ name: "chimera_call", arguments: { tool: "events_search", args: { query: "x", limit: 101 } } });
      expect(bad.isError).toBe(true);
    } finally { rpc.close(); await client.close(); }
  }, 30_000);

  // HOOK-3 (PLAN-HOOKS.md §10) live-daemon smoke: a subscribe call issued through the REAL
  // stdio MCP tool, against the REAL (fake-backend) daemon this describe block already boots,
  // proves the whole wait-elimination path end to end -- ctx-stamped subscriberId -> sub.create
  // -> SubscriptionRegistry -> a real queue_drained event -> mailbox signal delivered -> once:true
  // auto-removed. subscriptions_list going 1 -> 0 IS the observable proof of delivery (no direct
  // mailbox-read RPC exists; this is the same proof engine-subscriptions.test.ts uses at the
  // Engine layer, now exercised through the MCP tool layer HOOK-3 actually added).
  it("subscribe -> a real queue_drained event delivers a signal, auto-removing the once:true subscription (subscriptions_list observes it)", async () => {
    const watcher = new Client({ name: "test-watcher", version: "0.0.1" });
    await watcher.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", SERVER],
      env: { ...env, CHIMERA_AGENT_ID: "hook3-watcher" },
    }));
    const rpc = await ChimeraClient.connect({ home, env, autostart: false });
    try {
      const sub = await watcher.callTool({
        name: "subscribe",
        arguments: { topic: "queue.drained", filter: { queue: "hook3-q" }, once: true },
      });
      expect(sub.isError).toBeFalsy();

      const listBefore = await watcher.callTool({ name: "chimera_call", arguments: { tool: "subscriptions_list", args: {} } });
      expect(JSON.parse((listBefore.content as Array<{ text: string }>)[0]!.text)).toHaveLength(1);

      await rpc.request("queue.create", { spec: { name: "hook3-q", retryLimit: 0 } });
      await rpc.request("team.create", { spec: {
        name: "hook3-team",
        roles: { dev: { role: "blank", overrides: { cwd: home, account: "main", isolation: "none" } } },
        maxConcurrent: 1, queue: "hook3-q",
      } });
      const task = await rpc.request<{ taskId: string }>("queue.push", { queue: "hook3-q", prompt: "go" });

      const deadline = Date.now() + 20_000;
      let done = false;
      while (Date.now() < deadline && !done) {
        const status = await rpc.request<{ tasks: Array<{ taskId: string; state: string }> }>("queue.status", { queue: "hook3-q" });
        done = status.tasks.find((t) => t.taskId === task.taskId)?.state === "done";
        if (!done) await new Promise((r) => setTimeout(r, 100));
      }
      expect(done).toBe(true);

      const listAfter = await watcher.callTool({ name: "chimera_call", arguments: { tool: "subscriptions_list", args: {} } });
      expect(JSON.parse((listAfter.content as Array<{ text: string }>)[0]!.text)).toHaveLength(0);
    } finally {
      rpc.close();
      await watcher.close();
    }
  }, 30_000);
});

// ---------- fake daemon for the remaining-tool / agent_spawn param-building coverage:
// spawning a real chimerad+FakeAgentBackend for every branch would race the fake
// backend's near-instant agent_started->turn_complete->result script (the same
// reasoning documented in packages/client/test/cli.test.ts's startFakeDaemon), and
// gives us no way to assert the EXACT wire params the server sent. This minimal
// net.createServer stands in for chimerad: it answers daemon.hello (so
// ChimeraClient.connect() succeeds without ever attempting an autostart) and
// records every other request, echoing back {echo: method, params} so each call's
// round-trip through the server's call()/json() helper is verifiable too.
// @chimera/mcp's package.json (verbatim per the brief) intentionally does not
// depend on @chimera/protocol, so the wire framing is duplicated locally here
// rather than imported — it is the same trivial NDJSON format
// (packages/protocol/src/index.ts's encodeFrame/decodeFrames), reimplemented so
// this test file doesn't need to add a workspace dependency.
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
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-fake-"));
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

// Connects a fresh MCP client to a fresh `server.ts` process. depth/maxDepthCap are
// computed once at module load from CHIMERA_DEPTH/CHIMERA_MAX_DEPTH, so every distinct
// combination needs its own process — env is merged per-call, not mutated globally.
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

describe("chimera MCP server — coverage via a fake daemon", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
  });

  afterAll(async () => {
    await fake.close();
  });

  it("W2-5 keeps instructions empty and a demoted tool discoverable/callable over stdio", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      expect(client.getInstructions()).toBeUndefined();
      const registered = (await client.listTools()).tools.map((t) => t.name);
      expect(registered).not.toContain("agent_list");

      const discovered = await client.callTool({ name: "chimera_tools", arguments: { query: "agent_list" } });
      const catalog = textOf(discovered) as { tools: Array<{ name: string }> };
      expect(catalog.tools.map((t) => t.name)).toContain("agent_list");

      const before = fake.requests.length;
      const called = await client.callTool({ name: "chimera_call", arguments: { tool: "agent_list", args: {} } });
      expect(called.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.listSummary", params: {} });
    } finally {
      await client.close();
    }
  }, 20_000);

  describe("every remaining tool — happy call", () => {
    let toolsClient: Client;

    beforeAll(async () => {
      toolsClient = await connectMcp({ CHIMERA_HOME: fake.home });
    });

    afterAll(async () => {
      await toolsClient.close();
    });

    it("daemon_status -> daemon.status({})", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "daemon_status", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "daemon.status", params: {} });
      expect(textOf(res)).toEqual({ echo: "daemon.status", params: {} });
    }, 20_000);

    it("accounts_list (extended tier) -> accounts.list({}) via chimera_call", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "chimera_call", arguments: { tool: "accounts_list", args: {} } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "accounts.list", params: {} });
      expect(textOf(res)).toEqual({ echo: "accounts.list", params: {} });
    }, 20_000);

    it("agent_list (extended tier) -> agent.listSummary({}) by default via chimera_call (TOKEN-OPT-P1)", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "chimera_call", arguments: { tool: "agent_list", args: {} } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.listSummary", params: {} });
      expect(textOf(res)).toEqual({ echo: "agent.listSummary", params: {} });
    }, 20_000);

    it("agent_list full:true (extended tier) -> agent.list({}) via chimera_call", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "chimera_call", arguments: { tool: "agent_list", args: { full: true } } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.list", params: {} });
      expect(textOf(res)).toEqual({ echo: "agent.list", params: {} });
    }, 20_000);

    it("agent_result -> agent.result({ agentId })", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "agent_result", arguments: { agentId: "agent-r1" } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.result", params: { agentId: "agent-r1" } });
      expect(textOf(res)).toEqual({ echo: "agent.result", params: { agentId: "agent-r1" } });
    }, 20_000);

    it("agent_tail (extended tier) -> agent.tail({ agentId, n }) via chimera_call", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "chimera_call", arguments: { tool: "agent_tail", args: { agentId: "agent-t1", n: 5 } } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.tail", params: { agentId: "agent-t1", n: 5 } });
    }, 20_000);

    it("agent_send -> agent.send({ agentId, text })", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "agent_send", arguments: { agentId: "agent-s1", text: "hello" } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.send", params: { agentId: "agent-s1", text: "hello" } });
    }, 20_000);

    it("agent_send preserves explicit force intent through MCP", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "agent_send", arguments: { agentId: "agent-s1", text: "steer now", force: true } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.send", params: { agentId: "agent-s1", text: "steer now", force: true } });
    }, 20_000);

    it("agent_kill (extended tier) -> agent.kill({ agentId }) via chimera_call", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({ name: "chimera_call", arguments: { tool: "agent_kill", args: { agentId: "agent-k1" } } });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.kill", params: { agentId: "agent-k1" } });
    }, 20_000);

    it("agent_permission_respond (extended tier) -> agent.permissionRespond({ requestId, allow }) via chimera_call", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_permission_respond", args: { requestId: "req-1", allow: true } },
      });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "agent.permissionRespond", params: { requestId: "req-1", allow: true } });
    }, 20_000);

    // FC-1 (un-dead agent.setPermission): the engine's runtime permission-change RPC
    // was fully built but no client ever called it -- these four cover every branch
    // of the tool's two independent optional spreads (neither / either / both). Extended
    // tier (TOKEN-OPT-P2) — routed through chimera_call like every other admin/CRUD tool.
    it("agent_set_permission (extended tier) -> agent.setPermission({ agentId, permissionProfile, permissionRequest }) (both optional fields provided)", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_set_permission", args: { agentId: "agent-p1", permissionProfile: "full", onPermissionRequest: "auto" } },
      });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({
        method: "agent.setPermission",
        params: { agentId: "agent-p1", permissionProfile: "full", permissionRequest: "auto" },
      });
      expect(textOf(res)).toEqual({
        echo: "agent.setPermission",
        params: { agentId: "agent-p1", permissionProfile: "full", permissionRequest: "auto" },
      });
    }, 20_000);

    it("agent_set_permission (extended tier) -> agentId only (both optional fields omitted)", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_set_permission", args: { agentId: "agent-p2" } },
      });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ agentId: "agent-p2" });
      expect(req.params).not.toHaveProperty("permissionProfile");
      expect(req.params).not.toHaveProperty("permissionRequest");
    }, 20_000);

    it("agent_set_permission (extended tier) -> permissionProfile only (onPermissionRequest omitted)", async () => {
      const before = fake.requests.length;
      await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_set_permission", args: { agentId: "agent-p3", permissionProfile: "readOnly" } },
      });
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ agentId: "agent-p3", permissionProfile: "readOnly" });
      expect(req.params).not.toHaveProperty("permissionRequest");
    }, 20_000);

    it("agent_set_permission (extended tier) -> onPermissionRequest only (permissionProfile omitted), mapped to permissionRequest", async () => {
      const before = fake.requests.length;
      await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_set_permission", args: { agentId: "agent-p4", onPermissionRequest: "poke:caller" } },
      });
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ agentId: "agent-p4", permissionRequest: "poke:caller" });
      expect(req.params).not.toHaveProperty("permissionProfile");
    }, 20_000);

    // Task MCPGAP (un-dead agent.setModel): the daemon RPC was fully built + tested but
    // no MCP tool ever called it -- this covers the 1:1 forward of both required fields.
    // Extended tier (TOKEN-OPT-P2) — routed through chimera_call.
    it("agent_set_model (extended tier) -> agent.setModel({ agentId, model }) via chimera_call", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_set_model", args: { agentId: "agent-m1", model: "claude-sonnet-5" } },
      });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({
        method: "agent.setModel",
        params: { agentId: "agent-m1", model: "claude-sonnet-5" },
      });
      expect(textOf(res)).toEqual({ echo: "agent.setModel", params: { agentId: "agent-m1", model: "claude-sonnet-5" } });
    }, 20_000);

    // REMOTE-CONTROL: the daemon RPC forwards agentId/enable, and `name` only when provided.
    // Extended tier (TOKEN-OPT-P2) — routed through chimera_call.
    it("agent_remote_control (extended tier) -> agent.remoteControl({ agentId, enable }) (name omitted)", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_remote_control", args: { agentId: "agent-rc1", enable: true } },
      });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req).toMatchObject({ method: "agent.remoteControl", params: { agentId: "agent-rc1", enable: true } });
      expect(req.params).not.toHaveProperty("name");
      expect(textOf(res)).toEqual({ echo: "agent.remoteControl", params: { agentId: "agent-rc1", enable: true } });
    }, 20_000);

    it("agent_remote_control (extended tier) -> agent.remoteControl({ agentId, enable, name }) (name provided)", async () => {
      const before = fake.requests.length;
      const res = await toolsClient.callTool({
        name: "chimera_call",
        arguments: { tool: "agent_remote_control", args: { agentId: "agent-rc2", enable: false, name: "custom" } },
      });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({
        method: "agent.remoteControl",
        params: { agentId: "agent-rc2", enable: false, name: "custom" },
      });
    }, 20_000);
  });

  describe("interactive question tools (spec §17)", () => {
    it("ask_human -> agent.ask({ agentId, prompt, options }) using CHIMERA_AGENT_ID", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "ag-77" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "ask_human",
          arguments: { prompt: "ship?", options: [{ id: "go", label: "Go" }], multiSelect: false },
        });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]).toMatchObject({
          method: "agent.ask",
          params: { agentId: "ag-77", prompt: "ship?", options: [{ id: "go", label: "Go" }], multiSelect: false },
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("ask_human forwards only the provided optional fields (minimal call)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "ag-min" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "ask_human", arguments: { prompt: "free text?" } });
        expect(fake.requests[before]!.params).toEqual({ agentId: "ag-min", prompt: "free text?" });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("ask_human forwards header (no length cap), freeform, default, and timeoutMs when provided", async () => {
      // regression for controller front-load fix (i): header must NOT be capped at
      // 12 chars here — a cap only at this layer (while the Engine's AskParams has
      // none) would reject a header the daemon would otherwise accept.
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "ag-full" });
      try {
        const before = fake.requests.length;
        const longHeader = "a very long header well beyond twelve characters";
        const res = await client.callTool({
          name: "ask_human",
          arguments: {
            prompt: "pick one",
            header: longHeader,
            freeform: true,
            default: { optionIds: ["go"], text: "fallback" },
            timeoutMs: 5000,
          },
        });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]!.params).toEqual({
          agentId: "ag-full",
          prompt: "pick one",
          header: longHeader,
          freeform: true,
          default: { optionIds: ["go"], text: "fallback" },
          timeoutMs: 5000,
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("ask_human forwards freeform:false explicitly (not dropped as a falsy value)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "ag-ff" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "ask_human", arguments: { prompt: "q", freeform: false } });
        expect(fake.requests[before]!.params).toEqual({ agentId: "ag-ff", prompt: "q", freeform: false });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("ask_human omits agentId from the wire params when CHIMERA_AGENT_ID is unset", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "ask_human", arguments: { prompt: "no agent id" } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ prompt: "no agent id" }); // agentId:undefined dropped by JSON.stringify on the wire
        expect(req.params).not.toHaveProperty("agentId");
      } finally {
        await client.close();
      }
    }, 20_000);

    it("answer_question -> agent.answerQuestion({ questionId, answer })", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "answer_question",
          arguments: { questionId: "q-1", answer: { optionIds: ["go"], text: "with note" } },
        });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]).toMatchObject({
          method: "agent.answerQuestion",
          params: { questionId: "q-1", answer: { optionIds: ["go"], text: "with note" } },
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("answer_question forwards an answer with only text (no optionIds)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "answer_question", arguments: { questionId: "q-2", answer: { text: "just text" } } });
        expect(fake.requests[before]!.params).toEqual({ questionId: "q-2", answer: { text: "just text" } });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("answer_question forwards an empty answer object (a skip/no-op answer)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "answer_question", arguments: { questionId: "q-3", answer: {} } });
        expect(fake.requests[before]!.params).toEqual({ questionId: "q-3", answer: {} });
      } finally {
        await client.close();
      }
    }, 20_000);

    // Task MCPGAP (un-dead agent.answerDialog): the daemon RPC was fully built + tested
    // but no MCP tool ever called it -- both decision union branches covered.
    // answer_dialog is extended tier (TOKEN-OPT-P2) — not registered directly, routed via chimera_call.
    it("answer_dialog (extended tier) -> agent.answerDialog({ dialogId, decision }) with a 'completed' decision", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "chimera_call",
          arguments: { tool: "answer_dialog", args: { dialogId: "d1", decision: { behavior: "completed", result: { answers: {} } } } },
        });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]).toMatchObject({
          method: "agent.answerDialog",
          params: { dialogId: "d1", decision: { behavior: "completed", result: { answers: {} } } },
        });
        expect(textOf(res)).toEqual({
          echo: "agent.answerDialog",
          params: { dialogId: "d1", decision: { behavior: "completed", result: { answers: {} } } },
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("answer_dialog (extended tier) -> agent.answerDialog({ dialogId, decision }) with a 'cancelled' decision (no result field)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "chimera_call",
          arguments: { tool: "answer_dialog", args: { dialogId: "d2", decision: { behavior: "cancelled" } } },
        });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]).toMatchObject({
          method: "agent.answerDialog",
          params: { dialogId: "d2", decision: { behavior: "cancelled" } },
        });
        const req = fake.requests[before]!;
        expect((req.params as { decision: unknown }).decision).toEqual({ behavior: "cancelled" });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("answer_dialog (extended tier) rejects an unrecognized decision.behavior (union validated by zod inside chimera_call, no RPC issued)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "chimera_call",
          arguments: { tool: "answer_dialog", args: { dialogId: "d3", decision: { behavior: "bogus" } } },
        });
        // chimera_call validates the target tool's own inputSchema itself (mcp-tools.ts)
        // and returns a clean tool-error result rather than throwing -- the malformed
        // union never reaches call()/the daemon.
        expect(res.isError).toBe(true);
        expect(fake.requests.length).toBe(before); // rejected before any daemon round-trip
      } finally {
        await client.close();
      }
    }, 20_000);

    it("engine_help returns a static tool catalogue WITHOUT hitting the daemon", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({ name: "engine_help", arguments: {} });
        expect(res.isError).toBeFalsy();
        const help = textOf(res) as { tools: string[]; depthRule: string; permissionRule: string };
        expect(help.tools).toContain("ask_human");
        expect(help.tools).toContain("agent_spawn");
        expect(typeof help.depthRule).toBe("string");
        expect(typeof help.permissionRule).toBe("string");
        expect(fake.requests.length).toBe(before); // static: no RPC issued
      } finally {
        await client.close();
      }
    }, 20_000);

    it("engine_help's tool catalogue lists every registered tool, including itself, ask_human and answer_question, plus the askRule", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const res = await client.callTool({ name: "engine_help", arguments: {} });
        const help = textOf(res) as { tools: string[]; askRule: string };
        for (const t of [
          "daemon_status", "accounts_list", "agent_spawn", "agent_list", "agent_status",
          "agent_result", "agent_wait", "agent_tail", "agent_send", "agent_permission_respond",
          "agent_kill", "agent_set_model", "agent_remote_control", "ask_human", "answer_question", "answer_dialog", "engine_help",
        ]) expect(help.tools).toContain(t);
        expect(typeof help.askRule).toBe("string");
      } finally {
        await client.close();
      }
    }, 20_000);

    // Task MCPGAP completeness guard, updated for TOKEN-OPT-P2: engine_help.tools is the
    // FULL catalog (browse/discovery, unchanged in spirit), but what's actually REGISTERED
    // on the wire is now only the "core" tier (mcp-server-factory.ts filters on tool.tier).
    // Three invariants replace the old 1:1 equality: (1) registered === CORE_MCP_TOOL_NAMES
    // exactly, (2) every registered name is also in help.tools, (3) every "extended" name is
    // in help.tools but NOT registered directly -- it's discoverable via chimera_tools and
    // reachable only via chimera_call.
    it("registered tools are EXACTLY the core tier; extended tools are catalogued but not directly registered (completeness guard)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const helpRes = await client.callTool({ name: "engine_help", arguments: {} });
        const help = textOf(helpRes) as { tools: string[] };
        const registered = (await client.listTools()).tools.map((t) => t.name);
        expect(new Set(registered)).toEqual(new Set(CORE_MCP_TOOL_NAMES));
        expect(registered.length).toBe(CORE_MCP_TOOL_NAMES.length);
        for (const name of registered) expect(help.tools).toContain(name);
        for (const name of EXTENDED_MCP_TOOL_NAMES) {
          expect(help.tools).toContain(name);
          expect(registered).not.toContain(name);
        }
      } finally {
        await client.close();
      }
    }, 20_000);
  });

  describe("subscription tools (HOOK-3, PLAN-HOOKS.md §6.2) — the wait-elimination primitive", () => {
    it("subscribe -> sub.create({ subscriberId, topic, filter, once, wake }) using CHIMERA_AGENT_ID", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "watcher-1" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "subscribe",
          arguments: { topic: "gate.verdict", filter: { taskId: "t-1" }, once: true, wake: "resume" },
        });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]).toMatchObject({
          method: "sub.create",
          params: { subscriberId: "watcher-1", topic: "gate.verdict", filter: { taskId: "t-1" }, once: true, wake: "resume" },
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("subscribe forwards only the provided optional fields (minimal call)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "watcher-min" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "subscribe", arguments: { topic: "queue.drained" } });
        expect(fake.requests[before]!.params).toEqual({ subscriberId: "watcher-min", topic: "queue.drained" });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("subscribe omits subscriberId from the wire params when CHIMERA_AGENT_ID is unset (a clean protocol error downstream, not a crash)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "subscribe", arguments: { topic: "queue.drained" } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ topic: "queue.drained" });
        expect(req.params).not.toHaveProperty("subscriberId");
      } finally {
        await client.close();
      }
    }, 20_000);

    it("unsubscribe (extended tier) -> sub.remove({ subscriberId, id })", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "watcher-2" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({ name: "chimera_call", arguments: { tool: "unsubscribe", args: { id: "sub-1" } } });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]).toMatchObject({ method: "sub.remove", params: { subscriberId: "watcher-2", id: "sub-1" } });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("subscriptions_list (extended tier) -> sub.list({ subscriberId })", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "watcher-3" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({ name: "chimera_call", arguments: { tool: "subscriptions_list", args: {} } });
        expect(res.isError).toBeFalsy();
        expect(fake.requests[before]).toMatchObject({ method: "sub.list", params: { subscriberId: "watcher-3" } });
      } finally {
        await client.close();
      }
    }, 20_000);
  });

  describe("agent_spawn — depth / maxDepthCap / orchestration param-building", () => {
    it("external caller (no CHIMERA_DEPTH/CHIMERA_MAX_DEPTH): depth=0, maxDepthCap absent, minimal spec", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({ name: "agent_spawn", arguments: { prompt: "min", cwd: "/tmp" } });
        expect(res.isError).toBeFalsy();
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ depth: 0, spec: { prompt: "min", cwd: "/tmp" } });
        expect(req.params).not.toHaveProperty("maxDepthCap"); // undefined key is dropped by JSON.stringify on the wire
      } finally {
        await client.close();
      }
    }, 20_000);

    it("CHIMERA_DEPTH='0' boundary: depth becomes 1 (Number('0')+1), not misread as unset", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_DEPTH: "0" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "agent_spawn", arguments: { prompt: "boundary", cwd: "/tmp" } });
        const req = fake.requests[before]!;
        expect(req.params).toMatchObject({ depth: 1 });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("CHIMERA_MAX_DEPTH forwarded as maxDepthCap independently of CHIMERA_DEPTH", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_MAX_DEPTH: "5" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "agent_spawn", arguments: { prompt: "cap", cwd: "/tmp" } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ depth: 0, maxDepthCap: 5, spec: { prompt: "cap", cwd: "/tmp" } });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("a chimera-spawned agent's own MCP (CHIMERA_DEPTH=3, CHIMERA_MAX_DEPTH=5): depth=parent+1, maxDepthCap forwarded, every optional spec field mapped, explicit orchestration grant", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_DEPTH: "3", CHIMERA_MAX_DEPTH: "5" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "agent_spawn",
          arguments: {
            prompt: "full", cwd: "/work",
            account: "second", isolation: "worktree", model: "opus",
            instructions: "be careful", permissionProfile: "full",
            deliverTo: "caller-agent", onPermissionRequest: "poke:caller",
            orchestrationAllow: true, orchestrationMaxDepth: 4,
          },
        });
        expect(res.isError).toBeFalsy();
        const req = fake.requests[before]!;
        expect(req.params).toEqual({
          depth: 4, maxDepthCap: 5,
          spec: {
            prompt: "full", cwd: "/work",
            account: "second", isolation: "worktree", model: "opus",
            instructions: "be careful", permissionProfile: "full",
            deliverTo: "caller-agent", on: { permissionRequest: "poke:caller" },
            orchestration: { allow: true, maxDepth: 4 },
          },
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("orchestrationAllow alone defaults orchestrationMaxDepth to 2, and every other optional spec field is omitted", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_DEPTH: "3", CHIMERA_MAX_DEPTH: "5" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "agent_spawn", arguments: { prompt: "orch-allow-only", cwd: "/tmp", orchestrationAllow: true } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({
          depth: 4, maxDepthCap: 5,
          spec: { prompt: "orch-allow-only", cwd: "/tmp", orchestration: { allow: true, maxDepth: 2 } },
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("orchestrationMaxDepth alone defaults orchestrationAllow to false", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_DEPTH: "3", CHIMERA_MAX_DEPTH: "5" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "agent_spawn", arguments: { prompt: "orch-depth-only", cwd: "/tmp", orchestrationMaxDepth: 7 } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({
          depth: 4, maxDepthCap: 5,
          spec: { prompt: "orch-depth-only", cwd: "/tmp", orchestration: { allow: false, maxDepth: 7 } },
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("neither orchestrationAllow nor orchestrationMaxDepth present -> spec.orchestration entirely omitted (a child cannot silently acquire a default grant)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_DEPTH: "3", CHIMERA_MAX_DEPTH: "5" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "agent_spawn", arguments: { prompt: "no-orch", cwd: "/tmp" } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ depth: 4, maxDepthCap: 5, spec: { prompt: "no-orch", cwd: "/tmp" } });
      } finally {
        await client.close();
      }
    }, 20_000);
  });

  // P1 reliability (packages/mcp/src/server.ts call()): the server holds ONE persistent
  // daemon connection for its whole process lifetime. Before this fix, a dropped
  // connection (daemon restart, idle socket error) permanently failed every subsequent
  // tool call with {code:"disconnected"} -- surfaced by the SDK as "Stream closed". This
  // drives a real dropped-connection scenario against a fake daemon that answers
  // normally on a fresh connection, proving call() reconnects and retries once.
  describe("reconnects after the daemon connection drops", () => {
    it("a request that dies mid-call with {code:'disconnected'} triggers one reconnect + retry that succeeds", async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-reconnect-"));
      const socketPath = join(fakeHome, "daemon.sock");
      let connectionCount = 0;
      const sockets = new Set<Socket>();
      const server = createServer((sock) => {
        connectionCount++;
        const myConn = connectionCount;
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
            if (myConn === 1) { sock.destroy(); continue; }   // the ONLY drop: first connection's first real request
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { echo: req.method, params: req.params } }));
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
      try {
        const client = await connectMcp({ CHIMERA_HOME: fakeHome });
        try {
          const res = await client.callTool({ name: "daemon_status", arguments: {} });
          expect(res.isError).toBeFalsy();
          expect(textOf(res)).toEqual({ echo: "daemon.status", params: {} });
          expect(connectionCount).toBe(2); // 1: dropped on first call, 2: the reconnect
        } finally {
          await client.close();
        }
      } finally {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 20_000);
  });

  describe("bin launcher smoke test", () => {
    it("runs via bin/chimera-mcp.js under plain node (no --import tsx in argv) and lists tools", async () => {
      // F1-class guard (same as the CLI's bin/chimera.js): the OS execs the shebang as
      // plain `node bin/chimera-mcp.js` with NO tsx loader in argv — the launcher must
      // register tsx itself before importing src/server.ts (a .ts file).
      const client = new Client({ name: "test", version: "0.0.1" });
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [LAUNCHER],
        env: { ...process.env, CHIMERA_HOME: fake.home } as Record<string, string>,
      }));
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("daemon_status");
      expect(tools).toContain("agent_spawn");
      await client.close();
    }, 20_000);
  });
});
