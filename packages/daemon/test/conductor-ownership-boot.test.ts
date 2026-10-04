import { afterAll, describe, expect, it } from "vitest";
import { ChimeraClient } from "@chimera/client";
import type { AgentRecord, TaskRecord } from "@chimera/protocol";
import { makeEngineHome } from "../../core/test/helpers.js";

// Deterministic full-boot blackbox: attribution travels over the real RPC wire,
// through queue persistence and scheduler pickup, and back through agent.list.
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };
let client: ChimeraClient | null = null;

afterAll(async () => {
  await client?.request("daemon.stop").catch(() => {});
  client?.close();
});

describe("queue worker conductor ownership survives a full daemon boot", () => {
  it("exposes the initiating conductor on both the durable task and spawned worker", async () => {
    client = await ChimeraClient.connect({ home, env });
    const conductor = await client.request<AgentRecord>("agent.spawn", {
      spec: { prompt: "coordinate", cwd: home, isolation: "none", conductor: true },
    });
    await client.request("queue.create", { spec: { name: "owned-work" } });
    await client.request("team.create", {
      spec: {
        name: "owned-crew",
        roles: { dev: { role: "blank", overrides: { cwd: home, account: "main", isolation: "none" } } },
        maxConcurrent: 1,
        queue: "owned-work",
      },
    });

    const pushed = await client.request<TaskRecord>("queue.push", {
      queue: "owned-work", prompt: "do the work", pushedBy: conductor.agentId,
    });
    expect(pushed.originConductorId).toBe(conductor.agentId);

    let worker: AgentRecord | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const agents = await client.request<AgentRecord[]>("agent.list", {});
      worker = agents.find((a) => a.membership?.team === "owned-crew");
      if (worker) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(worker?.originConductorId).toBe(conductor.agentId);
    expect(worker?.parentId).toBeNull();

    const status = await client.request<{ tasks: TaskRecord[] }>("queue.status", { queue: "owned-work" });
    expect(status.tasks.find((task) => task.taskId === pushed.taskId)?.originConductorId).toBe(conductor.agentId);
  }, 20_000);
});
