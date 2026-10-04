import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver, type ExecFn } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { AgentSupervisor } from "@chimera/core/supervisor";

// R2 EFFORT: mirrors supervisor-setmodel-atomic.test.ts exactly — setEffort shares the
// SAME kill()-then-spawn() atomic-failure path as setModel (see supervisor.ts's setEffort,
// a near-verbatim copy of setModel). A respawn that throws after spawn() has already
// overwritten the killed record must restore a VISIBLE terminal "failed" record for
// agentId, not leave it absent from the agents map.

const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

function makeFlakySupervisor(exec: ExecFn) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-effort-atomic-"));
  const cfg = ChimeraConfigSchema.parse({
    accounts: [{ name: "flaky", provider: "claude", auth: { type: "command", run: "irrelevant", injectAs: "ANTHROPIC_API_KEY" } }],
    autoOrder: ["flaky"],
  });
  const fake = new FakeAgentBackend([RUNNING_WITH_SESSION]);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(exec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
  });
  return { sup, fake, events, dir };
}

describe("AgentSupervisor.setEffort — failed respawn stays VISIBLE (not absent)", () => {
  it("respawn forced to throw (Error): setEffort rejects AND the agent is present as failed with 'effort change failed'", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls++;
      return calls === 1 ? { stdout: "tok\n", code: 0 } : { stdout: "", code: 1 };
    };
    const { sup, events } = makeFlakySupervisor(exec);

    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "flaky" });
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.sessionId).toBe("sess-1");

    await expect(sup.setEffort(rec.agentId, "high")).rejects.toThrow(/credential/i);

    const after = sup.status(rec.agentId);
    expect(after.state).toBe("failed");
    expect(sup.list().some((a) => a.agentId === rec.agentId)).toBe(true);

    const tail = events.tail(rec.agentId, 50);
    const failedEvent = tail.find((e) => e.kind === "status" && e.data["state"] === "failed");
    expect(failedEvent).toBeDefined();
    expect(String(failedEvent?.data["error"])).toContain("effort change failed");
    expect(String(failedEvent?.data["error"])).toContain("credential");
  });

  it("the rejected error is the ORIGINAL failure (CredentialError), not a wrapped/generic one", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls++;
      return calls === 1 ? { stdout: "tok\n", code: 0 } : { stdout: "", code: 1 };
    };
    const { sup } = makeFlakySupervisor(exec);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "flaky" });
    await new Promise((r) => setTimeout(r, 20));

    let caught: unknown;
    await sup.setEffort(rec.agentId, "high").catch((e) => { caught = e; });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/credential/i);
  });

  it("respawn forced to throw a NON-Error value: the status event's error still stringifies it", async () => {
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/require-await
    const exec: ExecFn = async () => {
      calls++;
      if (calls === 1) return { stdout: "tok\n", code: 0 };
      throw "boom-non-error";   // deliberately not an Error instance
    };
    const { sup, events } = makeFlakySupervisor(exec);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "flaky" });
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.setEffort(rec.agentId, "high")).rejects.toBe("boom-non-error");

    const after = sup.status(rec.agentId);
    expect(after.state).toBe("failed");
    const tail = events.tail(rec.agentId, 50);
    const failedEvent = tail.find((e) => e.kind === "status" && e.data["state"] === "failed");
    expect(String(failedEvent?.data["error"])).toBe("effort change failed: boom-non-error");
  });

  it("preserves treeId/depth/spec on the restored failed record (same identity as before the failed respawn)", async () => {
    let calls = 0;
    const exec: ExecFn = async () => {
      calls++;
      return calls === 1 ? { stdout: "tok\n", code: 0 } : { stdout: "", code: 1 };
    };
    const { sup } = makeFlakySupervisor(exec);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", account: "flaky", conductor: true },
      { agentId: "cond-1", treeId: "tree-x", depth: 2 },
    );
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.setEffort("cond-1", "high")).rejects.toThrow();

    const after = sup.status("cond-1");
    expect(after.agentId).toBe("cond-1");
    expect(after.treeId).toBe("tree-x");
    expect(after.depth).toBe(2);
    expect(after.spec.conductor).toBe(true);
    expect(after.state).toBe("failed");
  });

  it("throws UnknownAgentError up-front for a ghost agentId — no record is fabricated", async () => {
    const { sup } = makeFlakySupervisor(async () => ({ stdout: "tok\n", code: 0 }));
    await expect(sup.setEffort("ghost-id", "high")).rejects.toMatchObject({ name: "UnknownAgentError" });
    expect(sup.list().some((a) => a.agentId === "ghost-id")).toBe(false);
  });
});
