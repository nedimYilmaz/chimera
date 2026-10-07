import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import { MCP_TOOL_TABLE } from "@chimera/protocol/mcp-tools";
import { chimeraAccess } from "@chimera/protocol/chimera-capabilities";
import { resolveAgentSpec } from "../src/supervisor.js";
import { buildCodexOptions, buildThreadOptions } from "../src/backends/codex.js";
import { buildMcpServerSpecs } from "../src/backends/generic-mcp.js";
import { ClaudeAgentBackend } from "../src/backends/claude.js";
import { cxSpec } from "./codex-backend-helpers.js";
import { makeSupervisor } from "./helpers.js";

describe("default parent tool → child spec → MCP permission path", () => {
  it("does not inherit full host permissions or delegation from its parent", () => {
    const spawn = MCP_TOOL_TABLE.find(t => t.name === "agent_spawn")!.resolve({ prompt: "reply to parent", cwd: "/tmp", provider: "codex" }, { depth: 1, agentId: "parent", treeId: "parent", maxDepthCap: 2 });
    expect(spawn.kind).toBe("rpc"); if (spawn.kind !== "rpc") throw new Error("spawn did not resolve");
    const p = spawn.params as { spec: unknown; depth: number; parentId: string; treeId: string };
    const child = resolveAgentSpec(p.spec);
    expect(child).toMatchObject({ permissionProfile: "acceptEdits", autonomy: "ask", orchestration: { allow: false } });
    expect(p).toMatchObject({ parentId: "parent", treeId: "parent", depth: 1 });
    const base = cxSpec(child);
    const spec = { ...base, providerOptions: child.providerOptions, depth: p.depth, env: { ...base.env, CHIMERA_TREE_ID: p.treeId } };
    expect(chimeraAccess(spec)).toBe("coordination");
    const options = buildCodexOptions(spec);
    const server = (options.config!.mcp_servers as any).chimera;
    expect(server.env).toMatchObject({ CHIMERA_AGENT_ID: "cx-1", CHIMERA_TREE_ID: "parent", CHIMERA_MCP_ACCESS: "coordination", CHIMERA_MAX_DEPTH: "2" });
    expect(server.tools.chimera_tools).toEqual({ approval_mode: "approve" });
    expect(server.tools.agent_send).toEqual({ approval_mode: "approve" });
    expect(server.tools.chimera_call).toEqual({ approval_mode: "approve" });
    for (const name of ["agent_spawn", "agent_kill", "secret_get", "mcp_store_call"]) expect(server.tools[name]).toBeUndefined();
    expect(buildThreadOptions(spec, spec.cwd)).toMatchObject({ sandboxMode: "workspace-write", approvalPolicy: "on-request" });
    const generic = buildMcpServerSpecs(spec, { get: () => { throw new Error("offline"); } });
    expect(generic.chimera).toMatchObject({ inProcess: true, ctx: { access: "coordination", agentId: "cx-1", treeId: "parent", depth: 2 } });
  });

  it("keeps top-level opt-in and the full orchestration wrapper's approval unchanged", () => {
    expect(chimeraAccess(cxSpec())).toBe("none");
    const full = cxSpec({ orchestration: { allow: true } });
    const tools = (buildCodexOptions(full).config!.mcp_servers as any).chimera.tools;
    expect(tools.chimera_tools).toEqual({ approval_mode: "approve" });
    expect(tools.chimera_call).toBeUndefined();
    expect(tools.agent_send).toBeUndefined();
  });

  it("does not override an explicit closed-world server/tool allowlist", () => {
    for (const grant of [{}, { chimera: [] }, { chimera: ["chimera_tools"] }]) {
      const server = (buildCodexOptions({ ...cxSpec({ mcpToolAllowlist: grant }), depth: 1 }).config!.mcp_servers as any).chimera;
      expect(server.enabled_tools).toEqual((grant as { chimera?: string[] }).chimera ?? []);
      expect(server.env.CHIMERA_MCP_TOOL_ALLOWLIST).toBe(JSON.stringify(server.enabled_tools));
    }
  });

  it("baseline permission requests skip UI, out-of-grant Chimera denies and host/foreign requests still ask", async () => {
    const { sup, events } = makeSupervisor([[{ awaitSend: true }], [{ awaitSend: true }]]);
    const parent = await sup.spawn({ prompt: "parent", cwd: "/tmp", isolation: "none", account: "main" });
    const child = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "second", permissionProfile: "readOnly", on: { permissionRequest: "tui" } }, { depth: 1, parentId: parent.agentId, treeId: parent.treeId });
    const internal = sup as unknown as { decidePermission(record: unknown, req: { requestId: string; toolName: string; input: unknown }): Promise<boolean | string> };
    try {
      for (const [toolName, input] of [["mcp__chimera__chimera_tools", {}], ["mcp__chimera__agent_send", { agentId: "parent", text: "hi" }], ["mcp__chimera__chimera_call", { tool: "agent_send_many", args: { agentIds: ["parent"], text: "hi" } }]] as const) {
        expect(await internal.decidePermission(child, { requestId: toolName, toolName, input })).toBe(true);
      }
      expect(events.tail(child.agentId, 100).filter(e => e.kind === "permission_request")).toHaveLength(0);
      for (const grant of [{}, { chimera: [] }, { chimera: ["chimera_tools"] }]) {
        child.spec.mcpToolAllowlist = grant;
        expect(await internal.decidePermission(child, { requestId: "restricted", toolName: "mcp__chimera__agent_send", input: {} })).toBe(false);
      }
      delete child.spec.mcpToolAllowlist;
      child.spec.mcpServers = { chimera: { disabled_tools: ["agent_send"] } };
      expect(await internal.decidePermission(child, { requestId: "denied", toolName: "mcp__chimera__agent_send", input: {} })).toBe(false);
      child.spec.mcpServers = {};
      child.spec.on.permissionRequest = "auto";
      for (const [toolName, input] of [["mcp__chimera__secret_get", {}], ["mcp__chimera__chimera_call", { tool: "agent_kill" }], ["mcp__chimera__agent_send", { force: true }]] as const) expect(await internal.decidePermission(child, { requestId: toolName, toolName, input })).toBe(false);
      child.spec.on.permissionRequest = "tui";
      events.subscribe(e => { if (e.kind === "permission_request") sup.respondPermission(String(e.data.requestId), false); });
      for (const [toolName, input] of [["Edit", { file_path: "/tmp/file" }], ["mcp__chimera__chimera_call", { tool: "agent_kill" }], ["mcp__foreign__read", {}]] as const) {
        expect(await internal.decidePermission(child, { requestId: toolName, toolName, input })).toBe(false);
      }
      expect(events.tail(child.agentId, 100).filter(e => e.kind === "permission_request")).toHaveLength(2);
    } finally { await sup.kill(child.agentId); await sup.kill(parent.agentId); }
  });
});

it("Claude child mounts the same bounded grant and restrictions without bypass mode", async () => {
  const calls: { options: Record<string, any> }[] = [];
  const queryFn = ((args: { options: Record<string, any> }) => {
    calls.push(args);
    return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {} };
  }) as never;
  const spec = { ...cxSpec({ permissionProfile: "readOnly", mcpToolAllowlist: { chimera: ["chimera_tools", "agent_send"] }, mcpServers: { chimera: { disabled_tools: ["agent_send"] } } }), resolvedProvider: "claude", depth: 1 };
  const handle = new ClaudeAgentBackend({ queryFn }).spawn(spec, () => {}, async () => true);
  try {
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.options.permissionMode).toBe("default");
    expect(calls[0]!.options.mcpServers.chimera.env).toMatchObject({ CHIMERA_MCP_ACCESS: "coordination", CHIMERA_AGENT_ID: "cx-1", CHIMERA_MCP_TOOL_ALLOWLIST: '["chimera_tools","agent_send"]', CHIMERA_MCP_TOOL_DENYLIST: '["agent_send"]' });
    expect(calls[0]!.options.canUseTool).toBeTypeOf("function");
  } finally { await handle.kill(); }
});

it("configured deny wins over requested allowlist and native approval mapping", () => {
  const spec = { ...cxSpec({ mcpToolAllowlist: { chimera: ["chimera_tools", "agent_send"] }, mcpServers: { chimera: { enabled_tools: ["chimera_tools", "agent_send"], disabled_tools: ["agent_send"] } } }), depth: 1 };
  const server = (buildCodexOptions(spec).config!.mcp_servers as any).chimera;
  expect(server.enabled_tools).toEqual(["chimera_tools", "agent_send"]);
  expect(server.disabled_tools).toEqual(["agent_send"]);
  expect(server.tools).toEqual({ chimera_tools: { approval_mode: "approve" } });
  expect(server.env.CHIMERA_MCP_TOOL_DENYLIST).toBe('["agent_send"]');
  expect(buildMcpServerSpecs(spec, { get: () => { throw new Error("offline"); } }).chimera).toMatchObject({ ctx: { toolAllowlist: ["chimera_tools", "agent_send"], toolDenylist: ["agent_send"] } });
});

it("the actual SDK exec serializer carries exact bounded per-tool approvals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chimera-child-sdk-wire-"));
  const capture = join(dir, "argv.json");
  const binary = join(dir, "offline-codex.mjs");
  writeFileSync(binary, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nprocess.stdin.resume();\nprocess.stdin.on('end',()=>{writeFileSync(process.env.CAPTURE_FILE,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({type:'thread.started',thread_id:'offline-thread'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0}}));});\n`, { mode: 0o700 });
  try {
    const config = buildCodexOptions({ ...cxSpec(), depth: 1 }).config;
    const sdk = new Codex({ codexPathOverride: binary, config: config as never, env: { PATH: process.env.PATH ?? "", HOME: dir, CODEX_HOME: dir, CAPTURE_FILE: capture } });
    const { events } = await sdk.startThread({ workingDirectory: dir, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "on-request" }).runStreamed("offline");
    for await (const _event of events) { /* Drain the actual serializer/subprocess seam. */ }
    const args = JSON.parse(readFileSync(capture, "utf8")) as string[];
    for (const tool of ["chimera_tools", "agent_send", "chimera_call"]) expect(args).toContain(`mcp_servers.chimera.tools.${tool}.approval_mode="approve"`);
    expect(args.some(a => a.includes("agent_kill.approval_mode"))).toBe(false);
    expect(args).toContain("read-only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
