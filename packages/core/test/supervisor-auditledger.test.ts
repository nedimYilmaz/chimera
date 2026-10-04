import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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
import { AuditLedger } from "@chimera/core/audit-ledger";

// A keychain-backed account so `launch()` actually resolves a credential — CFG's stock "main"
// account (helpers.ts) is auth:"subscription", which resolves to null and never exercises the
// credential_resolution ledger path. Mirrors helpers.ts's "second" account shape.
const SECRET = "tok-super-secret-value";
const CFG = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } }],
  autoOrder: ["main"],
  caps: { maxAgentsTotal: 2, perAccount: { main: 1 } },
});
const fakeExec = async (cmd: string, args: string[]) =>
  [cmd, ...args].join(" ") === "security find-generic-password -s svc -w"
    ? { stdout: `${SECRET}\n`, code: 0 } : { stdout: "", code: 1 };

function makeSupervisorWithLedger(scenarios: FakeStep[][], opts?: { isGitRepo?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-auditsup-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const auditLedger = new AuditLedger(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    auditLedger,
    isGitRepo: async () => opts?.isGitRepo ?? false,
  });
  return { sup, events, auditLedger, dir };
}

const FULL_AUTO = {
  prompt: "x", cwd: "/tmp/some-repo", account: "main", isolation: "none",
  permissionProfile: "full", on: { permissionRequest: "auto" },
} as const;

const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });

function rawLedgerText(dir: string): string {
  return readFileSync(join(dir, "audit", "ledger.jsonl"), "utf8");
}

describe("AgentSupervisor + AuditLedger integration", () => {
  it("appends a credential_resolution record on launch, with provider/envVar but never the secret value", async () => {
    const { sup, auditLedger, dir } = makeSupervisorWithLedger([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);

    const result = auditLedger.verify();
    expect(result.ok).toBe(true);
    const records = rawLedgerText(dir).trim().split("\n").map((l) => JSON.parse(l));
    const credRecord = records.find((r) => r.action === "credential_resolution");
    expect(credRecord).toMatchObject({
      agentId: rec.agentId, resource: "main", decision: "recorded",
      detail: { provider: "claude", envVar: "ANTHROPIC_AUTH_TOKEN" },
    });
    expect(rawLedgerText(dir)).not.toContain(SECRET);
  });

  it("appends a destructive_bash_checkpoint record when a destructive command is detected, independent of isGitRepo", async () => {
    const { sup, auditLedger, dir } = makeSupervisorWithLedger(
      [[bash("rm -rf /tmp/some-repo/build"), { end: { resultText: "done" } }]],
      { isGitRepo: false },
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);

    const records = rawLedgerText(dir).trim().split("\n").map((l) => JSON.parse(l));
    const destructive = records.find((r) => r.action === "destructive_bash_checkpoint");
    expect(destructive).toMatchObject({
      agentId: rec.agentId, resource: "/tmp/some-repo", decision: "recorded",
      detail: { command: "rm -rf /tmp/some-repo/build", isGitRepo: false },
    });
    void dir;
  });

  it("redacts a registered secret embedded in a Bash command before it reaches the ledger", async () => {
    const { sup, auditLedger, dir } = makeSupervisorWithLedger(
      [[bash(`rm -rf /tmp && echo ${SECRET}`), { end: { resultText: "done" } }]],
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    void rec;

    // the secret was registered (via credential_resolution's launch()) BEFORE this Bash call
    // ran, so redact() should have scrubbed it out of the destructive-bash command detail too.
    expect(rawLedgerText(dir)).not.toContain(SECRET);
    expect(auditLedger.verify().ok).toBe(true);
    void dir;
  });

  it("host_tool capability_decision records reach the ledger via decidePermission, not just events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-auditsup-cap-"));
    const fake = new FakeAgentBackend([[bash("git status"), { end: { resultText: "d" } }]]);
    const events = new EventLog(dir);
    const auditLedger = new AuditLedger(dir);
    // A minimal broker wired directly to the ledger, mirroring engine.ts's dual-write closure —
    // supervisor-toolpolicy.test.ts already covers the EventLog side of this seam; this proves
    // the SAME emit closure shape also reaches the ledger when engine.ts wires it that way.
    const { CapabilityBroker } = await import("@chimera/core/broker");
    const capabilityBroker = new CapabilityBroker(
      () => "allow",
      (event) => {
        events.append({ agentId: event.principal ?? "capability", kind: "capability_decision", data: event as unknown as Record<string, unknown> });
        auditLedger.append({
          agentId: event.principal, action: event.action, resource: event.resource,
          decision: event.decision, reason: event.reason,
          detail: { tool: event.tool, profile: event.profile, command: event.command },
        });
      },
    );
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(CFG),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake]]),
      events,
      mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000),
      permissionTimeoutMs: 100,
      capabilityBroker,
      auditLedger,
    });
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);

    const records = rawLedgerText(dir).trim().split("\n").map((l) => JSON.parse(l));
    expect(records.some((r) => r.action === "host_tool" && r.resource === "git" && r.decision === "allow")).toBe(true);
    expect(auditLedger.verify().ok).toBe(true);
  });
});
