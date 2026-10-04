import { describe, it, expect, vi } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// RESPAWN-KEEPS-IDENTITY: every kill+respawn-under-the-same-agentId path handed spawn() only
// `{ agentId, treeId, depth }`, so an agent came back without its team, its session role or its
// origin conductor. Observed live: an operator moved three team agents with agent_set_account to
// work around a stuck cooldown and all three fell out of their team (agent_find showed role:null).

vi.setConfig({ testTimeout: 15_000 });

// Stays alive waiting for input, so each respawn happens on a LIVE agent, as in production.
const IDLE: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "ok", costUsd: 0 } }];

const IDENTITY = {
  membership: { team: "chimera-harness", role: "dev-opus" },
  sessionRole: "dev-opus",
  originConductorId: "conductor-1",
  principal: "operator-nedim",
  parentId: "parent-agent",
} as const;

async function spawnWithIdentity(sup: Awaited<ReturnType<typeof makeSupervisor>>["sup"]) {
  return sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" }, { ...IDENTITY });
}

function expectIdentityIntact(rec: { membership?: unknown; sessionRole?: unknown; originConductorId?: unknown; principal?: unknown; parentId?: unknown }): void {
  expect(rec.membership).toEqual(IDENTITY.membership);
  expect(rec.sessionRole).toBe(IDENTITY.sessionRole);
  expect(rec.originConductorId).toBe(IDENTITY.originConductorId);
  expect(rec.principal).toBe(IDENTITY.principal);
  expect(rec.parentId).toBe(IDENTITY.parentId);
}

describe("respawn preserves identity", () => {
  it("setAccount keeps team membership, session role and origin conductor", async () => {
    const { sup } = makeSupervisor([IDLE, IDLE]);
    const rec = await spawnWithIdentity(sup);
    expectIdentityIntact(rec);

    const next = await sup.setAccount(rec.agentId, "second");

    expect(next.agentId).toBe(rec.agentId);
    expect(next.accountName).toBe("second");
    expectIdentityIntact(next);
    expectIdentityIntact(sup.status(rec.agentId));
  });

  it("reconfigure keeps them too", async () => {
    const { sup } = makeSupervisor([IDLE, IDLE]);
    const rec = await spawnWithIdentity(sup);

    const next = await sup.reconfigure(rec.agentId, { model: "claude-sonnet-5" });

    expect(next.spec.model).toBe("claude-sonnet-5");
    expectIdentityIntact(next);
  });

  it("setModel and setEffort keep them too", async () => {
    const { sup } = makeSupervisor([IDLE, IDLE, IDLE]);
    const rec = await spawnWithIdentity(sup);

    expectIdentityIntact(await sup.setModel(rec.agentId, "claude-sonnet-5"));
    expectIdentityIntact(await sup.setEffort(rec.agentId, "high"));
  });

  it("setTurnLimit keeps them too", async () => {
    const { sup } = makeSupervisor([IDLE, IDLE]);
    const rec = await spawnWithIdentity(sup);

    expectIdentityIntact(await sup.setTurnLimit(rec.agentId, { maxTurns: 42 }));
  });
});
