import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver, type ExecFn } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { TeamManager } from "@chimera/core/teams";
import { RoleStore } from "@chimera/core/roles-store";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { ArtifactStore } from "@chimera/core/artifacts";
import { QueueScheduler } from "@chimera/core/scheduler";
import { waitUntil } from "./coord-helpers.js";

// F08.QA-FIX item 1: queues.ts's poison check (markFailedAttempt's retryableClasses gate) was
// structurally blind for every markFailed call site except the one onError feeds, because
// onError was the ONLY place that ever stamped att.errorClass before scheduler.ts's settle()
// read it back off rec.attempts[last]. setAccount's respawn-failure catch (supervisor.ts,
// ~line 4267) is one of ~8 other real, non-onError terminal paths: it snapshots the agent's
// record BEFORE kill+respawn, and if the respawn's credential resolve throws, it builds
// failedRecord straight from that pre-kill snapshot (never touched by onError, since this
// agent never errored) and calls markFailed directly. Before N1's fix, that terminal attempt's
// errorClass stayed undefined forever, so markFailedAttempt's poison gate could never fire —
// a task that should dead-letter on a credential misconfiguration would instead sit
// retried/parked with no visible reason. This test drives that exact path end to end through a
// live QueueScheduler + QueueStore rig (not a hand-built attempts[] array) and asserts the task
// reaches dead_letter, proving the fix (not onError) is what stamped errorClass here.

const RUNNING: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "never", costUsd: 0 } }];

function makeRig(exec: ExecFn) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-poison-real-path-"));
  // "main" launches the task's agent with no credential involved (subscription auth).
  // "flaky" is a same-provider account setAccount can switch to; its keychain `service` name
  // flows verbatim into CredentialError's message ("keychain lookup failed for service
  // ${service}"), so embedding a CRED signal phrase here is what lets the respawn failure's
  // otherwise-uncontrollable error text classify to a concrete "credential" errorClass instead
  // of falling through to "unclassified"/"unknown".
  const cfg = ChimeraConfigSchema.parse({
    accounts: [
      { name: "main", provider: "claude", auth: { type: "subscription" } },
      { name: "flaky", provider: "claude", auth: { type: "keychain", service: "invalid api key", injectAs: "ANTHROPIC_API_KEY" } },
    ],
    autoOrder: ["main"],
  });
  const fake = new FakeAgentBackend([RUNNING]);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(exec),
    backends: new Map([["claude", fake]]),
    events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
  });
  const teams = new TeamManager(dir, events);
  const roles = new RoleStore(dir);
  const queues = new QueueStore(dir, events);
  const workflows = new WorkflowStore(dir, events);
  const artifacts = new ArtifactStore(dir, events);
  const scheduler = new QueueScheduler({ teams, queues, supervisor: sup, events, workflows, artifacts, roles });
  scheduler.attach();
  return { dir, sup, teams, queues, scheduler };
}

describe("F08.QA-FIX item 1: a real (non-onError) markFailed path stamps errorClass and flips poisoned", () => {
  it("setAccount's respawn credential failure on a healthy agent dead-letters the task on the first attempt", async () => {
    // "main" needs no exec call (subscription auth); the account switch to "flaky" is the only
    // keychain lookup this test ever performs, and it always fails.
    const exec: ExecFn = async () => ({ stdout: "", code: 1 });
    const rig = makeRig(exec);
    rig.queues.create({ name: "work", retryLimit: 5, retryPolicy: { maxAttempts: 5, retryableClasses: ["backend-crash"] } });
    rig.teams.create({ name: "crew", roles: { dev: { role: "blank", overrides: { cwd: "/tmp", account: "main", isolation: "none" } } }, maxConcurrent: 1, queue: "work" });
    const t = rig.queues.push("work", { prompt: "victim" });
    await rig.scheduler.tick();
    const [agentId] = rig.scheduler.agentsFor("crew");
    await waitUntil(() => rig.sup.status(agentId!).state === "running", 8_000);

    // Never touched by onError — this agent has had exactly one attempt, running cleanly, so
    // its last attempt's errorClass is undefined at the moment of the switch.
    expect(rig.sup.status(agentId!).attempts.at(-1)?.errorClass).toBeUndefined();

    await expect(rig.sup.setAccount(agentId!, "flaky")).rejects.toThrow();

    await waitUntil(() => rig.sup.status(agentId!).state === "failed", 8_000);
    await rig.scheduler.tick();

    await waitUntil(() => rig.queues.status("work").counts.dead_letter === 1, 8_000);
    const task = rig.queues.status("work").tasks.find((x) => x.taskId === t.taskId)!;
    expect(task.state).toBe("dead_letter");
    expect(rig.sup.status(agentId!).attempts.at(-1)?.errorClass).toBe("credential");
  });
});
