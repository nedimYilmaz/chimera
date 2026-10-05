import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import { AgentSpecSchema, type AgentGroup } from "@chimera/protocol";
import { initialState, reduce } from "../../ui-state/src/index.js";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import type { AgentRecord } from "../src/supervisor.js";
import { makeEngineHome } from "./helpers.js";

const NAMES = ["group_list", "group_create", "group_update", "group_delete", "agent_set_groups", "agent_add_groups", "agent_remove_groups"];
const value = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

async function fixture(conductor = false) {
  const home = makeEngineHome();
  const backend = new FakeAgentBackend([]);
  const spawn = vi.spyOn(backend, "spawn");
  const engine = new Engine({ home, backends: new Map([["claude", backend]]) });
  engine.supervisor.reattachTerminal({
    agentId: "fixture-agent", spec: AgentSpecSchema.parse({ prompt: "fixture", cwd: home }),
    state: "done", accountName: "main", provider: "claude", depth: 0, treeId: "fixture-agent",
    createdAt: 1, principal: "local", parentId: null, projectId: null, attempts: [], costUsd: 0,
    groups: ["existing"], resultText: "fixture",
  } satisfies AgentRecord);
  const server = await createChimeraMcpServer((method, params) => engine.handle(method, params), { agentId: "fixture-agent", depth: 0, conductor });
  const client = new Client({ name: "groups-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = (tool: string, args: Record<string, unknown> = {}) => client.callTool({ name: "chimera_call", arguments: { tool, args } });
  return { engine, home, backend, spawn, client, call, close: async () => { await client.close(); await server.close(); rmSync(home, { recursive: true, force: true }); } };
}

describe("Inspector groups through MCP and isolated Engine", () => {
  it("discovers CRUD/membership schemas, dispatches and persists registry changes without spawning", async () => {
    const f = await fixture(true);
    try {
      expect((await f.client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(NAMES));
      const discovery = value(await f.client.callTool({ name: "chimera_tools", arguments: { tag: "group", detail: true } }));
      expect(discovery.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(NAMES.slice(0, 4)));
      const memberships = value(await f.client.callTool({ name: "chimera_tools", arguments: { query: "agent groups" } }));
      expect(memberships.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(NAMES.slice(4)));
      const group = value(await f.call("group_create", { name: "Sprint", color: "blue" })) as AgentGroup;
      expect(group.id).toBe("sprint");
      expect(value(await f.call("group_update", { id: group.id, name: "Daily", color: "teal" }))).toMatchObject({ id: "sprint", name: "Daily", color: "teal" });
      const restarted = new Engine({ home: f.home, backends: new Map([["claude", f.backend]]) });
      expect(await restarted.handle("group.list", {})).toMatchObject({ groups: [{ id: "sprint", name: "Daily", color: "teal" }] });
      expect(value(await f.call("agent_set_groups", { agentId: "fixture-agent", groups: [group.id] }))).toEqual({ ok: true });
      expect(value(await f.call("group_delete", { id: group.id }))).toEqual({ ok: true });
      expect(value(await f.call("group_delete", { id: group.id }))).toEqual({ ok: true });
      expect(value(await f.call("group_list"))).toEqual({ groups: [] });
      expect(new Engine({ home: f.home, backends: new Map([["claude", f.backend]]) }).groupStore.list()).toEqual([]);
      expect(f.engine.supervisor.status("fixture-agent")).toMatchObject({ state: "done", groups: [group.id], resultText: "fixture" });
      expect(f.spawn).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("preserves other memberships atomically, updates the existing reducer, and retains snapshots", async () => {
    const f = await fixture();
    try {
      expect((await f.client.listTools()).tools.map(t => t.name)).not.toContain("group_create");
      const args = (groups: string[]) => ({ agentId: "fixture-agent", groups });
      expect((await f.call("agent_add_groups", args(["sprint", "sprint"]))).isError).not.toBe(true);
      await Promise.all([
        f.engine.handle("agent.addGroups", args(["daily"])),
        f.engine.handle("agent.addGroups", args(["other"])),
        f.engine.handle("agent.removeGroups", args(["sprint", "absent"])),
      ]);
      expect(f.engine.supervisor.status("fixture-agent").groups).toEqual(["existing", "daily", "other"]);
      const events = f.engine.events.tail("fixture-agent", 100);
      let state = initialState;
      for (const event of events) state = reduce(state, { type: "event", event });
      expect(state.agents["fixture-agent"]?.groups).toEqual(["existing", "daily", "other"]);
      const snapshot = JSON.parse(JSON.stringify(f.engine.supervisor.snapshotAgents())) as AgentRecord[];
      const restarted = new Engine({ home: f.home, backends: new Map([["claude", f.backend]]) });
      restarted.supervisor.reattachTerminal(snapshot.find(r => r.agentId === "fixture-agent")!);
      expect(restarted.supervisor.status("fixture-agent").groups).toEqual(["existing", "daily", "other"]);
      await f.call("agent_remove_groups", args(["daily"]));
      expect(f.engine.supervisor.status("fixture-agent").groups).toEqual(["existing", "other"]);
      await f.call("agent_set_groups", args([]));
      expect(f.engine.supervisor.status("fixture-agent").groups).toEqual([]);
      expect(f.spawn).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("preserves existing project MCP create/delete semantics beside Inspector groups", async () => {
    const f = await fixture(true);
    try {
      const path = join(f.home, "registered-project");
      mkdirSync(path); writeFileSync(join(path, "keep.txt"), "operator data");
      const created = await f.call("project_create", { name: "qa-project", path });
      expect(created.isError).not.toBe(true);
      expect(value(created)).toMatchObject({ name: "qa-project", path });
      // Creation retains its existing eager conductor behavior; stop only the fake
      // fixture conductor before testing registration-only deletion.
      await f.engine.handle("project.conductor.stop", { name: "qa-project" });
      expect(value(await f.call("project_delete", { name: "qa-project" }))).toMatchObject({ deleted: true });
      expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("operator data");
      expect(f.engine.supervisor.status("fixture-agent")).toMatchObject({ groups: ["existing"], state: "done" });
    } finally { await f.close(); }
  });

  it("rejects malformed IDs, unknown agents and total overflow before mutation/event emission", async () => {
    const f = await fixture();
    try {
      for (const [tool, args] of [
        ["group_create", { name: " " }], ["group_update", { id: "ghost", name: "x" }],
        ["group_delete", { id: "../bad" }], ["agent_set_groups", { agentId: "fixture-agent", groups: ["Bad Id"] }],
        ["agent_add_groups", { agentId: "missing", groups: ["valid"] }],
        ["agent_remove_groups", { agentId: "fixture-agent", groups: ["../bad"] }],
      ] as const) expect((await f.call(tool, args)).isError).toBe(true);
      const before = f.engine.events.tail("fixture-agent", 100).length;
      expect((await f.call("agent_add_groups", { agentId: "fixture-agent", groups: Array.from({ length: 8 }, (_, i) => `g${i}`) })).isError).toBe(true);
      expect(f.engine.supervisor.status("fixture-agent").groups).toEqual(["existing"]);
      expect(f.engine.events.tail("fixture-agent", 100)).toHaveLength(before);
      expect(() => RPC_CONTRACT["agent.addGroups"].request.parse({ agentId: "fixture-agent", groups: ["Bad Id"] })).toThrow();
    } finally { await f.close(); }
  });
});
