import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake", CHIMERA_TREE_ID: "tree-mcp" } as Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parse = (r: { content?: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

// TOKEN-OPT-P2/W2-5: non-essential coordination/admin tools are "extended" tier -- not
// registered as their own MCP tool names, only reachable via chimera_call. This helper
// mirrors client.callTool's shape so every call site below stays a one-line swap.
function viaMeta(client: Client, tool: string, toolArgs: Record<string, unknown>) {
  return client.callTool({ name: "chimera_call", arguments: { tool, args: toolArgs } });
}

describe("chimera MCP coordination tools", () => {
  it("exposes team/queue tools and drives a queue task to done over stdio", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", SERVER], env }));

    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["team_list", "queue_push", "chimera_tools", "chimera_call"])
      expect(tools).toContain(t);
    for (const t of ["team_create", "team_status", "team_dissolve", "queue_create", "queue_status", "queue_cancel_task"])
      expect(tools).not.toContain(t);

    expect(parse(await viaMeta(client, "queue_create", { spec: { name: "work", retryLimit: 1 } })).name).toBe("work");
    expect(parse(await viaMeta(client, "team_create", {
      spec: { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" },
    })).name).toBe("crew");

    // Cluster A P0 live round-trip: team_update with a no-op patch (same
    // maxConcurrent it already has) over the REAL stdio server + engine (not a
    // fake-wire echo) — the roles-untouched, running-members-guard path.
    const updated = parse(await viaMeta(client, "team_update", { name: "crew", patch: { maxConcurrent: 1 } }));
    expect(updated).toMatchObject({ name: "crew", maxConcurrent: 1, queue: "work" });

    const queuesAfterCreate = parse(await viaMeta(client, "queue_list", {}));
    expect(queuesAfterCreate.map((q: { name: string }) => q.name)).toContain("work");

    const task = parse(await client.callTool({ name: "queue_push", arguments: { queue: "work", prompt: "mcp task" } }));
    expect(task.taskId).toBeTruthy();

    let done: { state: string; resultText: string | null } | undefined;
    for (let i = 0; i < 200; i++) {
      const st = parse(await viaMeta(client, "queue_status", { queue: "work", full: true }));
      done = st.tasks.find((t: { taskId: string }) => t.taskId === task.taskId);
      if (done?.state === "done") break;
      await sleep(20);
    }
    expect(done?.state).toBe("done");
    // SAFE-1 CACHE-PREFIX: a team task's prompt now carries the live roster/purpose
    // preamble (scheduler.ts's withTeamPreamble) ahead of the task text itself, instead
    // of riding the (no-longer-per-spawn-unique) system-prompt append — the fake backend
    // echoes spec.prompt verbatim, so the echo includes that preamble.
    expect(done?.resultText).toMatch(/^fake:.*\n\nmcp task$/s);

    const teams = parse(await client.callTool({ name: "team_list", arguments: {} }));
    expect(teams[0]).toMatchObject({ name: "crew", running: 0 });
    expect(parse(await viaMeta(client, "team_dissolve", { name: "crew" }))).toEqual({ ok: true });
    const gone = await viaMeta(client, "team_status", { name: "crew" });
    expect(gone.isError).toBe(true);

    // queue_update -> queue.update({name, patch}) real round-trip, then queue_delete
    // on the now-unbound, fully-drained ("work" task is done) queue.
    const workUpdated = parse(await viaMeta(client, "queue_update", { name: "work", patch: { retryLimit: 2 } }));
    expect(workUpdated).toMatchObject({ name: "work", retryLimit: 2 });
    expect(parse(await viaMeta(client, "queue_delete", { name: "work" }))).toEqual({ deleted: true });
    expect(parse(await viaMeta(client, "queue_list", {})).map((q: { name: string }) => q.name)).not.toContain("work");

    // cancel path: unbound queue → task stays pending → cancellable
    parse(await viaMeta(client, "queue_create", { spec: { name: "loose" } }));
    const loose = parse(await client.callTool({ name: "queue_push", arguments: { queue: "loose", prompt: "later" } }));
    expect(parse(await viaMeta(client, "queue_cancel_task", { taskId: loose.taskId }))).toEqual({ cancelled: true });

    // CHIMERA_TREE_ID passthrough: spawns from this server land in tree "tree-mcp"
    const rec = parse(await client.callTool({ name: "agent_spawn", arguments: { prompt: "in tree", cwd: "/tmp", isolation: "none" } }));
    const status = parse(await client.callTool({ name: "agent_status", arguments: { agentId: rec.agentId } }));
    expect(status.treeId).toBe("tree-mcp");

    await client.close();
  }, 30_000);
});

// ---------- fake daemon for exact-wire-param coverage of the 8 new tools plus the
// CHIMERA_TREE_ID passthrough on agent_spawn. Same reasoning as mcp.test.ts's
// startFakeDaemon: a real chimerad+FakeAgentBackend round-trip can't assert the
// EXACT params sent over the wire, so this minimal net.createServer stands in for
// chimerad, answering daemon.hello and echoing back {echo: method, params} for
// everything else. Duplicated locally (not imported) for the same reason
// mcp.test.ts duplicates it: @chimera/mcp's package.json intentionally does not
// depend on @chimera/protocol.
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
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-mcp-coord-fake-"));
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

// depth/maxDepthCap/treeId are computed once at module load from
// CHIMERA_DEPTH/CHIMERA_MAX_DEPTH/CHIMERA_TREE_ID, so every distinct combination
// needs its own process — env is merged per-call, not mutated globally (mirrors
// mcp.test.ts's connectMcp).
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

describe("chimera MCP coordination tools — exact wire params via a fake daemon", () => {
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

  it("team_create -> team.create({ spec })", async () => {
    const before = fake.requests.length;
    const spec = { name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" };
    const res = await viaMeta(client, "team_create", { spec });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "team.create", params: { spec } });
    expect(textOf(res)).toEqual({ echo: "team.create", params: { spec } });
  }, 20_000);

  it("team_create with no CHIMERA_AGENT_ID and no spec.createdBy forwards without a createdBy key (T9d)", async () => {
    const before = fake.requests.length;
    const spec = { name: "crew2", roles: { dev: { role: "blank", overrides: { cwd: "/tmp" } } } };
    const res = await viaMeta(client, "team_create", { spec });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ spec });
    expect((req.params as { spec: Record<string, unknown> }).spec).not.toHaveProperty("createdBy");
  }, 20_000);

  it("team_list -> team.list({})", async () => {
    const before = fake.requests.length;
    const res = await client.callTool({ name: "team_list", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "team.list", params: {} });
  }, 20_000);

  it("team_status -> team.status({ name })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "team_status", { name: "crew" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "team.status", params: { name: "crew" } });
  }, 20_000);

  it("team_dissolve -> team.dissolve({ name })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "team_dissolve", { name: "crew" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "team.dissolve", params: { name: "crew" } });
  }, 20_000);

  it("queue_create -> queue.create({ spec })", async () => {
    const before = fake.requests.length;
    const spec = { name: "work", retryLimit: 1 };
    const res = await viaMeta(client, "queue_create", { spec });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.create", params: { spec } });
  }, 20_000);

  it("queue_push -> queue.push({ queue, prompt }) minimal (priority/role/overrides omitted)", async () => {
    const before = fake.requests.length;
    const res = await client.callTool({ name: "queue_push", arguments: { queue: "work", prompt: "mcp task" } });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ queue: "work", prompt: "mcp task" });
  }, 20_000);

  it("queue_push -> queue.push forwards priority, role and overrides when provided", async () => {
    const before = fake.requests.length;
    const res = await client.callTool({
      name: "queue_push",
      arguments: { queue: "work", prompt: "full task", priority: 3, role: "dev", overrides: { model: "opus" } },
    });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ queue: "work", prompt: "full task", priority: 3, role: "dev", overrides: { model: "opus" } });
  }, 20_000);

  it("queue_status -> queue.statusSummary({ queue }) by default (TOKEN-OPT-P1)", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "queue_status", { queue: "work" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.statusSummary", params: { queue: "work" } });
  }, 20_000);

  it("queue_status forwards limit/cursor to queue.statusSummary", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "queue_status", { queue: "work", limit: 10, cursor: "10" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.statusSummary", params: { queue: "work", limit: 10, cursor: "10" } });
  }, 20_000);

  it("queue_status full:true -> queue.status({ queue })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "queue_status", { queue: "work", full: true });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.status", params: { queue: "work" } });
  }, 20_000);

  it("queue_cancel_task -> queue.cancelTask({ taskId })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "queue_cancel_task", { taskId: "task-1" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.cancelTask", params: { taskId: "task-1" } });
  }, 20_000);
});

// Cluster A: coordination & config primitives — exact wire params via a fake
// daemon, same reasoning/style as the block above.
describe("Cluster A coordination/config tools — exact wire params via a fake daemon", () => {
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

  // TOKEN-OPT-P2: every tool in this block is "extended" tier — routed via chimera_call.
  it("team_update -> team.update({ name, patch })", async () => {
    const before = fake.requests.length;
    const patch = { maxConcurrent: 2, purpose: "new purpose" };
    const res = await viaMeta(client, "team_update", { name: "crew", patch });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "team.update", params: { name: "crew", patch } });
  }, 20_000);

  it("queue_list -> queue.list({})", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "queue_list", {});
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.list", params: {} });
  }, 20_000);

  it("queue_update -> queue.update({ name, patch })", async () => {
    const before = fake.requests.length;
    const patch = { retryLimit: 3 };
    const res = await viaMeta(client, "queue_update", { name: "work", patch });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.update", params: { name: "work", patch } });
  }, 20_000);

  it("queue_delete -> queue.delete({ name })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "queue_delete", { name: "work" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "queue.delete", params: { name: "work" } });
  }, 20_000);

  it("plugins_list -> plugins.list({}) minimal (cwd omitted)", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "plugins_list", {});
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("plugins.list");
    expect(req.params).toEqual({});
  }, 20_000);

  it("plugins_list -> plugins.list({ cwd }) when provided", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "plugins_list", { cwd: "/tmp/proj" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ cwd: "/tmp/proj" });
  }, 20_000);

  it("plugins_toggle -> plugins.toggle({ id, enabled })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "plugins_toggle", { id: "command:foo", enabled: false });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "plugins.toggle", params: { id: "command:foo", enabled: false } });
  }, 20_000);

  it("config_get -> config.get({})", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "config_get", {});
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "config.get", params: {} });
  }, 20_000);

  it("config_patch -> config.patch({ patch })", async () => {
    const before = fake.requests.length;
    const patch = { ui: { theme: "dark" } };
    const res = await viaMeta(client, "config_patch", { patch });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "config.patch", params: { patch } });
  }, 20_000);

  it("memory_delete -> memory.delete({ id })", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "memory_delete", { id: "m1" });
    expect(res.isError).toBeFalsy();
    expect(fake.requests[before]).toMatchObject({ method: "memory.delete", params: { id: "m1" } });
  }, 20_000);

  it("engine_help's tools array includes all 9 Cluster A tools", async () => {
    const res = await client.callTool({ name: "engine_help", arguments: {} });
    const help = textOf(res) as { tools: string[] };
    for (const t of [
      "team_update", "queue_list", "queue_update", "queue_delete",
      "plugins_list", "plugins_toggle", "config_get", "config_patch", "memory_delete",
    ]) expect(help.tools).toContain(t);
  }, 20_000);
});

describe("my_team — resolves CHIMERA_TEAM (B2)", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
  });

  afterAll(async () => {
    await fake.close();
  });

  it("engine_help's tools array includes my_team", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const res = await client.callTool({ name: "engine_help", arguments: {} });
      const help = textOf(res) as { tools: string[] };
      expect(help.tools).toContain("my_team");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("member: CHIMERA_TEAM=\"crew\" forwards to team.status({ name: \"crew\" })", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_TEAM: "crew" });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "my_team", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "team.status", params: { name: "crew" } });
      expect(textOf(res)).toEqual({ echo: "team.status", params: { name: "crew" } });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("non-member: CHIMERA_TEAM unset returns { team: null } with NO daemon round-trip", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "my_team", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toEqual({ team: null });
      expect(fake.requests.length).toBe(before);
      expect(fake.requests.slice(before).some((r) => r.method === "team.status")).toBe(false);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("non-member: CHIMERA_TEAM=\"\" (empty string) is treated as absent, NO daemon round-trip", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_TEAM: "" });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "my_team", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toEqual({ team: null });
      expect(fake.requests.length).toBe(before);
    } finally {
      await client.close();
    }
  }, 20_000);

  // WORKER-TEAM-CONTEXT: CHIMERA_TEAM is a per-backend subprocess env entry a provider's spawn
  // code can forget to forward (found missing in BOTH claude.ts and codex.ts) — my_team falls
  // back to the AUTHORITATIVE team.mine RPC (daemon-side AgentRecord.membership lookup) keyed
  // off ctx.agentId whenever ctx.team is absent, so the tool still resolves correctly even when
  // a backend's env-forwarding regresses again. Provider-agnostic by construction (CHIMERA_TEAM/
  // CHIMERA_AGENT_ID are plain env vars this subprocess reads identically regardless of which
  // backend spawned it), so this one case stands in for both the claude and codex spawn shapes.
  it("member via agentId fallback: CHIMERA_TEAM unset but CHIMERA_AGENT_ID set forwards to team.mine({ agentId })", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "ag-77" });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "my_team", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(fake.requests[before]).toMatchObject({ method: "team.mine", params: { agentId: "ag-77" } });
      expect(textOf(res)).toEqual({ echo: "team.mine", params: { agentId: "ag-77" } });
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe("team_create createdBy injection (T9d — team owner stamp)", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
  });

  afterAll(async () => {
    await fake.close();
  });

  it("with CHIMERA_AGENT_ID set, forwards spec.createdBy stamped with the caller id", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
    try {
      const before = fake.requests.length;
      const spec = { name: "crew3", roles: { dev: { role: "blank", overrides: { cwd: "/tmp" } } } };
      const res = await viaMeta(client, "team_create", { spec });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ spec: { ...spec, createdBy: "asker1" } });
      expect(textOf(res)).toEqual({ echo: "team.create", params: { spec: { ...spec, createdBy: "asker1" } } });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("with CHIMERA_AGENT_ID set, OVERRIDES a caller-supplied spec.createdBy", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
    try {
      const before = fake.requests.length;
      const spec = { name: "crew4", roles: { dev: { role: "blank", overrides: { cwd: "/tmp" } } }, createdBy: "someone-else" };
      const res = await viaMeta(client, "team_create", { spec });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect((req.params as { spec: { createdBy: string } }).spec.createdBy).toBe("asker1");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("without CHIMERA_AGENT_ID, a caller-supplied spec.createdBy is respected (passed through unchanged)", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      const spec = { name: "crew5", roles: { dev: { role: "blank", overrides: { cwd: "/tmp" } } }, createdBy: "direct-caller" };
      const res = await viaMeta(client, "team_create", { spec });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ spec });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("with CHIMERA_AGENT_ID set to an empty string, does NOT inject createdBy (falsy env is 'absent')", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "" });
    try {
      const before = fake.requests.length;
      const spec = { name: "crew6", roles: { dev: { role: "blank", overrides: { cwd: "/tmp" } } } };
      const res = await viaMeta(client, "team_create", { spec });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ spec });
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe("assign tool (C2) — flat input building the nested AssignParams.target", () => {
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

  it("agent target: agentId + prompt forwards {target:{agentId}, prompt} with no priority key", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "assign", { agentId: "a1", prompt: "do X" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("assign");
    expect(req.params).toEqual({ target: { agentId: "a1" }, prompt: "do X" });
  }, 20_000);

  it("team target: team + role + prompt + priority forwards fully", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "assign", { team: "crew", role: "dev", prompt: "do Y", priority: 5 });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("assign");
    expect(req.params).toEqual({ target: { team: "crew", role: "dev" }, prompt: "do Y", priority: 5 });
  }, 20_000);

  it("team target without role: role key is omitted", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "assign", { team: "crew", prompt: "z" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.method).toBe("assign");
    expect(req.params).toEqual({ target: { team: "crew" }, prompt: "z" });
  }, 20_000);

  it("role is ignored (not forwarded) when agentId is also given", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "assign", { agentId: "a1", role: "dev", prompt: "do X" });
    expect(res.isError).toBeFalsy();
    const req = fake.requests[before]!;
    expect(req.params).toEqual({ target: { agentId: "a1" }, prompt: "do X" });
  }, 20_000);

  it("validation: neither agentId nor team -> isError, NO daemon round-trip", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "assign", { prompt: "orphan" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatchObject({ code: "protocol", message: "assign requires exactly one of agentId or team" });
    expect(fake.requests.length).toBe(before);
  }, 20_000);

  it("validation: both agentId and team -> isError, NO daemon round-trip", async () => {
    const before = fake.requests.length;
    const res = await viaMeta(client, "assign", { agentId: "a1", team: "crew", prompt: "ambiguous" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatchObject({ code: "protocol", message: "assign requires exactly one of agentId or team" });
    expect(fake.requests.length).toBe(before);
  }, 20_000);

  it("engine_help's tools array includes assign", async () => {
    const res = await client.callTool({ name: "engine_help", arguments: {} });
    const help = textOf(res) as { tools: string[] };
    expect(help.tools).toContain("assign");
  }, 20_000);
});

describe("memory tools (WS-MEM-WIRING) — wire params to memory.* RPCs", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
  });

  afterAll(async () => {
    await fake.close();
  });

  it("memory_add stamps author from CHIMERA_AGENT_ID and forwards text/tags/kind", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "memory_add", arguments: { text: "a fact", tags: ["x"], kind: "fact" } });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.method).toBe("memory.add");
      expect(req.params).toEqual({ author: "asker1", text: "a fact", tags: ["x"], kind: "fact" });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("memory_add minimal: only text (tags/kind omitted); author still stamped", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
    try {
      const before = fake.requests.length;
      await client.callTool({ name: "memory_add", arguments: { text: "bare note" } });
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ author: "asker1", text: "bare note" });
      expect(req.params).not.toHaveProperty("tags");
      expect(req.params).not.toHaveProperty("kind");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("memory_add with CHIMERA_AGENT_ID unset falls back to author:'external' (schema requires a non-empty author)", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      await client.callTool({ name: "memory_add", arguments: { text: "orphan note" } });
      const req = fake.requests[before]!;
      // AWARENESS fix: author:undefined used to hit MemoryAddParams' min(1) and
      // reject every grant-less MCP caller — the fallback keeps the write valid.
      expect(req.params).toEqual({ author: "external", text: "orphan note" });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("memory_edit forwards id and only the provided fields", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      const res = await viaMeta(client, "memory_edit", { id: "m1", text: "new" });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.method).toBe("memory.edit");
      expect(req.params).toEqual({ id: "m1", text: "new" });
      expect(req.params).not.toHaveProperty("tags");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("memory_search forwards query/tags/author/kind/limit when provided", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({
        name: "memory_search",
        arguments: { query: "bm25", tags: ["search"], author: "a", kind: "decision", limit: 5 },
      });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.method).toBe("memory.search");
      // TOKEN-OPT-SEARCH-EXCERPT: the agent-facing tool always asks for excerpts — a searcher
      // scans hits and memory_get reads the one it picks in full.
      expect(req.params).toEqual({ query: "bm25", tags: ["search"], author: "a", kind: "decision", limit: 5, excerpt: true });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("memory_search minimal: empty args forward only the excerpt flag (pure listing)", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      await client.callTool({ name: "memory_search", arguments: {} });
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ excerpt: true });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("engine_help's tools array includes the three memory tools", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const res = await client.callTool({ name: "engine_help", arguments: {} });
      const help = textOf(res) as { tools: string[] };
      for (const t of ["memory_add", "memory_edit", "memory_search"]) expect(help.tools).toContain(t);
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe("agent_spawn — CHIMERA_TREE_ID passthrough (independent of depth/maxDepthCap)", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
  });

  afterAll(async () => {
    await fake.close();
  });

  it("CHIMERA_TREE_ID set: treeId forwarded on agent.spawn alongside depth/maxDepthCap", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_TREE_ID: "tree-abc", CHIMERA_MAX_DEPTH: "5" });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "agent_spawn", arguments: { prompt: "in tree", cwd: "/tmp" } });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.params).toEqual({
        depth: 0, maxDepthCap: 5, treeId: "tree-abc",
        spec: { prompt: "in tree", cwd: "/tmp" },
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("CHIMERA_TREE_ID unset: treeId key entirely absent from the wire params (external caller roots its own tree)", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home });
    try {
      const before = fake.requests.length;
      const res = await client.callTool({ name: "agent_spawn", arguments: { prompt: "rooted", cwd: "/tmp" } });
      expect(res.isError).toBeFalsy();
      const req = fake.requests[before]!;
      expect(req.params).toEqual({ depth: 0, spec: { prompt: "rooted", cwd: "/tmp" } });
      expect(req.params).not.toHaveProperty("treeId");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("CHIMERA_TREE_ID=\"\" (empty string) is treated as absent, not forwarded", async () => {
    const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_TREE_ID: "" });
    try {
      const before = fake.requests.length;
      await client.callTool({ name: "agent_spawn", arguments: { prompt: "empty tree id", cwd: "/tmp" } });
      const req = fake.requests[before]!;
      expect(req.params).not.toHaveProperty("treeId");
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe("ask_agent / ask_team (D3) — peer/team ask forwarding to agent.ask / agent.askTeam", () => {
  let fake: Awaited<ReturnType<typeof startFakeDaemon>>;

  beforeAll(async () => {
    fake = await startFakeDaemon((req) => ({ result: { echo: req.method, params: req.params } }));
  });

  afterAll(async () => {
    await fake.close();
  });

  describe("ask_agent -> agent.ask({ agentId, to:{agentId}, prompt, ... })", () => {
    it("minimal call: agentId, to, prompt only (all optional fields omitted)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "ask_agent",
          arguments: { targetAgentId: "b", prompt: "pick" },
        });
        expect(res.isError).toBeFalsy();
        const req = fake.requests[before]!;
        expect(req.method).toBe("agent.ask");
        expect(req.params).toEqual({ agentId: "asker1", to: { agentId: "b" }, prompt: "pick" });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("forwards header, options, multiSelect, freeform, default and timeoutMs when provided", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "ask_agent",
          arguments: {
            targetAgentId: "b",
            prompt: "pick one",
            header: "Choice",
            options: [{ id: "go", label: "Go" }],
            multiSelect: true,
            freeform: true,
            default: { optionIds: ["go"], text: "fallback" },
            timeoutMs: 5000,
          },
        });
        expect(res.isError).toBeFalsy();
        const req = fake.requests[before]!;
        expect(req.method).toBe("agent.ask");
        expect(req.params).toEqual({
          agentId: "asker1",
          to: { agentId: "b" },
          prompt: "pick one",
          header: "Choice",
          options: [{ id: "go", label: "Go" }],
          multiSelect: true,
          freeform: true,
          default: { optionIds: ["go"], text: "fallback" },
          timeoutMs: 5000,
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("forwards freeform:false and multiSelect:false explicitly (not dropped as falsy)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
      try {
        const before = fake.requests.length;
        await client.callTool({
          name: "ask_agent",
          arguments: { targetAgentId: "b", prompt: "q", freeform: false, multiSelect: false },
        });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({
          agentId: "asker1", to: { agentId: "b" }, prompt: "q", multiSelect: false, freeform: false,
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("omits agentId from the wire params when CHIMERA_AGENT_ID is unset (to still present)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "ask_agent", arguments: { targetAgentId: "b", prompt: "no agent id" } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ to: { agentId: "b" }, prompt: "no agent id" });
        expect(req.params).not.toHaveProperty("agentId");
      } finally {
        await client.close();
      }
    }, 20_000);
  });

  describe("ask_team -> agent.askTeam({ agentId, team, role?, prompt, ... })", () => {
    it("forwards team, role and prompt", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "ask_team",
          arguments: { team: "crew", role: "dev", prompt: "idea?" },
        });
        expect(res.isError).toBeFalsy();
        const req = fake.requests[before]!;
        expect(req.method).toBe("agent.askTeam");
        expect(req.params).toEqual({ agentId: "asker1", team: "crew", role: "dev", prompt: "idea?" });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("without role: role key is omitted entirely", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "ask_team",
          arguments: { team: "crew", prompt: "idea?" },
        });
        expect(res.isError).toBeFalsy();
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ agentId: "asker1", team: "crew", prompt: "idea?" });
        expect(req.params).not.toHaveProperty("role");
      } finally {
        await client.close();
      }
    }, 20_000);

    it("forwards header, options, multiSelect, freeform, default and timeoutMs when provided", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({
          name: "ask_team",
          arguments: {
            team: "crew",
            role: "dev",
            prompt: "pick one",
            header: "Choice",
            options: [{ id: "go", label: "Go" }],
            multiSelect: true,
            freeform: true,
            default: { optionIds: ["go"], text: "fallback" },
            timeoutMs: 5000,
          },
        });
        expect(res.isError).toBeFalsy();
        const req = fake.requests[before]!;
        expect(req.method).toBe("agent.askTeam");
        expect(req.params).toEqual({
          agentId: "asker1",
          team: "crew",
          role: "dev",
          prompt: "pick one",
          header: "Choice",
          options: [{ id: "go", label: "Go" }],
          multiSelect: true,
          freeform: true,
          default: { optionIds: ["go"], text: "fallback" },
          timeoutMs: 5000,
        });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("forwards freeform:false explicitly (not dropped as falsy)", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home, CHIMERA_AGENT_ID: "asker1" });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "ask_team", arguments: { team: "crew", prompt: "q", freeform: false } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ agentId: "asker1", team: "crew", prompt: "q", freeform: false });
      } finally {
        await client.close();
      }
    }, 20_000);

    it("omits agentId from the wire params when CHIMERA_AGENT_ID is unset", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        await client.callTool({ name: "ask_team", arguments: { team: "crew", prompt: "no agent id" } });
        const req = fake.requests[before]!;
        expect(req.params).toEqual({ team: "crew", prompt: "no agent id" });
        expect(req.params).not.toHaveProperty("agentId");
      } finally {
        await client.close();
      }
    }, 20_000);
  });

  describe("engine_help", () => {
    it("tools array includes ask_agent and ask_team, and askRule mentions them", async () => {
      const client = await connectMcp({ CHIMERA_HOME: fake.home });
      try {
        const before = fake.requests.length;
        const res = await client.callTool({ name: "engine_help", arguments: {} });
        expect(res.isError).toBeFalsy();
        const help = textOf(res) as { tools: string[]; askRule: string };
        expect(help.tools).toContain("ask_agent");
        expect(help.tools).toContain("ask_team");
        expect(help.tools).toContain("ask_human"); // unchanged by this task
        expect(help.askRule).toContain("ask_agent");
        expect(help.askRule).toContain("ask_team");
        expect(fake.requests.length).toBe(before); // static: no RPC issued
      } finally {
        await client.close();
      }
    }, 20_000);
  });
});
