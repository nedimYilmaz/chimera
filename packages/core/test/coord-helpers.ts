import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { TeamManager } from "@chimera/core/teams";
import { QueueStore } from "@chimera/core/queues";
import { WorkflowStore } from "@chimera/core/workflows";
import { ArtifactStore } from "@chimera/core/artifacts";
import { QueueScheduler, type GateExecFn } from "@chimera/core/scheduler";
import { RoleStore } from "@chimera/core/roles-store";
import { fakeExec } from "./helpers.js";

export const COORD_CFG = ChimeraConfigSchema.parse({
  accounts: [
    { name: "main", provider: "claude", auth: { type: "subscription" } },
    { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
  ],
  autoOrder: ["main", "second"],
  caps: { maxAgentsTotal: 10, perAccount: {} },
});

export function makeCoordination(
  scenarios: FakeStep[][],
  cfg = COORD_CFG,
  opts: { cooldownMs?: number; retickDelayMs?: number; gateExec?: GateExecFn; handoffTimeoutMs?: number; gateEvalHardCeilingMs?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-coord-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(opts.cooldownMs ?? 60_000),
    permissionTimeoutMs: 100,
    questionTimeoutMs: 100,
  });
  const teams = new TeamManager(dir, events);
  const roles = new RoleStore(dir);
  const queues = new QueueStore(dir, events);
  const workflows = new WorkflowStore(dir, events);
  const artifacts = new ArtifactStore(dir, events);
  const scheduler = new QueueScheduler({
    teams, queues, supervisor: sup, events, workflows, artifacts, roles,
    ...(opts.retickDelayMs !== undefined ? { retickDelayMs: opts.retickDelayMs } : {}),
    ...(opts.gateExec !== undefined ? { gateExec: opts.gateExec } : {}),
    ...(opts.handoffTimeoutMs !== undefined ? { handoffTimeoutMs: opts.handoffTimeoutMs } : {}),
    ...(opts.gateEvalHardCeilingMs !== undefined ? { gateEvalHardCeilingMs: opts.gateEvalHardCeilingMs } : {}),
  });
  scheduler.attach();
  return { dir, fake, events, sup, teams, roles, queues, workflows, artifacts, scheduler };
}

export async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
