import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import { makeEngineHome } from "./helpers.js";
import { operatorWebEngine } from "../src/operator-web-engine.js";
import { EventLog } from "../src/events.js";
import { QueueStore } from "../src/queues.js";
import type { OperatorWebSession } from "@chimera/protocol";
import type { AgentRecord } from "../src/supervisor.js";
const session: OperatorWebSession = { id: "session", project: "one", deviceLabel: "Test", scope: "control", createdAt: 1, lastUsedAt: 1, expiresAt: 10000 };
function fixture(seedQueues?: (home: string) => void) {
  const home = makeEngineHome();
  for (const dir of ["one", "two", "third"]) mkdirSync(join(home, dir));
  seedQueues?.(home);
  const e = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([])]]) });
  e.projects.create({ name: "one", path: join(home, "one"), queue: "one-q" }); e.projects.create({ name: "two", path: join(home, "two"), queue: "two-q" });
  for (const name of ["one-q", "two-q"]) if (!e.queues.list().some(q => q.name === name)) e.queues.create({ name });
  const rows = ["one", "two"].map(projectId => ({ agentId: projectId + "-a", projectId, state: "running", shadow: false, spec: { displayLabel: projectId, prompt: "sk-secret-do-not-expose" } })) as unknown as AgentRecord[];
  vi.spyOn(e.supervisor, "list").mockReturnValue(rows);
  vi.spyOn(e.supervisor, "status").mockImplementation(id => { const a = rows.find(a => a.agentId === id); if (!a) throw Error(); return a; });
  return { e, deps: operatorWebEngine(e), rows, home };
}
describe("project authorization using real engine stores", () => {
  it("projects only explicit project agents and exclusive queues, without specs or credentials", async () => {
    const { e, deps, home } = fixture();
    const snapshot = await deps.snapshot(session); expect(snapshot.agents.map(a => a.agentId)).toEqual(["one-a"]); expect(snapshot.queues.map(q => q.name)).toEqual(["one-q"]);
    expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
    const ownTask = e.queues.push("one-q", { prompt: "Own" }), foreign = e.queues.push("two-q", { prompt: "Foreign" });
    expect(deps.visible(session, "queue:one-q")).toBe(true); expect(deps.visible(session, "queue:two-q")).toBe(false);
    expect(deps.visible(session, `task:${ownTask.taskId}`)).toBe(true); expect(deps.visible(session, `task:${foreign.taskId}`)).toBe(false);
    e.projects.create({ name: "third", path: join(home, "third"), queue: "one-q" }); expect((await deps.snapshot(session)).queues).toEqual([]);
    await expect(deps.dispatch(session, "queue.pause", { queue: "one-q" })).rejects.toThrow("scope");
  });
  it("denies foreign agent, batch, queue, task/review/evidence and attention IDs before calling engine", async () => {
    const { e, deps } = fixture(); const foreignTask = e.queues.push("two-q", { prompt: "foreign task" });
    const handle = vi.spyOn(e, "handle");
    for (const [method, params] of [
      ["agent.send", { agentId: "two-a", text: "hello" }], ["agent.hold", { agentIds: ["one-a", "two-a"] }], ["agent.tail", { agentId: "peer/one-a" }],
      ["queue.pause", { queue: "two-q" }], ["queue.cancelTask", { taskId: foreignTask.taskId }], ["review.get", { taskId: foreignTask.taskId }], ["review.decide", { taskId: foreignTask.taskId }], ["evidence.get", { taskId: foreignTask.taskId }],
      ["agent.permissionRespond", { requestId: "unknown", allow: true }], ["agent.answerQuestion", { questionId: "unknown", answer: { text: "answer" } }],
    ] as Array<[string, Record<string, unknown>]>) await expect(deps.dispatch(session, method, params)).rejects.toThrow("scope");
    expect(handle).not.toHaveBeenCalled();
  });
  it("control calls reuse real queue pause/resume/push/cancel contracts and write a redacted audit", async () => {
    const { e, deps } = fixture();
    expect(await deps.dispatch(session, "queue.pause", { queue: "one-q" })).toEqual({ paused: true }); expect(e.queues.get("one-q").paused).toBe(true);
    const task = await deps.dispatch(session, "queue.push", { queue: "one-q", prompt: "isolated synthetic work" }) as { taskId: string };
    expect(await deps.dispatch(session, "queue.cancelTask", task)).toMatchObject({ cancelled: true });
    expect(await deps.dispatch(session, "queue.resume", { queue: "one-q" })).toEqual({ paused: false });
    deps.audit(session, "queue.pause"); expect(e.auditLedger.verify().ok).toBe(true);
  });
  it("real engine settings RPC is off by default, scopes pairing and closes without touching tasks", async () => {
    const { e } = fixture();
    expect(await e.handle("operatorweb.operatorStatus", {})).toMatchObject({ enabled: false });
    for (const method of ["status", "enable", "disable", "pairStart", "sessionList", "sessionRevoke", "settingsSet", "futureManagement"]) {
      await expect(e.handle(`operatorweb.${method}`, {})).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(e.operatorWeb.status().enabled).toBe(false);
    const local = { trustedLocalClient: true } as const;
    for (const callerAgentId of ["one-a", "forged", "", null]) {
      await expect(e.handle("operatorweb.status", { callerAgentId }, local)).rejects.toMatchObject({ code: "forbidden" });
    }
    try {
      const status = await e.handle("operatorweb.enable", {}, local) as { localUrl: string };
      const p = await e.handle("operatorweb.pairStart", { project: "one", allowControl: false }, local) as { code: string };
      const response = await fetch(status.localUrl + "/pair", { method: "POST", headers: { Origin: status.localUrl, "Content-Type": "application/json" }, body: JSON.stringify({ code: p.code, deviceLabel: "Synthetic browser", scope: "read" }) });
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const snapshot = await fetch(status.localUrl + "/snapshot", { headers: { Cookie: cookie } }); expect(await snapshot.json()).toMatchObject({ project: "one", scope: "read", agents: [{ agentId: "one-a" }] });
      expect(await e.handle("operatorweb.operatorStatus", {})).not.toHaveProperty("localUrl");
      await e.handle("operatorweb.sessionRevoke", { id: null }, local); expect((await fetch(status.localUrl + "/snapshot", { headers: { Cookie: cookie } })).status).toBe(401);
    } finally { await e.operatorWeb.close(); }
  });
  it("rejects foreign resources and indirect dispatch over real authenticated HTTP", async () => {
    const { e } = fixture(); const local = { trustedLocalClient: true } as const;
    const foreign = e.queues.push("two-q", { prompt: "foreign secret prompt" });
    try {
      const { localUrl } = await e.handle("operatorweb.enable", {}, local) as { localUrl: string };
      const { code } = await e.handle("operatorweb.pairStart", { project: "one", allowControl: true }, local) as { code: string };
      const response = await fetch(localUrl + "/pair", { method: "POST", headers: { Origin: localUrl, "Content-Type": "application/json" }, body: JSON.stringify({ code, deviceLabel: "Owned test", scope: "control" }) });
      const { csrf } = await response.json(); const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      const handle = vi.spyOn(e, "handle");
      const calls = [
        ["agent.tail", { agentId: "two-a" }], ["agent.send", { agentId: "two-a", text: "no" }],
        ["agent.hold", { agentIds: ["one-a", "two-a"] }], ["queue.status", { queue: "two-q" }],
        ["queue.pause", { queue: "two-q" }], ["review.get", { taskId: foreign.taskId }],
        ["queue.cancelTask", { taskId: foreign.taskId }], ["evidence.get", { taskId: foreign.taskId }],
        ["mcpstore.call", {}], ["terminal.write", {}], ["operatorweb.pairStart", {}],
      ];
      for (const [method, params] of calls) {
        const denied = await fetch(localUrl + "/rpc", { method: "POST", headers: { Origin: localUrl, "Content-Type": "application/json", Cookie: cookie, "X-Chimera-CSRF": csrf }, body: JSON.stringify({ id: String(method), method, params }) });
        expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("foreign secret");
      }
      expect(handle).not.toHaveBeenCalled(); expect(e.queues.get("two-q").paused).toBe(false);
      expect(e.queues.getTask(foreign.taskId).state).toBe("pending");
    } finally { await e.operatorWeb.close(); }
  });
});
it("bounds UTF-8 queue snapshots under the HTTP response cap and reports truncation", async () => {
  const prompt = "😀".repeat(3000);
  const { e, deps } = fixture(home => {
    const events = new EventLog(home), queues = new QueueStore(home, events);
    const spec = queues.create({ name: "one-q" }), template = queues.push("one-q", { prompt });
    // Seed a real persisted store once: 300 pushes rewrite about 587 MB of growing
    // queue state, testing filesystem throughput rather than snapshot bounds.
    const tasks = Array.from({ length: 300 }, (_, n) => ({ ...template, taskId: `utf8-task-${n}`, orderKey: n }));
    writeFileSync(join(home, "queues.json"), JSON.stringify({ queues: [spec], tasks }));
    events.flushDurable();
  });
  const stored = e.queues.status("one-q").tasks;
  expect(stored).toHaveLength(300);
  expect(stored.every(t => t.prompt === prompt)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(stored))).toBeGreaterThan(1_048_576);
  const snapshot = await deps.snapshot(session);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(1_048_576);
  expect(snapshot.truncated).toBe(true);
  const tasks = snapshot.queues[0]!.tasks;
  expect(tasks.length).toBeGreaterThan(0);
  // The byte budget must truncate before the independent 200-task count cap.
  expect(tasks.length).toBeLessThan(200);
  expect(tasks.every(t => t.prompt === "😀".repeat(500) + "… [truncated]")).toBe(true);
  expect(tasks.map(t => t.taskId)).toEqual(stored.slice(0, tasks.length).map(t => t.taskId));
  const taskBytes = tasks.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t)), 0);
  expect(taskBytes).toBeLessThanOrEqual(400_000);
  const next = { taskId: stored[tasks.length]!.taskId, state: stored[tasks.length]!.state, prompt: tasks[0]!.prompt };
  expect(taskBytes + Buffer.byteLength(JSON.stringify(next))).toBeGreaterThan(400_000);
});
it("does not offer release for budget/session-limit pauses", async () => {
  const { rows, deps } = fixture(); rows[0]!.state = "paused"; rows[0]!.pauseReason = "session-limit";
  expect((await deps.snapshot(session)).agents[0]!.held).toBe(false);
  rows[0]!.pauseReason = "operator-hold"; expect((await deps.snapshot(session)).agents[0]!.held).toBe(true);
});
