import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema, type ChimeraConfig, type DynamicCapConfig, type ModelMetadataLookup } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker, QuotaTracker, type CrashLoopPolicy } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import type { DynamicCapTracker } from "@chimera/core/dynamic-cap";
import type { AuditLedger } from "@chimera/core/audit-ledger";
import type { CapabilityBroker } from "@chimera/core/broker";
import type { runWorktreeSetup } from "@chimera/core/worktree-setup";
import type { WorktreeSetupHook } from "@chimera/protocol";

export const CFG = ChimeraConfigSchema.parse({
  accounts: [
    { name: "main", provider: "claude", auth: { type: "subscription" } },
    { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
  ],
  autoOrder: ["main", "second"],
  caps: { maxAgentsTotal: 2, perAccount: { main: 1 } },
});

export const fakeExec = async (cmd: string, args: string[]) =>
  [cmd, ...args].join(" ") === "security find-generic-password -s svc -w"
    ? { stdout: "tok-second\n", code: 0 } : { stdout: "", code: 1 };

export function makeSupervisor(
  scenarios: FakeStep[][],
  cfg = CFG,
  opts: {
    crashLoopPolicy?: CrashLoopPolicy;
    modelCatalog?: ModelMetadataLookup;
    auditLedger?: AuditLedger;
    cloudMutationGate?: () => "prompt" | "off";
    // DYNAMIC-CONCURRENCY-CAP: optional test seams, same "absent ⇒ byte-identical" shape as
    // every other opts field here.
    dynamicCap?: DynamicCapTracker;
    dynamicCapConfig?: () => DynamicCapConfig | undefined;
    // QUOTA-METER-WRONG-BY-100X: optional test seam, same "absent ⇒ byte-identical" shape as the
    // other opts below — lets a test drive holdUntilReset's authoritative-quota reconciliation.
    quotas?: QuotaTracker;
    // QUOTA-UNCOOL: optional seam for reconcileResetAt's freshness gate — same "absent ⇒
    // byte-identical" shape as every other opts field here.
    quotaFreshnessMs?: number;
    // F26: optional test seams for the fail-closed worktree setup hook — same "absent ⇒
    // byte-identical" shape as every other opts field here (no project ⇒ no hook ⇒ no-op).
    projectSetupHook?: (projectId: string) => WorktreeSetupHook | null;
    runSetupHook?: typeof runWorktreeSetup;
    // HOOK-5's watch/unwatch pairing is otherwise unobservable from this seam — a test that
    // asserts a refused spawn released its repo watch needs the spy injected here.
    repoWatcher?: { watch(repo: string, refId: string): void; unwatch(refId: string): void };
    // F22: the worktree-lease seams. Same "absent ⇒ byte-identical" shape as every other opts
    // field here — with no broker AND no mode the lease guard never even extracts write targets,
    // which is what keeps every pre-F22 supervisor test unchanged.
    capabilityBroker?: CapabilityBroker;
    worktreeLeases?: { acquire: (workdirKey: string, worktreeDir: string, agentId: string) => unknown };
    worktreeLeaseMode?: () => "enforce" | "warn" | "off";
    // F09 QA (item 3): optional test seam, same "absent ⇒ byte-identical" shape as every other
    // opts field here — lets a test arm PromptAckWatch's stall timer with a small window instead
    // of waiting out ChimeraConfigSchema.promptAck's real 45s default.
    promptStallMs?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const cooldowns = new CooldownTracker(60_000);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns,
    quotas: opts.quotas,
    quotaFreshnessMs: opts.quotaFreshnessMs,
    permissionTimeoutMs: 100,
    questionTimeoutMs: 100,
    // R2 (self-healing supervision): optional test seam (absent ⇒ DEFAULT_CRASH_LOOP_POLICY)
    // so a test can drive backend-crash-class recovery deterministically instead of waiting
    // on the multi-second production default.
    crashLoopPolicy: opts.crashLoopPolicy,
    // DYNAMIC-MODEL-METADATA: optional layered-catalog seam so a test can prove the ctx-limit
    // stamp resolves through an injected catalog (absent ⇒ hardcoded-map-only, byte-identical).
    modelCatalog: opts.modelCatalog,
    auditLedger: opts.auditLedger,
    cloudMutationGate: opts.cloudMutationGate,
    dynamicCap: opts.dynamicCap,
    dynamicCapConfig: opts.dynamicCapConfig,
    projectSetupHook: opts.projectSetupHook,
    runSetupHook: opts.runSetupHook,
    repoWatcher: opts.repoWatcher,
    capabilityBroker: opts.capabilityBroker,
    worktreeLeases: opts.worktreeLeases,
    worktreeLeaseMode: opts.worktreeLeaseMode,
    promptStallMs: opts.promptStallMs,
  });
  return { sup, fake, dir, events, cooldowns };
}

// used from Task 12 onward (engine/daemon/client/mcp suites)
export function makeEngineHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-home-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    // F01: `wake` defaults to ON, and Engine builds the REAL scheduler from it — which would make
    // every engine test that fires a job spawn a live power assertion, and every job.status read
    // shell out to a privileged probe. Off here; the seam has its own dedicated tests.
    wake: { holdAwakeDuringRuns: false, scheduleWake: false },
  }));
  return home;
}

// homeDir values are mkdtemp'd per-run: fixed shared /tmp paths would collide across the
// daemon/mcp/cli suites running in parallel, and the supervisor pre-creates homeDir dirs
// from Task 7 on — they must be isolated, disposable paths.
export const CLAUDE_HOME_B = mkdtempSync(join(tmpdir(), "chimera-claude-home-"));
export const CODEX_HOME_A = mkdtempSync(join(tmpdir(), "chimera-codex-home-"));

export const MULTI_CFG: ChimeraConfig = ChimeraConfigSchema.parse({
  accounts: [
    { name: "cl-main", provider: "claude", auth: { type: "subscription" } },
    { name: "cl-second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN", homeDir: CLAUDE_HOME_B } },
    { name: "cx-main", provider: "codex", auth: { type: "env", var: "CODEX_KEY_SRC", injectAs: "OPENAI_API_KEY", homeDir: CODEX_HOME_A } },
  ],
  autoOrder: ["cl-main", "cl-second", "cx-main"],
  caps: { maxAgentsTotal: 6, perAccount: {} },
});

export function makeMultiProviderSupervisor(
  claudeScenarios: FakeStep[][], codexScenarios: FakeStep[][], cfg: ChimeraConfig = MULTI_CFG,
  // Same "absent ⇒ byte-identical" catalog seam makeSupervisor already exposes. Needed here
  // because L1-DEFAULT-THRESHOLD (F39) gives claude a fleet-default compaction window that wins
  // over every model's native window, so a catalog lookup is only observable on codex.
  opts: { modelCatalog?: ModelMetadataLookup } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-msup-"));
  const claude = new FakeAgentBackend(claudeScenarios);
  const codex = new FakeAgentBackend(codexScenarios, "codex");
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(fakeExec, { CODEX_KEY_SRC: "sk-codex" } as NodeJS.ProcessEnv),
    backends: new Map([["claude", claude], ["codex", codex]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    modelCatalog: opts.modelCatalog,
  });
  return { sup, claude, codex, dir, events };
}

export function makeMultiProviderHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-mhome-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "cl", provider: "claude", auth: { type: "subscription" } },
      { name: "cx", provider: "codex", auth: { type: "subscription", homeDir: mkdtempSync(join(tmpdir(), "chimera-codex-cx-")) } },
    ],
    autoOrder: ["cl", "cx"],
  }));
  return home;
}
