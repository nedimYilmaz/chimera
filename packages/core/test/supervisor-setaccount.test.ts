import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError, GuardrailError } from "@chimera/core/supervisor";
import { ConfigError } from "@chimera/core/accounts";
import { makeSupervisor, makeMultiProviderSupervisor } from "./helpers.js";
import { MailboxStore } from "@chimera/core/mailbox";
import { waitUntil } from "./coord-helpers.js";

it("delivers pending results to a silent resumed session without waiting for agent_started", async () => {
  const { sup, fake, dir, events } = makeSupervisor([
    [{ emit: { kind: "agent_started", data: { sessionId: "saved-session" } } }, { fail: { message: "capability probe unavailable" } }],
    // Codex resumeOnly does not emit thread.started until runStreamed gets input.
    [{ awaitSend: true }, { emit: { kind: "agent_started", data: { sessionId: "saved-session" } } }, { end: { resultText: "collected" } }],
  ]);
  const rec = await sup.spawn({ prompt: "existing task", cwd: "/tmp", isolation: "none", account: "main", conductor: true });
  await waitUntil(() => sup.status(rec.agentId).state === "failed");
  const mail = new MailboxStore(dir);
  mail.enqueue(rec.agentId, { from: "child", kind: "child_result", text: "completed work" });
  await sup.setAccount(rec.agentId, "main");
  await waitUntil(() => sup.status(rec.agentId).state === "done", 1000);
  expect(fake.spawns[1]).toMatchObject({ agentId: rec.agentId, resume: "saved-session", resumeOnly: true });
  expect(mail.pending(rec.agentId)).toEqual([]);
  expect(events.tail(rec.agentId, 50).filter(e => e.data["delivered"] && e.data["text"] === "completed work")).toHaveLength(1);
});

// ACCOUNT-SWITCH-LIVE: agent.setAccount — mirrors agent.setModel's respawn-with-resume
// under the SAME agentId exactly, restricted to SAME-PROVIDER targets: core rejects a
// cross-provider account (GuardrailError) BEFORE killing the live session.

// a scenario that reports a sessionId (so setAccount has something to resume) and then
// parks on awaitSend forever — the agent stays "running" until the test kills/respawns it.
const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

describe("AgentSupervisor.setAccount", () => {
  it("respawns under the SAME agentId on the new SAME-PROVIDER account, resuming the old sessionId (resumeOnly)", async () => {
    const { sup, fake } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await new Promise((r) => setTimeout(r, 20));   // let the fake's fire-and-forget agent_started settle
    expect(rec.sessionId).toBe("sess-1");
    expect(rec.accountName).toBe("main");

    const updated = await sup.setAccount(rec.agentId, "second");

    expect(updated.agentId).toBe(rec.agentId);          // SAME agentId (CR1 continuity)
    expect(updated.accountName).toBe("second");
    expect(updated.provider).toBe("claude");            // same provider, unchanged
    expect(updated.state).toBe("running");

    expect(fake.spawns).toHaveLength(2);                 // original spawn + respawn
    const respawned = fake.spawns[1];
    expect(respawned?.accountName).toBe("second");
    expect(respawned?.resume).toBe("sess-1");
    expect(respawned?.resumeOnly).toBe(true);
  });

  it("kills the old query before respawning (killed status event precedes the respawn's agent_started)", async () => {
    const { sup, events } = makeSupervisor([RUNNING_WITH_SESSION, RUNNING_WITH_SESSION]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await new Promise((r) => setTimeout(r, 20));

    await sup.setAccount(rec.agentId, "second");
    await new Promise((r) => setTimeout(r, 20));   // let the respawn's fire-and-forget agent_started settle

    const tail = events.tail(rec.agentId, 50);
    const killedIdx = tail.findIndex((e) => e.kind === "status" && e.data["state"] === "killed");
    const startedIdx = tail.findIndex((e, i) => e.kind === "agent_started" && i > killedIdx);
    expect(killedIdx).toBeGreaterThanOrEqual(0);
    expect(startedIdx).toBeGreaterThan(killedIdx);        // respawn's agent_started comes AFTER the kill
  });

  it("emits a failover-shaped event on a successful switch (from/to/provider)", async () => {
    const { sup, events } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await new Promise((r) => setTimeout(r, 20));

    await sup.setAccount(rec.agentId, "second");

    const tail = events.tail(rec.agentId, 50);
    const failover = tail.find((e) => e.kind === "failover");
    expect(failover?.data["from"]).toBe("main");
    expect(failover?.data["to"]).toBe("second");
    expect(failover?.data["provider"]).toBe("claude");
  });

  it("compacts the source into a fresh cross-provider session under the same identity", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([RUNNING_WITH_SESSION, [{ end: { resultText: "Preserve the no-rebuild constraint; next run tests." } }]], [[{ awaitSend: true }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "cl-main" });
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.provider).toBe("claude");

    const updated = await sup.setAccount(rec.agentId, "cx-main", "gpt-6-astra");

    // the live session was never killed/respawned by the rejected request
    const status = sup.status(rec.agentId);
    expect(status.state).toBe("running");
    expect(status.accountName).toBe("cx-main");
    expect(updated.agentId).toBe(rec.agentId);
    expect(claude.spawns).toHaveLength(2);
    expect(claude.spawns[1]?.resume).toBe("sess-1");
    expect(codex.spawns).toHaveLength(1);
    expect(codex.spawns[0]?.resume).toBeNull();
    expect(codex.spawns[0]?.model).toBe("gpt-6-astra");
    expect(codex.spawns[0]?.prompt).toContain("Preserve the no-rebuild constraint");
  });

  it("throws ConfigError for an unknown account name", async () => {
    const { sup } = makeSupervisor([RUNNING_WITH_SESSION]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.setAccount(rec.agentId, "ghost-account")).rejects.toBeInstanceOf(ConfigError);
    expect(sup.status(rec.agentId).state).toBe("running");   // rejected before kill()
  });

  it("throws UnknownAgentError for a ghost/unknown agentId", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.setAccount("ghost-id", "second")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("preserves treeId, depth, and conductor across the respawn", async () => {
    const { sup } = makeSupervisor([RUNNING_WITH_SESSION, [{ awaitSend: true }]]);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", account: "main", conductor: true },
      { agentId: "cond-1", treeId: "tree-x", depth: 2 },
    );
    expect(rec.treeId).toBe("tree-x");
    expect(rec.depth).toBe(2);
    expect(rec.spec.conductor).toBe(true);
    await new Promise((r) => setTimeout(r, 20));

    const updated = await sup.setAccount("cond-1", "second");

    expect(updated.agentId).toBe("cond-1");
    expect(updated.treeId).toBe("tree-x");
    expect(updated.depth).toBe(2);
    expect(updated.spec.conductor).toBe(true);
  });
});
