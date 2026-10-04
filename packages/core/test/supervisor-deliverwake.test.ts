import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// PLAN-HOOKS.md §4.3 gap fix (b): afterResult's deliverTo enqueue used to drop the child_result
// silently once the target had already settled (deliverPending's running-only guard bails, and
// nothing ever rechecked that mailbox — unlike user_message, which checkPendingOnSettle already
// covered). checkDeliverTargetSettled (supervisor.ts) closes that gap: per-CHILD opt-in via
// spec.deliverWake:"resume" wakes the settled target; omitted surfaces an explicit
// undeliveredMessage status event on the target instead of silence.
describe("AgentSupervisor: deliverWake (HOOK-2 gap fix b)", () => {
  it("names a failed target instead of claiming its saved session is missing", async () => {
    const { sup, fake, events } = makeSupervisor([
      [{ emit: { kind: "agent_started", data: { sessionId: "saved-session" } } }, { fail: { message: "probe unavailable" } }],
      [{ end: { resultText: "child answer" } }],
    ]);
    const parent = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" });
    await waitUntil(() => sup.status(parent.agentId).state === "failed");
    await sup.spawn({ prompt: "c", cwd: "/tmp", account: "second", isolation: "none", deliverTo: parent.agentId, deliverWake: "resume" });
    await waitUntil(() => events.tail(parent.agentId, 50).some(e => e.data["undeliveredMessage"]));
    const warning = events.tail(parent.agentId, 50).find(e => e.data["undeliveredMessage"]);
    expect(warning?.data["reason"]).toBe("deliverWake resume failed: agent failed; automatic resume is disabled");
    expect(sup.status(parent.agentId).sessionId).toBe("saved-session");
    expect(fake.spawns).toHaveLength(2);
  });

  it("without deliverWake, a child_result arriving after the target settled surfaces an undeliveredMessage event instead of vanishing", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "parent-s1" } } }, { end: { resultText: "parent done" } }],
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "child answer" } }],
    ];
    const { sup, fake, events } = makeSupervisor(scenarios);
    const parent = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" }, { agentId: "parent-1" });
    await waitUntil(() => sup.status(parent.agentId).state === "done");

    await sup.spawn({ prompt: "c", cwd: "/tmp", account: "second", isolation: "none", deliverTo: parent.agentId });
    await waitUntil(() => events.tail(parent.agentId, 50).some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true));

    expect(fake.spawns).toHaveLength(2);   // no resume attempted
  });

  it("with deliverWake:'resume', a child_result arriving after the target settled resumes it exactly once and delivers", async () => {
    // Scenarios are consumed in SPAWN-CALL order: [0] the parent's initial spawn, [1] the
    // child's spawn (which settles BEFORE any resume happens), [2] the parent's resume spawn
    // (triggered only once the child's afterResult sees the parent already settled).
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "parent-s2" } } }, { end: { resultText: "parent done" } }],
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "child answer" } }],
      // the resumed run: awaitSend proves the stranded child_result actually got delivered.
      [{ emit: { kind: "agent_started", data: { sessionId: "parent-s2" } } }, { awaitSend: true }, { end: { resultText: "parent resumed" } }],
    ];
    const { sup, fake, events } = makeSupervisor(scenarios);
    const parent = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" }, { agentId: "parent-2" });
    await waitUntil(() => sup.status(parent.agentId).state === "done");

    await sup.spawn({ prompt: "c", cwd: "/tmp", account: "second", isolation: "none", deliverTo: parent.agentId, deliverWake: "resume" });
    await waitUntil(() => fake.spawns.length >= 3 && sup.status(parent.agentId).state === "done");

    const resumeSpawn = fake.spawns[2];
    expect(resumeSpawn?.resume).toBe("parent-s2");
    expect(resumeSpawn?.resumeOnly).toBe(true);
    expect(sup.status(parent.agentId).resultText).toBe("parent resumed");
    // the resumed run's OWN mailbox drain (deliverBatch) is what actually delivered the stranded
    // child_result — its "delivered" status event carries the original text verbatim.
    const tail = events.tail(parent.agentId, 100);
    expect(tail.some((e) => e.kind === "status" && e.data["delivered"] === true && e.data["text"] === "child answer")).toBe(true);
  });

  it("with deliverWake:'resume' but a KILLED target, never resumes — surfaces undeliveredMessage instead", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "parent-s3" } } }, { awaitSend: true }],
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "child answer" } }],
    ];
    const { sup, fake, events } = makeSupervisor(scenarios);
    const parent = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" }, { agentId: "parent-3" });
    await new Promise((r) => setTimeout(r, 20));
    await sup.kill(parent.agentId);
    await waitUntil(() => sup.status(parent.agentId).state === "killed");
    const spawnsBeforeChild = fake.spawns.length;

    await sup.spawn({ prompt: "c", cwd: "/tmp", account: "second", isolation: "none", deliverTo: parent.agentId, deliverWake: "resume" });
    await waitUntil(() => events.tail(parent.agentId, 50).some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true));

    expect(fake.spawns).toHaveLength(spawnsBeforeChild + 1);   // no resume of a killed agent
    expect(sup.status(parent.agentId).state).toBe("killed");
  });
});
