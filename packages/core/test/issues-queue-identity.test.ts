import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/queues.js";
import { EventLog } from "../src/events.js";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import { makeEngineHome } from "./helpers.js";
const taskId = `gh-${"a".repeat(64)}`;
function rig() {
  const home = mkdtempSync(join(tmpdir(), "issue-identity-"));
  const queues = new QueueStore(home, new EventLog(home));
  queues.create({ name: "work", paused: true }); queues.create({ name: "other", paused: true });
  return queues;
}
describe("internal issue task identity", () => {
  it("validates recovery IDs and rejects a foreign task payload without overwriting it", () => {
    const queues = rig();
    for (const id of ["", "../../task", "gh-short", "ordinary-id"]) expect(() => queues.push("work", { taskId: id, prompt: "issue" })).toThrow();
    const task = queues.push("work", { taskId, prompt: "issue", tags: ["gh-issue"], pushedBy: "caller" });
    expect(queues.push("work", { taskId, prompt: "issue", tags: ["gh-issue"], pushedBy: "caller" })).toBe(task);
    for (const patch of [{ prompt: "different" }, { tags: [] }, { pushedBy: "foreign" }, { overrides: { permission: "full" } }])
      expect(() => queues.push("work", { taskId, prompt: "issue", tags: ["gh-issue"], pushedBy: "caller", ...patch })).toThrow();
    expect(() => queues.push("other", { taskId, prompt: "issue" })).toThrow();
    expect(queues.getTask(taskId)).toBe(task); expect(task.prompt).toBe("issue"); expect(queues.allTasks()).toHaveLength(1);
  });
  it("cannot bypass dependency validation with an existing ID or construct a self-cycle", () => {
    const queues = rig(); queues.push("work", { taskId, prompt: "issue" });
    const foreign = queues.push("other", { prompt: "foreign" });
    for (const id of ["missing", foreign.taskId, taskId]) expect(() => queues.push("work", { taskId, prompt: "issue", dependsOn: [id] })).toThrow();
    expect(queues.getTask(taskId).dependsOn).toEqual([]);
  });
  it("raw and parsed public queue.push ignore taskId and never cross-link an existing task", async () => {
    const engine = new Engine({ home: makeEngineHome(), backends: new Map([["claude", new FakeAgentBackend([])]]) });
    await engine.handle("queue.create", { spec: { name: "work", paused: true } });
    const request = { queue: "work", prompt: "ordinary", taskId };
    const parsed = RPC_CONTRACT["queue.push"].request.parse(request);
    expect(parsed).not.toHaveProperty("taskId");
    const raw = await engine.handle("queue.push", request) as { taskId: string };
    const normal = await engine.handle("queue.push", parsed) as { taskId: string };
    const collision = await engine.handle("queue.push", { ...request, taskId: raw.taskId, prompt: "new" }) as { taskId: string };
    expect(new Set([raw.taskId, normal.taskId, collision.taskId]).size).toBe(3); expect(raw.taskId).not.toBe(taskId);
    expect(engine.queues.getTask(raw.taskId).prompt).toBe("ordinary");
  });
});
