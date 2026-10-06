import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "@chimera/protocol/mcp-server-factory";
import { AgentSpecSchema, AgentForgetResultSchema } from "@chimera/protocol";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import { MemoryStore } from "../src/memory.js";
import { MainConductorStore } from "../src/main-conductor.js";
import { EventLog } from "../src/events.js";
import { ChronicleIndex } from "../src/chronicle-index.js";
import { webRequest } from "../src/operator-web-scopes.js";
import type { AgentRecord } from "../src/supervisor.js";
import { makeEngineHome } from "./helpers.js";

const value = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
async function fixture(callerId: string | undefined = "caller", conductor = true, projectId: string | null = null, mainId: string | null = null) {
  const home = makeEngineHome();
  new MainConductorStore(home).set(mainId);
  const backend = new FakeAgentBackend([]);
  const spawn = vi.spyOn(backend, "spawn");
  const engine = new Engine({ home, backends: new Map([["claude", backend]]) });
  const indexDir = join(home, "test-chronicle");
  const index = new ChronicleIndex(indexDir, async () => null);
  // Production disables the index under VITEST; install a real, lexical-only sidecar.
  Object.defineProperty(engine, "chronicle", { value: index });
  const record = (agentId: string, state: AgentRecord["state"] = "done", project: string | null = null) => {
    const rec: AgentRecord = {
      agentId, spec: AgentSpecSchema.parse({ prompt: agentId, cwd: home, conductor: agentId === "caller" && conductor }),
      state, accountName: "main", provider: "claude", depth: 0, treeId: "caller", createdAt: 1,
      principal: "local", parentId: null, projectId: project, attempts: [], costUsd: 0,
    };
    engine.supervisor.reattachTerminal(rec);
    return rec;
  };
  record("caller", "running", projectId);
  const dispatch = vi.fn((method: string, params: unknown) => engine.handle(method, params));
  // Deliberately false: authorization must come from the stored record, not MCP tags.
  const server = await createChimeraMcpServer(dispatch, { agentId: callerId, depth: 0, conductor: false });
  const client = new Client({ name: "forget-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = (args: Record<string, unknown>) => client.callTool({ name: "chimera_call", arguments: { tool: "agent_forget", args } });
  return { home, engine, index, indexDir, record, client, call, spawn, dispatch,
    close: async () => { await client.close(); await server.close(); rmSync(home, { recursive: true, force: true }); } };
}

describe("agent_forget through real MCP and isolated Engine", () => {
  it("discovers the bounded tool, removes only named run data on disk and leaves shared memory intact", async () => {
    const f = await fixture();
    try {
      const discovery = value(await f.client.callTool({ name: "chimera_tools", arguments: { query: "agent_forget", detail: true } }));
      const tool = discovery.tools.find((t: { name: string }) => t.name === "agent_forget");
      expect(tool).toMatchObject({ direct: false, tags: expect.arrayContaining(["agent", "conductor"]) });
      expect(tool.inputSchema.properties.agentIds).toMatchObject({ minItems: 1, maxItems: 100 });
      expect(tool.inputSchema.properties).not.toHaveProperty("callerAgentId");
      const target = f.record("target");
      const other = f.record("other");
      for (const rec of [target, other]) {
        f.engine.agentArchive.write(rec);
        f.engine.mailboxes.enqueue(rec.agentId, { from: "caller", text: "keep only unrelated" });
        const ev = f.engine.events.append({ agentId: rec.agentId, kind: "message_complete", data: { text: "cleanup needle" } });
        f.index.add({ seq: ev.seq, ts: ev.ts, engineId: "local", agentId: rec.agentId, kind: ev.kind, text: "cleanup needle", treeId: "caller", team: null });
        f.engine.terminals.append(rec.agentId, "term", "terminal needle");
      }
      const memory = f.engine.memory.add({ author: "target", text: "Fleet knowledge must survive cleanup", kind: "fact" });
      const result = AgentForgetResultSchema.parse(value(await f.call({ agentIds: ["target", "target"] })));
      expect(result).toMatchObject({ requested: 1, purged: 1, agentIds: ["target"], skipped: [], chronicleDocsRemoved: 1 });
      expect(result.eventsRemoved).toBeGreaterThan(0);
      expect(f.dispatch).toHaveBeenCalledWith("agent.forget", { agentIds: ["target", "target"], callerAgentId: "caller" });
      expect(f.engine.supervisor.snapshotAgents().map(a => a.agentId)).toEqual(expect.arrayContaining(["caller", "other"]));
      expect(f.engine.supervisor.snapshotAgents().map(a => a.agentId)).not.toContain("target");
      expect(f.engine.agentArchive.has("target")).toBe(false);
      expect(f.engine.agentArchive.read("other")).toEqual(other);
      expect(existsSync(join(f.home, "mailboxes", "target.jsonl"))).toBe(false);
      expect(f.engine.mailboxes.pending("target")).toEqual([]);
      expect(f.engine.mailboxes.pending("other")).toHaveLength(1);
      expect(f.engine.terminals.read("target")).toEqual([]);
      expect(f.engine.terminals.read("other")).toHaveLength(1);
      const replay = new EventLog(f.home).replay({ fromSeq: 1, limit: 1000 });
      expect(replay.some(e => e.agentId === "target")).toBe(false);
      expect(replay.some(e => e.agentId === "other")).toBe(true);
      const reloaded = new ChronicleIndex(f.indexDir, async () => null);
      reloaded.load();
      expect((await reloaded.search("cleanup needle", {}, 10)).hits.map(h => h.agentId)).toEqual(["other"]);
      expect(f.engine.memory.get(memory.id).record).toEqual(memory);
      expect(new MemoryStore(f.home).get(memory.id).record).toEqual(memory);
      expect(value(await f.call({ agentIds: ["target"] }))).toMatchObject({ purged: 0, eventsRemoved: 0, chronicleDocsRemoved: 0, skipped: [{ agentId: "target", reason: "unknown" }] });
      expect(f.spawn).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("reports live/paused/self/unknown skips without killing or widening to unrelated finished agents", async () => {
    const f = await fixture();
    try {
      f.record("running", "running"); f.record("paused", "paused"); f.record("finished");
      const result = value(await f.call({ agentIds: ["running", "paused", "caller", "unknown"] }));
      expect(result).toMatchObject({ purged: 0, skipped: [
        { agentId: "running", reason: "live", state: "running" }, { agentId: "paused", reason: "live", state: "paused" },
        { agentId: "caller", reason: "self" }, { agentId: "unknown", reason: "unknown" },
      ] });
      expect(f.engine.supervisor.list()).toHaveLength(4);
      expect(f.spawn).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["project-b", null])("uses record-backed authority, rejects spoofing and scopes project conductors (target project %s)", async foreignProject => {
    const f = await fixture("caller", true, "project-a");
    try {
      f.record("own", "failed", "project-a"); f.record("foreign", "killed", foreignProject);
      expect(value(await f.call({ agentIds: ["own", "foreign"], callerAgentId: "foreign" }))).toMatchObject({ purged: 1, skipped: [{ agentId: "foreign", reason: "outside_scope" }] });
      expect(f.dispatch).toHaveBeenLastCalledWith("agent.forget", { agentIds: ["own", "foreign"], callerAgentId: "caller" });
      f.record("caller", "running");
      f.engine.supervisor.status("caller").spec.conductor = false;
      expect(await f.call({ agentIds: ["foreign"] })).toMatchObject({ isError: true });
      f.record("caller", "done");
      expect(await f.call({ agentIds: ["foreign"] })).toMatchObject({ isError: true });
      expect(f.engine.supervisor.status("foreign")).toBeTruthy();
      expect(() => webRequest("agent.forget", { agentIds: ["foreign"] })).toThrow();
      expect(() => webRequest("agent.purgeTerminal", {})).toThrow();
    } finally { await f.close(); }
  });

  it.each(["running", "paused"] as const)("allows the persisted MAIN seat (%s) to forget across projects through MCP", async state => {
    const f = await fixture("caller", true, null, "caller");
    try {
      f.engine.supervisor.status("caller").state = state;
      expect(JSON.parse(readFileSync(join(f.home, "main-conductor.json"), "utf8"))).toEqual({ conductorId: "caller" });
      expect(await f.engine.handle("main.conductor.status", {})).toEqual({ agentId: "caller", state });
      f.record("project-a-target", "done", "project-a");
      f.record("project-b-target", "failed", "project-b");
      f.record("projectless-target", "killed");
      expect(value(await f.call({ agentIds: ["project-a-target", "project-b-target", "projectless-target"] }))).toMatchObject({
        purged: 3, skipped: [], agentIds: ["project-a-target", "project-b-target", "projectless-target"],
      });
      expect(f.spawn).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each([null, "missing-seat", "another-conductor"])("gives arbitrary projectless conductors exact null scope (MAIN=%s)", async mainId => {
    const f = await fixture("caller", true, null, mainId);
    try {
      f.record("projectless"); f.record("foreign", "done", "project-a");
      if (mainId === "another-conductor") f.record(mainId, "running").spec.conductor = true;
      expect(value(await f.call({ agentIds: ["projectless", "foreign"] }))).toMatchObject({
        purged: 1, agentIds: ["projectless"], skipped: [{ agentId: "foreign", reason: "outside_scope" }],
      });
      expect(f.engine.supervisor.status("foreign")).toBeTruthy();
    } finally { await f.close(); }
  });

  it("revokes fleet scope from a replaced MAIN even if its old record becomes current again", async () => {
    const f = await fixture("caller", true, null, "caller");
    try {
      f.record("foreign", "done", "project-a");
      f.record("caller", "done");
      expect(await f.call({ agentIds: ["foreign"] })).toMatchObject({ isError: true });
      const replacement = await f.engine.ensureMainConductor();
      expect(replacement.agentId).not.toBe("caller");
      expect(new MainConductorStore(f.home).get()).toBe(replacement.agentId);
      // Drain the fake backend before removing the fixture's durable event directory.
      await vi.waitFor(() => expect(f.engine.supervisor.status(replacement.agentId).state).toBe("done"));
      f.record("caller", "running"); f.record("projectless");
      expect(value(await f.call({ agentIds: ["foreign", "projectless"] }))).toMatchObject({
        purged: 1, agentIds: ["projectless"], skipped: [{ agentId: "foreign", reason: "outside_scope" }],
      });
    } finally { await f.close(); }
  });

  it.each(["done", "failed", "killed", "shadow", "ordinary"])("refuses a persisted MAIN whose record is %s", async condition => {
    const f = await fixture("caller", true, null, "caller");
    try {
      f.record("foreign", "done", "project-a");
      const caller = f.engine.supervisor.status("caller");
      if (condition === "shadow") caller.shadow = true;
      else if (condition === "ordinary") caller.spec.conductor = false;
      else caller.state = condition as AgentRecord["state"];
      expect(await f.call({ agentIds: ["foreign"] })).toMatchObject({ isError: true });
      expect(f.engine.supervisor.status("foreign")).toBeTruthy();
    } finally { await f.close(); }
  });

  it("requires a trusted route for identity-free RPC and never elevates a supplied caller", async () => {
    const f = await fixture();
    try {
      f.record("target"); f.record("foreign", "done", "project-a");
      await expect(f.engine.handle("agent.forget", { agentIds: ["target"] })).rejects.toMatchObject({ code: "forbidden" });
      const trusted = { trustedLocalClient: true } as const;
      await expect(f.engine.handle("agent.forget", { agentIds: ["target"], callerAgentId: "missing" }, trusted)).rejects.toMatchObject({ code: "forbidden" });
      f.record("ordinary", "running");
      await expect(f.engine.handle("agent.forget", { agentIds: ["target"], callerAgentId: "ordinary" }, trusted)).rejects.toMatchObject({ code: "forbidden" });
      expect(await f.engine.handle("agent.forget", { agentIds: ["foreign"], callerAgentId: "caller" }, trusted)).toMatchObject({
        purged: 0, skipped: [{ agentId: "foreign", reason: "outside_scope" }],
      });
      expect(f.engine.supervisor.status("target")).toBeTruthy();
      expect(await f.engine.handle("agent.forget", { agentIds: ["target", "foreign"] }, trusted)).toMatchObject({ purged: 2 });
    } finally { await f.close(); }
  });

  it.each([undefined, "missing-caller"])("refuses absent or unknown caller %s without operator fallback", async callerId => {
    const f = await fixture(callerId === undefined ? "caller" : callerId);
    try {
      f.record("target");
      // Undefined explicitly exercises a server without an agent grant.
      if (callerId === undefined) {
        const dispatch = vi.fn((m: string, p: unknown) => f.engine.handle(m, p, { trustedLocalClient: true }));
        const server = await createChimeraMcpServer(dispatch, { depth: 0 });
        const client = new Client({ name: "no-identity", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(a); await client.connect(b);
        try {
          expect(await client.callTool({ name: "chimera_call", arguments: { tool: "agent_forget", args: { agentIds: ["target"] } } })).toMatchObject({ isError: true });
          expect(dispatch.mock.calls.some(([method]) => method === "agent.forget")).toBe(false);
        }
        finally { await client.close(); await server.close(); }
      } else expect(await f.call({ agentIds: ["target"] })).toMatchObject({ isError: true });
      expect(f.engine.supervisor.status("target")).toBeTruthy();
    } finally { await f.close(); }
  });

  it.each([{}, { agentIds: [] }, { agentIds: [""] }, { agentIds: [" "] }, { agentIds: ["remote/id"] }, { agentIds: ["../target"] }, { agentIds: Array(101).fill("target") }])("rejects invalid explicit targets %j before cleanup", async args => {
    const f = await fixture();
    try {
      f.record("target");
      expect(await f.call(args)).toMatchObject({ isError: true });
      expect(f.engine.supervisor.status("target")).toBeTruthy();
    } finally { await f.close(); }
  });
});
