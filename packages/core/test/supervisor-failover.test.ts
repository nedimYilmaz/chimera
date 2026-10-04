import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema, AgentSpecSchema, type AgentSpec, type ChimeraConfig } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { GuardrailError, AgentSupervisor } from "@chimera/core/supervisor";
import { makeSupervisor, fakeExec } from "./helpers.js";

// Local rig (not the shared `makeSupervisor`, whose backends map is fixed to
// a single "claude" entry): a genuine crossProviderFailover dispatch needs a
// backend actually registered under the REROUTED account's provider key too,
// so this exercises real multi-backend dispatch instead of accidentally
// passing because everything resolves through the one "claude" fake.
function makeCrossProviderSupervisor(claudeScenarios: FakeStep[][], codexScenarios: FakeStep[][], cfg: ChimeraConfig) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-cpf-"));
  // DISTINCT fake per provider key: this is what makes a cross-provider reroute
  // observable — dispatching through the wrong provider's backend lands the spawn
  // on the wrong fake, so record.provider reassignment is a true regression guard.
  const claudeFake = new FakeAgentBackend(claudeScenarios);
  const codexFake = new FakeAgentBackend(codexScenarios);
  const cooldowns = new CooldownTracker(60_000);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", claudeFake], ["codex", codexFake]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns,
  });
  return { sup, claudeFake, codexFake, dir, cooldowns };
}

const RATE_FAIL: FakeStep[] = [{ fail: { message: "HTTP 429 Too Many Requests" } }];
const HAPPY: FakeStep[] = [{ end: { resultText: "recovered", costUsd: 0.02 } }];
const CRED_FAIL: FakeStep[] = [{ fail: { message: "401 Unauthorized: invalid api key" } }];

describe("AgentSupervisor failover", () => {
  it("auto account fails over to the next account and finishes there", async () => {
    const { sup, fake, dir } = makeSupervisor([RATE_FAIL, HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });      // auto → main first
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("recovered");
    expect(final.attempts.map((a) => a.account)).toEqual(["main", "second"]);
    expect(final.attempts[0]!.errorClass).toBe("rate-limit");
    expect(fake.spawns.map((s) => s.accountName)).toEqual(["main", "second"]);
    expect(fake.spawns[1]!.env["ANTHROPIC_AUTH_TOKEN"]).toBe("tok-second");            // re-resolved for new account
    // spec §6: resolved credential values never reach the event log
    expect(readFileSync(join(dir, "events", "events.jsonl"), "utf8")).not.toContain("tok-second");
  });

  it("does not hop providers unless crossProviderFailover is set", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "cx", provider: "codex", auth: { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" } },
      ],
      autoOrder: ["main", "cx"],
    });
    const { sup, fake } = makeSupervisor([RATE_FAIL], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");                    // cx is codex → filtered out, no silent provider hop
    expect(fake.spawns.length).toBe(1);
  });

  it("emits a failover event", async () => {
    const { sup, dir } = makeSupervisor([RATE_FAIL, HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    const { EventLog } = await import("@chimera/core/events");
    const evs = new EventLog(dir).tail(rec.agentId, 50);
    const fo = evs.find((e) => e.kind === "failover");
    expect(fo?.data).toMatchObject({ from: "main", to: "second" });
    expect(fo?.data["reason"]).toContain("429");
  });

  it("explicitly named accounts fail loudly, no silent switch", async () => {
    const { sup, fake } = makeSupervisor([RATE_FAIL, HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");
    expect(fake.spawns.length).toBe(1);
  });

  it("marks failed when every account is cooling", async () => {
    const { sup } = makeSupervisor([RATE_FAIL, RATE_FAIL]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");
    expect(final.attempts.length).toBe(2);
  });
});

// ---------- additional coverage: branches/edges beyond the brief's examples ----------

describe("AgentSupervisor failover: error-class branch (non-rate-limit on an auto account)", () => {
  it("does NOT fail over for a non-rate-limit error class even when account is auto", async () => {
    const { sup, fake } = makeSupervisor([CRED_FAIL, HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }); // auto
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");
    expect(final.attempts.length).toBe(1);
    expect(final.attempts[0]!.errorClass).toBe("credential");
    expect(fake.spawns.length).toBe(1);        // no failover spawn attempted
  });
});

describe("AgentSupervisor failover: cooldown fall-through (launch() rejecting after reroute)", () => {
  it("publishes a terminal event on rerouted-launch failure so a pending waitFor resolves (not hangs)", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        // deliberately-unset env var: credential resolution on the rerouted
        // account throws inside launch(), exercising the onError .catch fallback
        { name: "second", provider: "claude", auth: { type: "env", var: "CHIMERA_TEST_UNSET_VAR_9", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
      ],
      autoOrder: ["main", "second"],
    });
    const { sup } = makeSupervisor([RATE_FAIL], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    // the rerouted launch() rejects (unset env credential). The onError .catch now
    // appends a terminal status event, so an event-driven waitFor() resolves as
    // "failed" instead of hanging until timeout (would time out before the fix).
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("failed");
    // the failed reroute attempt never got appended (credential resolve threw
    // before attempts.push in launch())
    expect(final.attempts.length).toBe(1);
  });
});

describe("AgentSupervisor failover: reason redaction (spec §6)", () => {
  it("scrubs a resolved credential value out of the failover event's own 'reason' field", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        // "second" (with a resolvable secret) goes FIRST so the failing
        // attempt's own token is the one embedded in the raw error text
        { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
        { name: "main", provider: "claude", auth: { type: "subscription" } },
      ],
      autoOrder: ["second", "main"],
    });
    const RATE_FAIL_WITH_TOKEN: FakeStep[] = [{ fail: { message: "HTTP 429 Too Many Requests: token=tok-second" } }];
    const { sup, dir } = makeSupervisor([RATE_FAIL_WITH_TOKEN, HAPPY], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    const { EventLog } = await import("@chimera/core/events");
    const evs = new EventLog(dir).tail(rec.agentId, 50);
    const fo = evs.find((e) => e.kind === "failover");
    expect(fo?.data["reason"]).toBe("HTTP 429 Too Many Requests: token=[REDACTED]");
    expect(fo?.data["reason"]).not.toContain("tok-second");
    expect(readFileSync(join(dir, "events", "events.jsonl"), "utf8")).not.toContain("tok-second");
  });
});

describe("AgentSupervisor failover: crossProviderFailover escape hatch", () => {
  // P4.8: routeAccount dropped its Phase-1 `requiredProvider?` param — the
  // anchor provider is now computed internally from autoOrder[0] (BEFORE
  // cooldown filtering), so these two tests cool the anchor account directly
  // to force a genuine same-provider-vs-cross-provider choice between "cx"
  // (codex, order[0] ⇒ the anchor) and "main" (claude).
  it("routeAccount (protected) crosses to a different-provider autoOrder account when spec.crossProviderFailover is true", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "cx", provider: "codex", auth: { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" } },
        { name: "main", provider: "claude", auth: { type: "subscription" } },
      ],
      autoOrder: ["cx", "main"],   // anchor = codex (order[0]) when spec.provider is unset
    });
    const { sup, cooldowns } = makeCrossProviderSupervisor([], [], cfg);
    cooldowns.stamp("cx");   // anchor account cooling: only crossProviderFailover:true can still reach "main"
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", crossProviderFailover: true });
    const name = (sup as unknown as { routeAccount(s: AgentSpec): string }).routeAccount(spec);
    expect(name).toBe("main");
  });

  it("routeAccount (protected) still filters a mismatched-provider account when crossProviderFailover is false (default)", () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "cx", provider: "codex", auth: { type: "env", var: "OPENAI_API_KEY", injectAs: "OPENAI_API_KEY" } },
        { name: "main", provider: "claude", auth: { type: "subscription" } },
      ],
      autoOrder: ["cx", "main"],   // anchor = codex (order[0]) when spec.provider is unset
    });
    const { sup, cooldowns } = makeCrossProviderSupervisor([], [], cfg);
    cooldowns.stamp("cx");   // anchor account cooling; "main" (a different provider) must stay filtered out
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp" }); // crossProviderFailover defaults false
    expect(() => (sup as unknown as { routeAccount(s: AgentSpec): string })
      .routeAccount(spec)).toThrow(GuardrailError);
  });

  it("end-to-end: crossProviderFailover:true on the spec lets an auto failover actually land on a different-provider account", async () => {
    const cfg = ChimeraConfigSchema.parse({
      accounts: [
        { name: "main", provider: "claude", auth: { type: "subscription" } },
        { name: "cx", provider: "codex", auth: { type: "subscription" } },
      ],
      autoOrder: ["main", "cx"],
    });
    // main(claude) gets the rate-limit; the reroute to cx(codex) must dispatch
    // through the CODEX backend — proving onError reassigned record.provider.
    const { sup, claudeFake, codexFake } = makeCrossProviderSupervisor([RATE_FAIL], [HAPPY], cfg);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", crossProviderFailover: true });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.provider).toBe("codex");                                  // record.provider reassigned on reroute
    expect(final.attempts.map((a) => a.account)).toEqual(["main", "cx"]);
    expect(claudeFake.spawns.map((s) => s.accountName)).toEqual(["main"]); // first attempt via the claude backend
    expect(codexFake.spawns.map((s) => s.accountName)).toEqual(["cx"]);    // reroute dispatched via the codex backend
  });
});
