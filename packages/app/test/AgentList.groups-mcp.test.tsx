import "./agents-window-harness";
import { expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { createRequire } from "node:module";
const sdk = createRequire(new URL("../../protocol/package.json", import.meta.url));
const { Client } = await import(sdk.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { InMemoryTransport } = await import(sdk.resolve("@modelcontextprotocol/sdk/inMemory.js"));
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import { AgentSpecSchema, type AgentGroup } from "@chimera/protocol";
import { Engine } from "../../core/src/engine.js";
import { FakeAgentBackend } from "../../core/src/backends/fake.js";
import { makeEngineHome } from "../../core/test/helpers.js";
import { rmSync } from "node:fs";

const bridge = vi.hoisted(() => ({ request: async (_method: string, _params?: unknown): Promise<unknown> => ({}) }));
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => bridge.request(method, params),
  subscribeEvents: async () => {}, onDaemonEvent: () => () => {}, onDaemonState: () => () => {},
  daemonStatus: async () => "connected", setDockBadge: async () => {},
}));
import { AgentList } from "../src/components/AgentList";
import { AgentDetailPanel } from "../src/components/AgentDetailPanel";
import { appStore } from "../src/state/store";
import { useStore } from "../src/state/useStore";
import { applyFleetFilter } from "../src/state/workspaceTools";
import { composerLocal } from "../src/state/commands.agents";

function MountedInspector() {
  const groups = useStore(s => s.groups.items);
  const agent = useStore(s => s.agents["fixture"]!);
  return <><AgentList /><AgentDetailPanel agent={agent} groups={groups} onSetGroup={() => {}} status={null} loading={false} onClose={() => {}} /></>;
}
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 150)); }); };

it("mounted list and Inspector refresh external MCP create/rename/delete through real Engine events", async () => {
  const home = makeEngineHome(), backend = new FakeAgentBackend([]);
  const spawn = vi.spyOn(backend, "spawn");
  const engine = new Engine({ home, backends: new Map([["claude", backend]]) });
  engine.supervisor.reattachTerminal({ agentId: "fixture", spec: AgentSpecSchema.parse({ prompt: "fixture", cwd: home }), accountName: "main", provider: "claude", state: "done", depth: 0, treeId: "fixture", createdAt: 1, principal: "local", attempts: [], costUsd: 0, parentId: null, projectId: null, groups: ["external"] });
  bridge.request = async (method, params) => method === "group.list" ? engine.handle(method, params) : {};
  const server = await createChimeraMcpServer((method, params) => engine.handle(method, params), { agentId: "fixture", conductor: true, depth: 0 });
  const client = new Client({ name: "mounted-groups", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const off = engine.events.subscribe(event => appStore.dispatch({ type: "event", event }));
  let mounted: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      appStore.dispatch({ type: "connected", connected: true });
      appStore.dispatch({ type: "agentRecords", records: [engine.supervisor.status("fixture")] });
      appStore.dispatch({ type: "selectAgent", agentId: "fixture" });
      composerLocal.set({ composeText: "Keep my draft" });
      applyFleetFilter({ query: "", showDone: true, unseenOnly: false, needsOperatorOnly: false });
      mounted = create(<MountedInspector />);
    });
    await settle();
    expect(mounted!.root.findAllByProps({ "data-group-box": "external" })).toHaveLength(1);
    const group = text(await client.callTool({ name: "group_create", arguments: { name: "External" } })) as AgentGroup;
    await settle();
    expect(mounted!.root.findAllByProps({ "data-group-box": group.id })).toHaveLength(1);
    expect(mounted!.root.findAllByType("option").map(n => n.children.join(""))).toContain("External");
    await client.callTool({ name: "group_update", arguments: { id: group.id, name: "Renamed outside", color: "teal" } });
    await settle();
    expect(mounted!.root.findAllByType("option").map(n => n.children.join(""))).toContain("Renamed outside");
    expect(appStore.getState().groups.items[0]).toMatchObject({ name: "Renamed outside", color: "teal" });
    appStore.dispatch({ type: "setActiveGroup", groupId: group.id });
    await client.callTool({ name: "group_delete", arguments: { id: group.id } });
    await settle();
    expect(mounted!.root.findAllByProps({ "data-group-box": group.id })).toHaveLength(1);
    expect(JSON.stringify(mounted!.toJSON())).not.toContain("Renamed outside");
    expect(mounted!.root.findAllByType("option").map(n => n.children.join(""))).not.toContain("Renamed outside");
    expect(appStore.getState().groups.items).toEqual([]);
    expect(appStore.getState().activeGroupId).toBeNull();
    expect(engine.supervisor.status("fixture").groups).toEqual([group.id]);
    expect(appStore.getState().agents["fixture"]?.groups).toEqual([group.id]);
    expect(appStore.getState().agents["group:registry"]).toBeUndefined();
    expect(appStore.getState().selectedAgentId).toBe("fixture");
    expect(composerLocal.getState().composeText).toBe("Keep my draft");
    await client.callTool({ name: "agent_remove_groups", arguments: { agentId: "fixture", groups: [group.id] } });
    await settle();
    expect(engine.supervisor.status("fixture").groups).toEqual([]);
    expect(appStore.getState().agents["fixture"]?.groups).toEqual([]);
    expect(mounted!.root.findAllByProps({ "data-group-box": group.id })).toHaveLength(0);
    expect(mounted!.root.findAllByProps({ "data-agent-row": "fixture" })).toHaveLength(1);
    expect(appStore.getState().selectedAgentId).toBe("fixture");
    expect(composerLocal.getState().composeText).toBe("Keep my draft");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    await act(async () => mounted?.unmount()); off(); await client.close(); await server.close(); rmSync(home, { recursive: true, force: true });
  }
});
