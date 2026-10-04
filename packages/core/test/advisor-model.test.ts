import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { CFG, fakeExec } from "./helpers.js";

// ADVISOR-TOOL — the CLI carries a server-side advisor (a second, usually stronger model an agent
// can consult mid-task), offered ONLY when a model is configured for it. chimera never passed one,
// so no agent has ever had it.
//
// It resolves per SPAWN rather than fleet-wide because "who should this agent be able to ask" is a
// property of the work: a cheap worker draining a queue and a conductor choosing an architecture
// want different answers, or none. What is pinned here is that resolution order, including the one
// case that a `??` chain gets wrong if written carelessly — an explicit opt-out.

function makeSupervisor(advisorModel?: () => string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-advisor-"));
  const fake = new FakeAgentBackend([]);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    ...(advisorModel ? { advisorModel } : {}),
  } as never);
  return { sup, fake };
}

const spawn = async (sup: ReturnType<typeof makeSupervisor>["sup"], extra: Record<string, unknown> = {}) =>
  sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none", ...extra } as never);

describe("which advisor an agent gets", () => {
  it("gives none when nothing asks for one — the CLI's own default", () => {
    // Silence is not "use a default advisor": the tool costs a second model per consultation, so
    // it appears because someone asked, never because nobody objected.
    const { sup, fake } = makeSupervisor();
    return spawn(sup).then(() => {
      expect(fake.spawns[0]!.advisorModel).toBeUndefined();
    });
  });

  it("uses the daemon default when the spawn names none", async () => {
    const { sup, fake } = makeSupervisor(() => "claude-fable-5");
    await spawn(sup);
    expect(fake.spawns[0]!.advisorModel).toBe("claude-fable-5");
  });

  it("lets the SPAWN override the daemon default", async () => {
    const { sup, fake } = makeSupervisor(() => "claude-fable-5");
    await spawn(sup, { advisorModel: "claude-opus-5" });
    expect(fake.spawns[0]!.advisorModel).toBe("claude-opus-5");
  });

  it('treats an explicit "" as OPTING OUT, not as "unset"', async () => {
    // The case a `??` chain gets right and a `||` chain gets wrong. An operator who set a
    // fleet-wide advisor still needs a way to spawn one agent without it, and the empty string is
    // that way — so it must beat the default rather than fall through to it.
    const { sup, fake } = makeSupervisor(() => "claude-fable-5");
    await spawn(sup, { advisorModel: "" });
    expect(fake.spawns[0]!.advisorModel).toBe("");
  });

  it("passes the model through untouched — the CLI decides what it accepts", async () => {
    // "alias or full ID", per the flag's own help, and the CLI refuses a model that cannot advise.
    // Validating here would mean keeping a second list of advisor-capable models in sync with it.
    const { sup, fake } = makeSupervisor();
    await spawn(sup, { advisorModel: "fable" });
    expect(fake.spawns[0]!.advisorModel).toBe("fable");
  });
});

// COMPACTION-THRESHOLD-PER-AGENT — where an agent's context gets compacted, chosen per workload.
//
// It existed per ACCOUNT and per PROVIDER, never per agent, and unset it falls through to the
// model's native window: a 1M model compacts near 1M. Measured across ~47k model calls, cost is
// roughly turns x average context, so a conversation allowed to reach 900k pays for 900k on every
// remaining turn — the single largest lever in the whole audit.
describe("where an agent compacts", () => {
  it("inherits the measured fleet default when the spawn and the config both say nothing", async () => {
    const { sup, fake } = makeSupervisor();
    await spawn(sup);
    // L1-DEFAULT-THRESHOLD (F39): no account or provider override in this harness, so the last
    // rung answers and the resolved window reaches the backend — it is no longer left unstamped.
    expect(fake.spawns[0]!.compactionThreshold).toBe(120_000);
    expect(fake.spawns[0]!.compactionThresholdSource).toBe("default");
  });

  it("takes the SPAWN's own window", async () => {
    // 500k on a 1M model: the CLI fires at ~90% of the window, so compaction lands near 450k.
    const { sup, fake } = makeSupervisor();
    await spawn(sup, { compactionThreshold: 500_000 });
    expect(fake.spawns[0]!.compactionThreshold).toBe(500_000);
  });

  it("keeps the ctx meter's denominator and the real trigger in step", async () => {
    // The meter and the backend read ONE resolved value. If they were resolved separately, a
    // per-agent window would move the trigger and leave the meter measuring against the old one —
    // an agent shown at 30% while it is actually about to compact.
    const { sup, fake } = makeSupervisor();
    await spawn(sup, { compactionThreshold: 500_000 });
    const rec = sup.list().find((a) => a.agentId === fake.spawns[0]!.agentId);
    expect(rec?.effectiveContextLimit).toBe(500_000);
  });
});
