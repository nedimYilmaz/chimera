import { describe, it, expect, beforeEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStoreRegistry, McpStoreConnectionManager, DuplicateMcpStoreServerError, UnknownMcpStoreServerError } from "@chimera/core/mcpstore";
import { InMemoryKeychain, mcpStoreAuthService } from "@chimera/core/keychain";
import { computerUseEntries, desktopSocket } from "@chimera/core/computer-use";

// MCP-STORE P1/P2: the persisted registry (mcpstore.json, same discipline as
// plugins.json) + the daemon-hosted connection manager (lazy-connect, cache, idle-teardown
// -- ONE @modelcontextprotocol/sdk Client per server serving every caller). Same SDK-mock
// harness as generic-mcp.test.ts's McpHost tests: no real subprocess is ever spawned.

const queue: Array<{
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  connectError?: string | Error | { code: number; message: string };
  listError?: string;
  callError?: string | Error;
  callToolResult?: unknown;
  connectWait?: Promise<void>;
  listWait?: Promise<void>;
  callWait?: Promise<void>;
}> = [];
const mockClients: Array<{ cfg: (typeof queue)[number]; closeCalls: number; calls: unknown[]; onclose?: () => void }> = [];

function enqueueClientConfig(cfg: (typeof queue)[number]): void {
  queue.push(cfg);
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class MockClient {
    cfg: (typeof queue)[number];
    closeCalls = 0;
    calls: unknown[] = [];
    onclose?: () => void;
    constructor() {
      this.cfg = queue.shift() ?? {};
      mockClients.push(this as unknown as (typeof mockClients)[number]);
    }
    async connect(transport: unknown) {
      this.calls.push({ connect: transport });
      await this.cfg.connectWait;
      if (this.cfg.connectError) {
        if (typeof this.cfg.connectError === "string") throw new Error(this.cfg.connectError);
        throw this.cfg.connectError;
      }
    }
    async listTools() {
      await this.cfg.listWait;
      if (this.cfg.listError) throw new Error(this.cfg.listError);
      return { tools: this.cfg.tools ?? [] };
    }
    async callTool(params: unknown) {
      this.calls.push(params);
      await this.cfg.callWait;
      if (this.cfg.callError) throw typeof this.cfg.callError === "string" ? new Error(this.cfg.callError) : this.cfg.callError;
      return this.cfg.callToolResult ?? { content: [{ type: "text", text: "ok" }] };
    }
    async close() {
      this.closeCalls++;
      this.onclose?.();
    }
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  class MockStdioClientTransport {
    constructor(public params: unknown) {}
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

const mockStreamableTransports: Array<{ url: URL; options: unknown }> = [];
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  class MockStreamableHTTPClientTransport {
    constructor(public url: URL, public options: unknown) {
      mockStreamableTransports.push({ url, options });
    }
  }
  return { StreamableHTTPClientTransport: MockStreamableHTTPClientTransport };
});

const mockSseTransports: Array<{ url: URL; options: unknown }> = [];
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => {
  class MockSSEClientTransport {
    constructor(public url: URL, public options: unknown) {
      mockSseTransports.push({ url, options });
    }
  }
  return { SSEClientTransport: MockSSEClientTransport };
});

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "chimera-mcpstore-home-"));
}

beforeEach(() => {
  queue.length = 0;
  mockClients.length = 0;
  mockStreamableTransports.length = 0;
  mockSseTransports.length = 0;
});

describe("MCP connection teardown races", () => {
  it.each(["connectWait", "listWait"] as const)("does not resurrect a server closed during %s", async (phase) => {
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    enqueueClientConfig({ [phase]: wait });
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {}, enabled: true, direct: false, trust: "full" });
    const mgr = new McpStoreConnectionManager(reg, new InMemoryKeychain());
    const discovery = mgr.tools();
    await Promise.resolve(); await Promise.resolve();
    reg.setEnabled("s", false);
    const closing = mgr.closeServer("s");
    release();
    await closing;
    expect((await discovery)[0]).toMatchObject({ connected: false });
    expect(mockClients[0]?.closeCalls).toBeGreaterThan(0);
    expect((await mgr.call("s", "anything", {})).isError).toBe(true);
    expect(mockClients).toHaveLength(1);
    await mgr.closeAll();
  });

  it("closeAll also waits for connections that are still opening", async () => {
    let release!: () => void;
    enqueueClientConfig({ connectWait: new Promise<void>((r) => { release = r; }) });
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {}, enabled: true, direct: false, trust: "full" });
    const mgr = new McpStoreConnectionManager(reg, new InMemoryKeychain());
    const opening = mgr.tools(); const closing = mgr.closeAll();
    release(); await closing;
    expect((await opening)[0]?.connected).toBe(false);
    expect(mockClients[0]?.closeCalls).toBeGreaterThan(0);
  });
});

describe("McpStoreRegistry", () => {
  it("loads a legacy persisted entry without type as stdio", () => {
    const home = makeHome();
    writeFileSync(join(home, "mcpstore.json"), JSON.stringify({ legacy: { command: "node" } }));
    expect(new McpStoreRegistry(home).list()).toEqual([
      { name: "legacy", type: "stdio", command: "node", args: [], env: {}, direct: false, enabled: true, trust: "full" },
    ]);
  });

  it("round-trips an http entry with headers", () => {
    const home = makeHome();
    const reg = new McpStoreRegistry(home);
    reg.add({ name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } });
    expect(new McpStoreRegistry(home).list()).toEqual([
      { name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" }, direct: false, enabled: true, trust: "full" },
    ]);
  });

  it("add/list/remove, sorted by name, persisted across a restart", () => {
    const home = makeHome();
    const reg = new McpStoreRegistry(home);
    reg.add({ name: "zeta", type: "stdio", command: "node", args: ["z.js"], env: {} });
    reg.add({ name: "alpha", type: "stdio", command: "node", args: ["a.js"], env: { KEY: "v" } });
    expect(reg.list().map((e) => e.name)).toEqual(["alpha", "zeta"]);

    const reg2 = new McpStoreRegistry(home);
    expect(reg2.list()).toEqual([
      { name: "alpha", type: "stdio", command: "node", args: ["a.js"], env: { KEY: "v" }, direct: false, enabled: true, trust: "full" },
      { name: "zeta", type: "stdio", command: "node", args: ["z.js"], env: {}, direct: false, enabled: true, trust: "full" },
    ]);

    expect(reg2.remove("alpha")).toEqual({ name: "alpha", removed: true });
    expect(reg2.remove("alpha")).toEqual({ name: "alpha", removed: false });
    expect(reg2.list().map((e) => e.name)).toEqual(["zeta"]);
  });

  it("rejects a duplicate name", () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "dup", type: "stdio", command: "node", args: [], env: {} });
    expect(() => reg.add({ name: "dup", type: "stdio", command: "node", args: [], env: {} })).toThrow(DuplicateMcpStoreServerError);
  });

  it("rejects a non-kebab name", () => {
    const reg = new McpStoreRegistry(makeHome());
    expect(() => reg.add({ name: "Not_Valid!", type: "stdio", command: "node", args: [], env: {} })).toThrow();
  });

  it("direct defaults false on add, and setDirect flips + persists it across a restart (MCP-STORE-DIRECT-TOGGLE)", () => {
    const home = makeHome();
    const reg = new McpStoreRegistry(home);
    reg.add({ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {} });
    expect(reg.list()).toEqual([{ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {}, direct: false, enabled: true, trust: "full" }]);

    expect(reg.setDirect("chrome-devtools", true)).toEqual({ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {}, direct: true, enabled: true, trust: "full" });
    expect(reg.list()[0]?.direct).toBe(true);

    const reg2 = new McpStoreRegistry(home);           // persisted across a restart
    expect(reg2.list()[0]?.direct).toBe(true);

    reg2.setDirect("chrome-devtools", false);
    expect(new McpStoreRegistry(home).list()[0]?.direct).toBe(false);
  });

  it("setDirect on an unknown server throws instead of silently no-oping", () => {
    const reg = new McpStoreRegistry(makeHome());
    expect(() => reg.setDirect("nope", true)).toThrow(UnknownMcpStoreServerError);
  });

  it("enabled defaults true on add, and setEnabled flips + persists it across a restart (MCPSTORE-LIFECYCLE-UI)", () => {
    const home = makeHome();
    const reg = new McpStoreRegistry(home);
    reg.add({ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {} });
    expect(reg.list()).toEqual([{ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {}, direct: false, enabled: true, trust: "full" }]);

    expect(reg.setEnabled("chrome-devtools", false)).toEqual({ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {}, direct: false, enabled: false, trust: "full" });
    expect(reg.list()[0]?.enabled).toBe(false);

    const reg2 = new McpStoreRegistry(home);           // persisted across a restart
    expect(reg2.list()[0]?.enabled).toBe(false);

    reg2.setEnabled("chrome-devtools", true);
    expect(new McpStoreRegistry(home).list()[0]?.enabled).toBe(true);
  });

  it("setEnabled on an unknown server throws instead of silently no-oping", () => {
    const reg = new McpStoreRegistry(makeHome());
    expect(() => reg.setEnabled("nope", false)).toThrow(UnknownMcpStoreServerError);
  });

  it("a corrupt mcpstore.json fails the constructor loudly", () => {
    const home = makeHome();
    new McpStoreRegistry(home).add({ name: "x", type: "stdio", command: "node", args: [], env: {} });
    const file = join(home, "mcpstore.json");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.slice(0, -1));           // truncate -> invalid JSON
    expect(() => new McpStoreRegistry(home)).toThrow(/corrupt coordination state/);
  });
});

describe("McpStoreConnectionManager", () => {
  function managerOn(reg: McpStoreRegistry, opts: { idleMs?: number } = {}) {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const setTimer = (fn: () => void, ms: number) => {
      const h = { fn, ms, cleared: false };
      timers.push(h);
      return h;
    };
    const clearTimer = (h: unknown) => { (h as { cleared: boolean }).cleared = true; };
    const mgr = new McpStoreConnectionManager(reg, new InMemoryKeychain(), { idleMs: opts.idleMs ?? 5000, setTimer, clearTimer });
    return { mgr, timers, fireLatest: () => { const h = timers[timers.length - 1]; if (h && !h.cleared) h.fn(); } };
  }

  it("lazily connects on first tools() call and reuses the connection on the next", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "echo-server", type: "stdio", command: "node", args: ["echo.js"], env: {} });
    enqueueClientConfig({ tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }] });
    const { mgr } = managerOn(reg);

    expect(mockClients.length).toBe(0);
    const first = await mgr.tools();
    expect(mockClients.length).toBe(1);
    expect(first).toEqual([{ server: "echo-server", connected: true, tools: [{ server: "echo-server", name: "echo", description: "echoes", inputSchema: { type: "object" } }] }]);

    const second = await mgr.tools();
    expect(mockClients.length).toBe(1);            // reused, not a second connect
    expect(second[0]?.connected).toBe(true);
  });

  it("connects http with streamable HTTP and passes headers", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } });
    enqueueClientConfig({ tools: [] });
    const { mgr } = managerOn(reg);

    expect((await mgr.tools())[0]).toMatchObject({ server: "remote", connected: true });
    expect(mockStreamableTransports).toHaveLength(1);
    expect(mockStreamableTransports[0]?.url.href).toBe("https://mcp.example.com/mcp");
    expect(mockStreamableTransports[0]?.options).toEqual({ requestInit: { headers: { Authorization: "Bearer x" } } });
    expect(mockSseTransports).toHaveLength(0);
  });

  it("falls back to SSE after a streamable HTTP 405 rejection", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "remote", type: "http", url: "https://mcp.example.com/sse", headers: {} });
    enqueueClientConfig({ connectError: { code: 405, message: "Method Not Allowed" } });
    enqueueClientConfig({ tools: [] });
    const { mgr } = managerOn(reg);

    expect((await mgr.tools())[0]).toMatchObject({ connected: true });
    expect(mockStreamableTransports).toHaveLength(1);
    expect(mockSseTransports).toHaveLength(1);
    expect(mockClients).toHaveLength(2);
  });

  it("does not fall back to SSE after a non-4xx connection error", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: {} });
    enqueueClientConfig({ connectError: new Error("network unavailable") });
    const { mgr } = managerOn(reg);

    expect((await mgr.tools())[0]).toMatchObject({ connected: false, error: expect.stringContaining("network unavailable") });
    expect(mockSseTransports).toHaveLength(0);
    expect(mockClients).toHaveLength(1);
  });

  it("concurrent first-use calls for the same server share one in-flight connect", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ tools: [] });
    const { mgr } = managerOn(reg);

    await Promise.all([mgr.call("s", "x", {}), mgr.call("s", "x", {})]);
    expect(mockClients.length).toBe(1);
  });

  it("a broken server contributes an error row, not a thrown exception", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "broken", type: "stdio", command: "node", args: [], env: {} });
    reg.add({ name: "ok", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ connectError: "spawn ENOENT" });
    enqueueClientConfig({ tools: [{ name: "t", inputSchema: {} }] });

    const { mgr } = managerOn(reg);
    const rows = await mgr.tools();
    expect(rows.find((r) => r.server === "broken")).toMatchObject({ connected: false, error: "spawn ENOENT" });
    expect(rows.find((r) => r.server === "ok")).toMatchObject({ connected: true });
  });

  it("call() to an unregistered server returns isError text instead of throwing", async () => {
    const mgr = new McpStoreConnectionManager(new McpStoreRegistry(makeHome()), new InMemoryKeychain());
    const result = await mgr.call("nope", "x", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unknown mcp store server/);
  });

  it("call() surfaces a tool-level error as isError without throwing", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ tools: [], callError: "boom" });
    const { mgr } = managerOn(reg);
    const result = await mgr.call("s", "x", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/boom/);
  });

  it("query filters tools() by server/tool name and description substring", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "slack", type: "stdio", command: "node", args: [], env: {} });
    reg.add({ name: "github", type: "stdio", command: "node", args: [], env: {} });
    // McpStoreRegistry.list() is name-sorted ("github" before "slack"), and tools()
    // connects in that order — enqueue configs to match, not add() call order.
    enqueueClientConfig({ tools: [{ name: "open_pr", description: "open a pull request", inputSchema: {} }] });
    enqueueClientConfig({ tools: [{ name: "send_message", description: "post to a channel", inputSchema: {} }] });
    const { mgr } = managerOn(reg);

    const filtered = await mgr.tools("pull request");
    expect(filtered.map((r) => r.server)).toEqual(["github"]);
    expect(filtered[0]?.tools.map((t) => t.name)).toEqual(["open_pr"]);
    expect((await mgr.tools("GITHUB"))[0]?.tools.map(t => t.name)).toEqual(["open_pr"]);
  });

  it("evicts a disconnected client so the next request reconnects without replaying a failed action", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ callError: "Connection closed" });
    const { mgr } = managerOn(reg);
    expect((await mgr.call("s", "click", {})).isError).toBe(true);
    expect(mockClients).toHaveLength(1);
    const old = mockClients[0]!;
    old.onclose?.();
    expect((await mgr.call("s", "snapshot", {})).isError).toBeUndefined();
    expect(mockClients).toHaveLength(2);
    old.onclose?.(); // A late close from the old transport must not evict its replacement.
    await mgr.tools();
    expect(mockClients).toHaveLength(2);
    expect(mockClients[1]!.calls).not.toContainEqual({ name: "click", arguments: {} });
    await mgr.closeAll();
  });

  it("keeps a connection alive while approval is pending, then resumes normal idle cleanup", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
    const { mgr, fireLatest } = managerOn(reg);
    let approve!: (value: { allow: boolean }) => void;
    const approval = new Promise<{ allow: boolean }>(resolve => { approve = resolve; });
    const gate = vi.fn(() => approval);
    const pending = mgr.call("s", "click", {}, gate);
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    fireLatest();
    expect(mockClients[0]!.closeCalls).toBe(0);
    approve({ allow: true });
    expect((await pending).isError).toBeUndefined();
    fireLatest();
    expect(mockClients[0]!.closeCalls).toBe(1);
    await mgr.closeAll();
  });

  it("does not execute an approved call after the server was stopped during approval", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
    const { mgr } = managerOn(reg);
    let approve!: (value: { allow: boolean }) => void;
    const gate = vi.fn(() => new Promise<{ allow: boolean }>(resolve => { approve = resolve; }));
    const pending = mgr.call("s", "click", {}, gate);
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    await mgr.closeServer("s");
    approve({ allow: true });
    expect((await pending).isError).toBe(true);
    expect(mockClients[0]!.calls).not.toContainEqual({ name: "click", arguments: {} });
  });

  it("idle-teardown closes the client after the injected timer fires; a later call reconnects", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ tools: [] });
    enqueueClientConfig({ tools: [] });
    const { mgr, fireLatest } = managerOn(reg);

    await mgr.tools();
    expect(mockClients.length).toBe(1);
    expect(mockClients[0]?.closeCalls).toBe(0);

    fireLatest();                                   // simulate the idle window elapsing
    await new Promise((r) => setTimeout(r, 0));      // let the async teardown() settle
    expect(mockClients[0]?.closeCalls).toBe(1);

    await mgr.tools();
    expect(mockClients.length).toBe(2);              // reconnected -- a fresh client, not the closed one
  });

  it("a `servers` filter narrows the scan itself — a non-listed server is never connected (MCP-STORE-DIRECT-TOGGLE)", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {} });
    reg.add({ name: "telegram", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ tools: [{ name: "navigate_page", inputSchema: {} }] });   // only "chrome-devtools" should consume this
    const { mgr } = managerOn(reg);

    const rows = await mgr.tools(undefined, ["chrome-devtools"]);
    expect(rows.map((r) => r.server)).toEqual(["chrome-devtools"]);
    expect(mockClients.length).toBe(1);   // telegram was never even attempted
  });

  // MCPSTORE-LIFECYCLE-UI: a disabled server must be invisible to agent-facing discovery
  // (mcp_store_tools/mcp_store_call) — never connected, never even an error row.
  describe("disabled servers (MCPSTORE-LIFECYCLE-UI)", () => {
    it("tools() omits a disabled server entirely — not even an error row — and never connects it", async () => {
      const reg = new McpStoreRegistry(makeHome());
      reg.add({ name: "chrome-devtools", type: "stdio", command: "node", args: [], env: {} });
      reg.add({ name: "telegram", type: "stdio", command: "node", args: [], env: {} });
      reg.setEnabled("telegram", false);
      enqueueClientConfig({ tools: [{ name: "navigate_page", inputSchema: {} }] });   // only "chrome-devtools" should consume this
      const { mgr } = managerOn(reg);

      const rows = await mgr.tools();
      expect(rows.map((r) => r.server)).toEqual(["chrome-devtools"]);
      expect(mockClients.length).toBe(1);   // telegram (disabled) was never even attempted
    });

    it("call() to a disabled server returns isError text instead of connecting", async () => {
      const reg = new McpStoreRegistry(makeHome());
      reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
      reg.setEnabled("s", false);
      const { mgr } = managerOn(reg);

      const result = await mgr.call("s", "x", {});
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/disabled/);
      expect(mockClients.length).toBe(0);
    });

    it("an explicit `servers` filter naming a disabled server still yields no row and no connect", async () => {
      const reg = new McpStoreRegistry(makeHome());
      reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
      reg.setEnabled("s", false);
      const { mgr } = managerOn(reg);

      const rows = await mgr.tools(undefined, ["s"]);
      expect(rows).toEqual([]);
      expect(mockClients.length).toBe(0);
    });
  });

  it("removing a server via closeServer tears down its live connection", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "s", type: "stdio", command: "node", args: [], env: {} });
    enqueueClientConfig({ tools: [] });
    const { mgr } = managerOn(reg);
    await mgr.tools();
    await mgr.closeServer("s");
    expect(mockClients[0]?.closeCalls).toBe(1);
  });
});

// MCP-REMOTE-IMPORT slice 2 (SECURITY-CRITICAL): a store server's http spec carrying `auth`
// gets its keychain secret injected as an outgoing header at connect -- the secret touches
// memory ONLY inside connectTransport and must never surface in a log line, thrown error
// message/cause, or emitted event.
describe("McpStoreConnectionManager: keychain auth injection at connect", () => {
  function managerOn(reg: McpStoreRegistry, keychain: InMemoryKeychain) {
    const setTimer = () => ({});
    const clearTimer = () => {};
    return new McpStoreConnectionManager(reg, keychain, { idleMs: 5000, setTimer, clearTimer });
  }

  it("injects a Bearer header built from the keychain secret (default header/scheme)", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "remote", type: "http", url: "https://mcp.example.com/mcp", auth: { keychainRef: mcpStoreAuthService("remote") } });
    const keychain = new InMemoryKeychain({ [mcpStoreAuthService("remote")]: "sk-super-secret-token" });
    enqueueClientConfig({ tools: [] });

    const mgr = managerOn(reg, keychain);
    expect((await mgr.tools())[0]).toMatchObject({ server: "remote", connected: true });
    expect(mockStreamableTransports[0]?.options).toEqual({ requestInit: { headers: { Authorization: "Bearer sk-super-secret-token" } } });
  });

  it("honors a custom header/scheme and merges with static headers", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({
      name: "remote", type: "http", url: "https://mcp.example.com/mcp", headers: { "X-App": "chimera" },
      auth: { keychainRef: mcpStoreAuthService("remote"), header: "X-Api-Key", scheme: "Token" },
    });
    const keychain = new InMemoryKeychain({ [mcpStoreAuthService("remote")]: "sk-custom" });
    enqueueClientConfig({ tools: [] });

    const mgr = managerOn(reg, keychain);
    await mgr.tools();
    expect(mockStreamableTransports[0]?.options).toEqual({ requestInit: { headers: { "X-App": "chimera", "X-Api-Key": "Token sk-custom" } } });
  });

  it("a missing keychain secret fails clean, naming the server but not leaking anything (there's nothing to leak)", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "remote", type: "http", url: "https://mcp.example.com/mcp", auth: { keychainRef: mcpStoreAuthService("remote") } });
    const mgr = managerOn(reg, new InMemoryKeychain());

    const rows = await mgr.tools();
    expect(rows[0]).toMatchObject({ connected: false });
    expect(rows[0]?.error).toMatch(/no keychain secret is set/);
    expect(mockStreamableTransports).toHaveLength(0);   // never even attempted a connect without a secret
  });

  it("SECURITY: a planted token never appears in the thrown error, its message, or any console/log output when connect fails", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "remote", type: "http", url: "https://mcp.example.com/mcp", auth: { keychainRef: mcpStoreAuthService("remote") } });
    const secret = "sk-planted-leak-canary-000111";
    const keychain = new InMemoryKeychain({ [mcpStoreAuthService("remote")]: secret });
    // Simulate a worst-case leaky SDK/fetch error that echoes the outgoing request (headers
    // included) back in its message -- sanitizeConnectError must still scrub it.
    enqueueClientConfig({ connectError: new Error(`connect ECONNREFUSED; sent Authorization: Bearer ${secret}`) });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mgr = managerOn(reg, keychain);
      const rows = await mgr.tools();
      expect(rows[0]?.connected).toBe(false);
      expect(rows[0]?.error).toBeDefined();
      expect(rows[0]?.error).not.toContain(secret);
      expect(JSON.stringify(rows[0])).not.toContain(secret);

      for (const spy of [logSpy, errorSpy, warnSpy]) {
        for (const call of spy.mock.calls) {
          expect(call.map(String).join(" ")).not.toContain(secret);
        }
      }
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});


describe("computer-use sessions and screenshots", () => {
  function setup(sessionMode: "agent" | "exclusive" | "shared") {
    const registry = new McpStoreRegistry(makeHome());
    registry.add({ name: "computer", type: "stdio", command: "node", args: [], env: {}, enabled: true, direct: false, trust: "full", sessionMode });
    return new McpStoreConnectionManager(registry, new InMemoryKeychain());
  }

  it("isolates each browser agent and operator from discovery, then closes every child", async () => {
    const mgr = setup("agent");
    await mgr.tools();
    await mgr.call("computer", "snapshot", {}, undefined, "claude");
    await mgr.call("computer", "snapshot", {}, undefined, "codex");
    await mgr.call("computer", "snapshot", {}, undefined, "claude");
    await mgr.call("computer", "snapshot", {});
    expect(mockClients).toHaveLength(4);
    expect(mockClients[1]!.calls.filter((c: any) => c.name === "snapshot")).toHaveLength(2);
    await mgr.closeServer("computer");
    expect(mockClients.every(c => c.closeCalls === 1)).toBe(true);
  });

  it("does not resurrect agent sessions closed while connecting", async () => {
    let release!: () => void;
    enqueueClientConfig({ connectWait: new Promise<void>(r => { release = r; }) });
    const mgr = setup("agent");
    const pending = mgr.call("computer", "snapshot", {}, undefined, "a");
    const closing = mgr.closeServer("computer");
    release(); await closing;
    expect((await pending).isError).toBe(true);
    expect(mockClients[0]!.closeCalls).toBeGreaterThan(0);
  });

  it("holds the desktop across calls and only its owner can release it", async () => {
    const mgr = setup("exclusive");
    expect((await mgr.call("computer", "snapshot", {}, undefined, "claude")).isError).toBeUndefined();
    expect((await mgr.call("computer", "click", {}, undefined, "codex")).isError).toBe(true);
    expect(() => mgr.session("computer", "release", "codex")).toThrow(/busy/);
    expect(mgr.session("computer", "status")).toMatchObject({ owner: "claude", held: true });
    mgr.session("computer", "release", "claude");
    expect((await mgr.call("computer", "snapshot", {}, undefined, "codex")).isError).toBeUndefined();
    await mgr.closeAll();
  });

  it("expires idle ownership, but never steals or releases an in-flight action", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    let release!: () => void;
    enqueueClientConfig({ callWait: new Promise<void>(r => { release = r; }) });
    const mgr = setup("exclusive");
    const pending = mgr.call("computer", "click", {}, undefined, "claude");
    await vi.waitFor(() => expect(mgr.session("computer", "status").busy).toBe(true));
    now.mockReturnValue(1_000_000);
    expect(() => mgr.session("computer", "acquire", "codex")).toThrow(/busy/);
    expect(() => mgr.session("computer", "release", "claude")).toThrow(/busy/);
    release(); await pending;
    now.mockReturnValue(2_000_000);
    expect(mgr.session("computer", "acquire", "codex").owner).toBe("codex");
    now.mockRestore(); await mgr.closeAll();
  });

  it("a denied call does not acquire the desktop or execute a tool", async () => {
    const mgr = setup("exclusive");
    const result = await mgr.call("computer", "click", {}, async () => ({ allow: false }), "claude");
    expect(result.isError).toBe(true);
    expect(mgr.session("computer", "status").held).toBe(false);
    expect(mockClients[0]!.calls.filter((c: any) => c.name === "click")).toHaveLength(0);
    await mgr.closeAll();
  });

  it("preserves screenshot blocks and upstream errors without exposing extraneous image fields", async () => {
    const img = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
    enqueueClientConfig({ callToolResult: { content: [{ type: "text", text: "snapshot" }, { ...img, arbitrary: "untrusted metadata" }], isError: true } });
    const mgr = setup("shared");
    expect(await mgr.call("computer", "screenshot", {})).toEqual({ text: "snapshot\n[image]", images: [img], isError: true });
    await mgr.closeAll();
  });

  it("preserves capture IDs from structured output for text-only SDK consumers too", async () => {
    const structuredContent = { capture_id: "capture-123", window_id: 42 };
    enqueueClientConfig({ callToolResult: { content: [{ type: "text", text: "Window captured" }], structuredContent } });
    const mgr = setup("shared");
    const result = await mgr.call("computer", "screenshot", {});
    expect(result.structuredContent).toEqual(structuredContent);
    expect(result.text).toContain('"capture_id":"capture-123"');
    expect(result.text).toContain("<untrusted_tool_result>");
    await mgr.closeAll();
  });

  it("reports oversized screenshots instead of truncating base64 or pretending success", async () => {
    enqueueClientConfig({ callToolResult: { content: [{ type: "image", mimeType: "image/png", data: "a".repeat(8 * 1024 * 1024 + 1) }] } });
    const mgr = setup("shared");
    const result = await mgr.call("computer", "screenshot", {});
    expect(result.isError).toBe(true); expect(result.images).toBeUndefined();
    expect(result.text).toContain("request a smaller screenshot");
    await mgr.closeAll();
  });
});


describe("desktop activity monitor", () => {
  it("reports live actions and their target without exposing arguments or consuming snapshots", async () => {
    let finish!: () => void;
    enqueueClientConfig({ callWait: new Promise<void>(r => { finish = r; }), callToolResult: {
      content: [{ type: "text", text: "private output" }], structuredContent: { window_id: 42 },
    } });
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "chimera-desktop", type: "stdio", command: "node", args: [], env: {}, sessionMode: "exclusive" });
    const mgr = new McpStoreConnectionManager(reg, new InMemoryKeychain());
    const pending = mgr.call("chimera-desktop", "type_text", { text: "private input", window_id: 42 }, undefined, "agent-a");
    await vi.waitFor(() => expect(mgr.monitor().busy).toBe(true));
    expect(mgr.monitor().activities[0]).toMatchObject({ tool: "type_text", agentId: "agent-a", state: "running" });
    finish(); await pending;
    expect(mgr.monitor()).toMatchObject({ held: true, owner: "agent-a", busy: false, windowId: 42 });
    expect(mgr.monitor().activities[0]?.state).toBe("succeeded");
    expect(JSON.stringify(mgr.monitor())).not.toContain("private");
    const calls = mockClients[0]!.calls.length;
    mgr.monitor(); mgr.monitor();
    expect(mockClients[0]!.calls).toHaveLength(calls);
    await mgr.call("chimera-desktop", "get_desktop_state", {}, undefined, "agent-a");
    expect(mgr.monitor()).toMatchObject({ held: true, desktop: true, windowId: null });
    mgr.session("chimera-desktop", "release", "agent-a");
    expect(mgr.monitor()).toMatchObject({ held: false, desktop: false, windowId: null });
    await mgr.closeAll();
  });

  it("bounds the activity history and records denied actions without acquiring control", async () => {
    const reg = new McpStoreRegistry(makeHome());
    reg.add({ name: "chimera-desktop", type: "stdio", command: "node", args: [], env: {}, sessionMode: "exclusive" });
    const mgr = new McpStoreConnectionManager(reg, new InMemoryKeychain());
    for (let i = 0; i < 45; i++) await mgr.call("chimera-desktop", "click", { window_id: 42 }, async () => ({ allow: false }), "agent-a");
    expect(mgr.monitor()).toMatchObject({ held: false, windowId: null });
    expect(mgr.monitor().activities).toHaveLength(40);
    expect(mgr.monitor().activities.every(a => a.state === "failed")).toBe(true);
    await mgr.closeAll();
  });
});

// The built-in chimera-desktop entry is only a stdio proxy to a service the Chimera app owns.
// When the app stopped it, the proxy exits during initialize and the SDK says nothing but
// "Connection closed" -- these pin the file-evidenced guidance AND everything that must not change.
describe("chimera-desktop host diagnostics", () => {
  const CLOSED = "MCP error -32000: Connection closed";
  const closedError = (message = CLOSED, code = -32000) => Object.assign(new Error(message), { code });
  type HostOpts = { setup?: "ok" | "absent" | "malformed"; driver?: "present" | "missing"; prefs?: "absent" | "on" | "off" | "corrupt" | "wrong-shape"; socket?: boolean };

  // Lays down exactly what the Tauri app owns under <home>/computer-use/ (desktop.json,
  // preferences.json, desktop.sock) and registers the entry the installer would have created.
  function desktopHost(o: HostOpts = {}) {
    const home = makeHome();
    const dir = join(home, "computer-use");
    mkdirSync(dir, { recursive: true });
    const driver = join(home, "cua-driver");
    if ((o.driver ?? "present") === "present") { writeFileSync(driver, "#!/bin/sh\n"); chmodSync(driver, 0o755); }
    const setup = o.setup ?? "ok";
    if (setup === "ok") writeFileSync(join(dir, "desktop.json"), JSON.stringify({ driverPath: driver, socketPath: desktopSocket(home) }));
    if (setup === "malformed") writeFileSync(join(dir, "desktop.json"), "{not json");
    const prefs = o.prefs ?? "absent";
    if (prefs === "on" || prefs === "off") writeFileSync(join(dir, "preferences.json"), JSON.stringify({ enabled: prefs === "on" }));
    if (prefs === "corrupt") writeFileSync(join(dir, "preferences.json"), "{nope");
    if (prefs === "wrong-shape") writeFileSync(join(dir, "preferences.json"), JSON.stringify({ enabled: "yes" }));
    if (o.socket) writeFileSync(desktopSocket(home), "");
    const reg = new McpStoreRegistry(home);
    const desktop = computerUseEntries({ home, node: process.execPath, layaPython: "/usr/bin/python3", playwrightCli: "/tmp/playwright-cli.js", desktopDriver: driver })
      .find(e => e.name === "chimera-desktop")!;
    reg.add(desktop);
    const mgr = new McpStoreConnectionManager(reg, new InMemoryKeychain());
    // Everything in computer-use/ with content+mode, so "read-only" is asserted on the real files.
    const snapshot = () => readdirSync(dir).sort().map(f => `${f}:${statSync(join(dir, f)).mtimeMs}:${statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f), "utf8") : ""}`);
    return { home, dir, reg, mgr, snapshot };
  }
  const desktopRow = async (mgr: McpStoreConnectionManager) => (await mgr.tools()).find(r => r.server === "chimera-desktop")!;

  it("explains an operator-disabled service instead of a bare Connection closed, and keeps the SDK text", async () => {
    const { mgr } = desktopHost({ prefs: "off" });
    enqueueClientConfig({ connectError: closedError() });
    const row = await desktopRow(mgr);
    expect(row.connected).toBe(false);
    expect(row.error).not.toBe(CLOSED);
    expect(row.error).toContain('"Start desktop control"');
    expect(row.error).toContain("Chimera Settings > MCP > Chimera Computer Use");
    expect(row.error).toContain("enabled:false");
    expect(row.error).toContain(`(underlying: ${CLOSED})`);
    expect(row.error).not.toMatch(/not running/);
    // call() goes through the same ensure(), so an agent invoking a tool sees the same guidance.
    enqueueClientConfig({ connectError: closedError() });
    const called = await mgr.call("chimera-desktop", "get_desktop_state", {});
    expect(called.isError).toBe(true);
    expect(called.text).toContain('"Start desktop control"');
    expect(called.text).toContain(`(underlying: ${CLOSED})`);
  });

  it.each(["on", "absent"] as const)("reports a not-running host (preference %s, no socket) as temporary, never as disabled", async (prefs) => {
    const { mgr } = desktopHost({ prefs });
    enqueueClientConfig({ connectError: closedError() });
    const row = await desktopRow(mgr);
    expect(row.error).toContain("not running right now");
    expect(row.error).toContain("may be closed or still starting");
    expect(row.error).toContain('"Start desktop control"');
    expect(row.error).toContain(`(underlying: ${CLOSED})`);
    expect(row.error).not.toMatch(/turned off|enabled:false/);
  });

  it("does not claim a cause when the socket exists and the preference is on", async () => {
    const { mgr } = desktopHost({ prefs: "on", socket: true });
    enqueueClientConfig({ connectError: closedError() });
    expect((await desktopRow(mgr)).error).toBe(CLOSED);
  });

  it("an operator-disabled preference wins over a stale socket file", async () => {
    const { mgr } = desktopHost({ prefs: "off", socket: true });
    enqueueClientConfig({ connectError: closedError() });
    expect((await desktopRow(mgr)).error).toContain("enabled:false");
  });

  it.each([
    ["desktop.json was removed (stale registry entry)", { setup: "absent", prefs: "off" }, "not set up on this machine"],
    ["desktop.json is malformed", { setup: "malformed", prefs: "off" }, "setup is invalid"],
    ["the driver runtime is gone", { driver: "missing", prefs: "off" }, "runtime is missing"],
  ] as const)("distinguishes missing setup from a stopped service: %s", async (_label, host, expected) => {
    const { mgr } = desktopHost(host);
    enqueueClientConfig({ connectError: closedError() });
    const err = (await desktopRow(mgr)).error;
    expect(err).toContain(expected);
    expect(err).toContain("Chimera Settings > MCP > Chimera Computer Use");
    // Enabling the preference cannot fix a missing install, so it must not be the advice.
    expect(err).not.toMatch(/turned off|not running right now/);
  });

  it.each(["corrupt", "wrong-shape"] as const)("gives neutral guidance for a %s preference file", async (prefs) => {
    const { mgr } = desktopHost({ prefs });
    enqueueClientConfig({ connectError: closedError() });
    const err = (await desktopRow(mgr)).error;
    expect(err).toContain("unreadable, so its state is unknown");
    expect(err).not.toMatch(/turned off|enabled:false|not running right now/);
  });

  it("annotates a spawn failure of the built-in proxy the same way", async () => {
    const { mgr } = desktopHost({ prefs: "off" });
    enqueueClientConfig({ connectError: "spawn ENOENT" });
    const err = (await desktopRow(mgr)).error;
    expect(err).toContain("enabled:false");
    expect(err).toContain("(underlying: spawn ENOENT)");
  });

  it("is read-only: never writes the preference or creates the socket, even when disabled", async () => {
    const { mgr, dir, snapshot } = desktopHost({ prefs: "off" });
    const before = snapshot();
    enqueueClientConfig({ connectError: closedError() });
    await desktopRow(mgr);
    enqueueClientConfig({ connectError: closedError() });
    await mgr.call("chimera-desktop", "click", {});
    expect(snapshot()).toEqual(before);
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toEqual({ enabled: false });
    expect(mockClients).toHaveLength(2);   // two connect attempts, no extra "start the host" process/client
  });

  it("leaves a generic server's identical failure unchanged", async () => {
    const { reg, mgr } = desktopHost({ prefs: "off" });
    reg.add({ name: "telegram", type: "stdio", command: "node", args: [], env: {}, enabled: true, direct: false, trust: "full" });
    // Identical failure for both servers, so which one connects first is irrelevant.
    enqueueClientConfig({ connectError: closedError() });
    enqueueClientConfig({ connectError: closedError() });
    const rows = await mgr.tools();
    expect(rows.find(r => r.server === "telegram")!.error).toBe(CLOSED);
    expect(rows.find(r => r.server === "chimera-desktop")!.error).toContain("enabled:false");
  });

  it("leaves a custom chimera-desktop entry that points at a different socket unchanged", async () => {
    const home = makeHome();
    mkdirSync(join(home, "computer-use"), { recursive: true });
    writeFileSync(join(home, "computer-use", "preferences.json"), JSON.stringify({ enabled: false }));
    const reg = new McpStoreRegistry(home);
    reg.add({ name: "chimera-desktop", type: "stdio", command: "node", args: ["mcp", "--embedded", "--socket", join(tmpdir(), "elsewhere.sock")], env: {}, sessionMode: "exclusive" });
    const mgr = new McpStoreConnectionManager(reg, new InMemoryKeychain());
    enqueueClientConfig({ connectError: closedError() });
    expect((await desktopRow(mgr)).error).toBe(CLOSED);
  });

  it("leaves a healthy host untouched: tools and calls pass through even with a stale disabled preference file", async () => {
    const { mgr, snapshot } = desktopHost({ prefs: "off" });
    const before = snapshot();
    enqueueClientConfig({ tools: [{ name: "get_desktop_state", description: "d", inputSchema: { type: "object" } }] });
    const row = await desktopRow(mgr);
    expect(row).toMatchObject({ server: "chimera-desktop", connected: true });
    expect(row.error).toBeUndefined();
    expect(row.tools.map(t => t.name)).toEqual(["get_desktop_state"]);
    const called = await mgr.call("chimera-desktop", "get_desktop_state", {});
    expect(called.isError).toBeUndefined();
    expect(called.text).toContain("ok");
    expect(snapshot()).toEqual(before);
    await mgr.closeAll();
  });

  it("explains a connection that closes mid-call after the operator stopped the service, but not other call failures", async () => {
    const { mgr, dir } = desktopHost({ prefs: "on", socket: true });
    enqueueClientConfig({ tools: [{ name: "click", inputSchema: { type: "object" } }], callError: closedError() });
    // The app's Stop removed the socket and wrote enabled:false while the proxy was connected.
    await mgr.tools();
    rmSync(join(dir, "desktop.sock"));
    writeFileSync(join(dir, "preferences.json"), JSON.stringify({ enabled: false }));
    const closed = await mgr.call("chimera-desktop", "click", {});
    expect(closed.isError).toBe(true);
    expect(closed.text).toContain('mcp store tool "chimera-desktop__click" failed:');
    expect(closed.text).toContain('"Start desktop control"');
    expect(closed.text).toContain(`(underlying: ${CLOSED})`);

    const timeout = desktopHost({ prefs: "off" });
    enqueueClientConfig({ tools: [{ name: "click", inputSchema: { type: "object" } }], callError: closedError("MCP error -32001: Request timed out", -32001) });
    await timeout.mgr.tools();
    const timed = await timeout.mgr.call("chimera-desktop", "click", {});
    expect(timed.text).toBe('mcp store tool "chimera-desktop__click" failed: MCP error -32001: Request timed out');
    await mgr.closeAll(); await timeout.mgr.closeAll();
  });

  it("keeps the unknown-server error when the entry was removed from the registry", async () => {
    const { reg, mgr } = desktopHost({ prefs: "off" });
    reg.remove("chimera-desktop");
    const called = await mgr.call("chimera-desktop", "click", {});
    expect(called).toEqual({ text: 'unknown mcp store server "chimera-desktop"', isError: true });
  });
});
