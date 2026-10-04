import { describe, it, expect } from "vitest";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// INSPECTOR-PLACEMENT AUDIT: resolveTaskOriginConductor (engine.ts) is the ONLY
// producer of TaskRecord.originConductorId, which ui-state's treeOrder() later
// trusts UNCONDITIONALLY to splice a task's whole tree under that id as a visual
// child. It used to end with a last-resort fallback that GUESSED "whichever
// teamless/projectless conductor was created most recently" whenever neither the
// pusher chain nor a project match resolved a real owner -- durably misattributing
// an unrelated team's worker as a child of an arbitrary conductor (reported: a
// team-queue task rendered nested under a wholly unrelated conductor). These tests
// pin the three real branches, especially the fixed one: no resolvable owner must
// yield null, never a guess.

function engineOn(home: string): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
}

describe("Engine queue.push: originConductorId resolution (INSPECTOR-PLACEMENT AUDIT)", () => {
  it("resolves through the pusher's OWN id when it is itself a real (teamless) conductor", async () => {
    const e = engineOn(makeEngineHome());
    const conductor = (await e.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", isolation: "none", conductor: true },
    })) as { agentId: string };
    await e.handle("queue.create", { spec: { name: "work", retryLimit: 0 } });
    const task = (await e.handle("queue.push", {
      queue: "work", prompt: "job", pushedBy: conductor.agentId,
    })) as { originConductorId: string | null };
    expect(task.originConductorId).toBe(conductor.agentId);
  });

  it("resolves via a matching project's own conductor when the pusher chain doesn't resolve one", async () => {
    const e = engineOn(makeEngineHome());
    await e.handle("queue.create", { spec: { name: "onboard", retryLimit: 0 } });
    await e.handle("project.create", { name: "widgets", queue: "onboard" });
    const conductor = (await e.handle("project.conductor.start", { name: "widgets" })) as { agentId: string };
    const task = (await e.handle("queue.push", { queue: "onboard", prompt: "job" })) as { originConductorId: string | null };
    expect(task.originConductorId).toBe(conductor.agentId);
  });

  it("REGRESSION: no pusher-chain owner and no project match -> null, NEVER a guessed unrelated conductor", async () => {
    const e = engineOn(makeEngineHome());
    // An unrelated, teamless, projectless conductor exists and is the most RECENTLY
    // created agent in the whole engine -- exactly the record the old fallback
    // would have guessed via `sort((a,b)=>b.createdAt-a.createdAt)[0]`.
    await e.handle("agent.spawn", { spec: { prompt: "unrelated", cwd: "/tmp", isolation: "none", conductor: true } });
    await e.handle("queue.create", { spec: { name: "orphan-queue", retryLimit: 0 } });
    const task = (await e.handle("queue.push", {
      queue: "orphan-queue", prompt: "job",   // no pushedBy: a scheduled-job-style push
    })) as { originConductorId: string | null };
    expect(task.originConductorId).toBeNull();
  });
});

it("queue tasks inherit an ad-hoc orchestrator's lineage without a conductor flag", async () => {
  const e = engineOn(makeEngineHome());
  const parent = await e.handle("agent.spawn", { spec: { prompt: "manage", cwd: "/tmp", isolation: "none", session: true } }) as { agentId: string };
  const child = await e.handle("agent.spawn", { spec: { prompt: "delegate", cwd: "/tmp", isolation: "none" }, parentId: parent.agentId }) as { agentId: string };
  await e.handle("queue.create", { spec: { name: "work" } });
  expect(await e.handle("queue.push", { queue: "work", prompt: "job", pushedBy: child.agentId })).toMatchObject({ originConductorId: parent.agentId });
});

it("uses the queue team's recorded creator for operator pushes but never guesses across conflicting owners", async () => {
  const e = engineOn(makeEngineHome());
  await e.handle("queue.create", { spec: { name: "owned" } });
  const makeOwner = async (name: string) => {
    const parent = await e.handle("agent.spawn", { spec: { prompt: "manage", cwd: "/tmp", isolation: "none", conductor: true } }) as { agentId: string };
    await e.handle("team.create", { spec: { name, createdBy: parent.agentId, queue: "owned", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", isolation: "none" } } } } });
    return parent.agentId;
  };
  const first = await makeOwner("first");
  expect(await e.handle("queue.push", { queue: "owned", prompt: "job" })).toMatchObject({ originConductorId: first });
  await makeOwner("second");
  expect(await e.handle("queue.push", { queue: "owned", prompt: "another" })).toMatchObject({ originConductorId: null });
});
