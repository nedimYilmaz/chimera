import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor, GuardrailError } from "@chimera/core/supervisor";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { CodexAgentBackend, type CodexFactory, type CodexThreadEvent } from "@chimera/core/backends/codex";
import { fakeExec, makeMultiProviderSupervisor, MULTI_CFG } from "./helpers.js";

const RATE_FAIL: FakeStep[] = [{ fail: { message: "HTTP 429 Too Many Requests" } }];
const HAPPY: FakeStep[] = [{ end: { resultText: "recovered", costUsd: 0 } }];

describe("AgentSupervisor cross-provider failover", () => {
  it("honors an opt-in provider preference but explicit requests win", async () => {
    const { sup } = makeMultiProviderSupervisor([HAPPY], [HAPPY], { ...MULTI_CFG, preferredProvider: "codex" });
    const automatic = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    expect((await sup.waitFor(automatic.agentId, 1000)).accountName).toBe("cx-main");
    const explicit = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "claude" });
    expect((await sup.waitFor(explicit.agentId, 1000)).accountName).toBe("cl-main");
  });

  it("default: failover exhausts the anchor provider and never crosses (spec §7)", async () => {
    // autoOrder = [cl-main, cl-second, cx-main]; both claude accounts 429 → agent fails, codex untouched
    const { sup, claude, codex } = makeMultiProviderSupervisor([RATE_FAIL, RATE_FAIL], [HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");
    expect(final.attempts.map((a) => a.account)).toEqual(["cl-main", "cl-second"]);
    expect(claude.spawns.length).toBe(2);
    expect(codex.spawns.length).toBe(0);
  });

  it("crossProviderFailover:true walks across providers and finishes on codex", async () => {
    const { sup, codex, events } = makeMultiProviderSupervisor([RATE_FAIL, RATE_FAIL], [HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", crossProviderFailover: true });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("recovered");
    expect(final.provider).toBe("codex");
    expect(final.attempts.map((a) => a.account)).toEqual(["cl-main", "cl-second", "cx-main"]);
    expect(codex.spawns[0]!.env["OPENAI_API_KEY"]).toBe("sk-codex");
    const crossing = events.tail(rec.agentId, 50)
      .filter((e) => e.kind === "failover")
      .map((e) => [e.data["fromProvider"], e.data["toProvider"]]);
    expect(crossing).toEqual([["claude", "claude"], ["claude", "codex"]]);
  });

  it("spec.provider filters auto-routing to that provider only", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([], [HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.accountName).toBe("cx-main");
    expect(claude.spawns.length).toBe(0);
    expect(codex.spawns.length).toBe(1);
  });

  it("explicit account with a mismatched provider fails loudly", async () => {
    const { sup } = makeMultiProviderSupervisor([], []);
    await expect(sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "cl-main", provider: "codex" }))
      .rejects.toBeInstanceOf(GuardrailError);
  });

  // Branch coverage: `spec.provider !== undefined && acct.provider !== spec.provider` is a
  // compound guard. The mismatch test above exercises it TRUE; this exercises the OTHER way
  // the guard is FALSE — spec.provider IS set (not the "undefined" short-circuit) but it agrees
  // with the explicit account's own provider, so routing must succeed, not throw.
  it("explicit account with a MATCHING spec.provider routes normally (no throw)", async () => {
    const { sup, claude } = makeMultiProviderSupervisor([HAPPY], []);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "cl-main", provider: "claude" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.accountName).toBe("cl-main");
    expect(claude.spawns.length).toBe(1);
  });

  it("anchor provider is stable: a cooling first account routes to its provider sibling, not across", async () => {
    // spawn 1: cl-main 429 → cl-second done (stamps cooldown on cl-main)
    // spawn 2 (fresh, default): cl-main cooling → must pick cl-second (claude), never cx-main
    const { sup, claude, codex } = makeMultiProviderSupervisor([RATE_FAIL, HAPPY, HAPPY], [HAPPY]);
    const r1 = await sup.spawn({ prompt: "1", cwd: "/tmp", isolation: "none" });
    await sup.waitFor(r1.agentId, 1000);
    const r2 = await sup.spawn({ prompt: "2", cwd: "/tmp", isolation: "none" });
    await sup.waitFor(r2.agentId, 1000);
    expect(claude.spawns.map((s) => s.accountName)).toEqual(["cl-main", "cl-second", "cl-second"]);
    expect(codex.spawns.length).toBe(0);
  });
});

// One failover test through the REAL CodexAgentBackend seam (not FakeAgentBackend): proves the
// architecture claim that Phase 1 classifyError patterns match codex quota phrasing end-to-end.
function scriptedCodexFactory(scripts: CodexThreadEvent[][]): CodexFactory {
  let i = 0;
  return () => ({
    startThread: () => ({
      id: `th-${i}`,
      runStreamed: async () => {
        const script = scripts[i++] ?? [];
        return { events: (async function* () { for (const e of script) yield e; })() };
      },
    }),
    resumeThread(_id, options) { return this.startThread(options); },
  });
}

describe("supervisor failover through the CodexAgentBackend seam", () => {
  it("quota turn.failed on codex account 1 fails over to codex account 2 and reaches done", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "cx-a", provider: "codex", auth: { type: "env", var: "CODEX_KEY_SRC", injectAs: "OPENAI_API_KEY" } },
        { name: "cx-b", provider: "codex", auth: { type: "env", var: "CODEX_KEY_SRC", injectAs: "CODEX_API_KEY" } },
      ],
      autoOrder: ["cx-a", "cx-b"],
      caps: { maxAgentsTotal: 6, perAccount: {} },
    });
    const dir = mkdtempSync(join(tmpdir(), "chimera-cxseam-"));
    const events = new EventLog(dir);
    const backend = new CodexAgentBackend({
      codexFactory: scriptedCodexFactory([
        [{ type: "turn.failed", error: { message: "UsageLimitExceeded: usage limit reached" } }],
        [
          { type: "item.completed", item: { id: "a", type: "agent_message", text: "recovered on cx-b" } },
          { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
        ],
      ]),
    });
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(cfg),
      credentials: new CredentialResolver(fakeExec, { CODEX_KEY_SRC: "sk-codex" } as NodeJS.ProcessEnv),
      backends: new Map([["codex", backend]]),
      events,
      mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000),
      permissionTimeoutMs: 100,
    });
    // Exercise the injected SDK seam explicitly; restricted agents otherwise use
    // the interactive app-server transport, not this scripted factory.
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", providerOptions: { codexTransport: "exec" }, on: { permissionRequest: "poke:caller" } });
    const final = await sup.waitFor(rec.agentId, 2000);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("recovered on cx-b");
    expect(final.attempts.map((a) => a.account)).toEqual(["cx-a", "cx-b"]);
    const crossings = events.tail(rec.agentId, 50)
      .filter((e) => e.kind === "failover")
      .map((e) => [e.data["fromProvider"], e.data["toProvider"]]);
    expect(crossings).toEqual([["codex", "codex"]]);   // classifyError matched codex quota text — no classifier change
  });
});
