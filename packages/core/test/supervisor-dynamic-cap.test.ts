import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema, DynamicCapConfigSchema, type DynamicCapConfig } from "@chimera/protocol";
import { GuardrailError } from "@chimera/core/supervisor";
import { DynamicCapTracker, type ResourceSample } from "@chimera/core/dynamic-cap";
import { makeSupervisor, CFG } from "./helpers.js";

// Roomier than helpers.CFG (maxAgentsTotal=2) so pressure/floor/ceiling are all
// distinguishable numbers in assertions below.
const ROOMY_CFG = ChimeraConfigSchema.parse({
  accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
  autoOrder: ["main"],
  caps: { maxAgentsTotal: 5, perAccount: {} },
});

const PARKED: import("@chimera/core/backends/fake").FakeStep[] = [{ awaitSend: true }, { end: { resultText: "-" } }];

function dynamicCfg(over: Partial<DynamicCapConfig> = {}): DynamicCapConfig {
  return DynamicCapConfigSchema.parse({ enabled: true, ...over });
}

describe("AgentSupervisor admission: DYNAMIC-CONCURRENCY-CAP", () => {
  it("refuses admission with the explanatory dynamic-cap message once the tracker signals pressure, without disturbing already-running agents", async () => {
    const HIGH_LOAD: ResourceSample = { load1: 20, cores: 12, freeMemGb: 30 };
    const tracker = new DynamicCapTracker(() => HIGH_LOAD);
    const cfg = dynamicCfg({ floor: 2 });
    for (let i = 0; i < 5; i++) tracker.sample(cfg);   // engage + settle the EWMA/latch below the ceiling

    const { sup } = makeSupervisor([PARKED, PARKED, PARKED], ROOMY_CFG, {
      dynamicCap: tracker, dynamicCapConfig: () => cfg,
    });

    const snapshotCap = tracker.effectiveCap(5, cfg).cap;
    expect(snapshotCap).toBeLessThan(5);   // sanity: pressure genuinely narrowed the operating point

    const spawned = [];
    for (let i = 0; i < snapshotCap; i++) {
      spawned.push(await sup.spawn({ prompt: `p${i}`, cwd: "/tmp", account: "main", isolation: "none" }));
    }
    for (const rec of spawned) expect(sup.status(rec.agentId).state).toBe("running");

    let err: unknown;
    try {
      await sup.spawn({ prompt: "over the dynamic cap", cwd: "/tmp", account: "main", isolation: "none" });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GuardrailError);
    expect((err as Error).message).toBe(`dynamic cap ${snapshotCap} of 5 reached (${tracker.effectiveCap(5, cfg).explain})`);
    expect((err as Error).message).toMatch(/^dynamic cap \d+ of 5 reached \(load [\d.]+\/12 cores, [\d.]+ GB free\)$/);

    // NEVER RETROACTIVE (ACCEPTANCE #2): the refusal above must not have touched any agent
    // that was already running before the cap narrowed.
    for (const rec of spawned) expect(sup.status(rec.agentId).state).toBe("running");
  });

  it("fails open to the static ceiling when the sampler throws — no admission is refused because monitoring broke", async () => {
    const tracker = new DynamicCapTracker(() => { throw new Error("os.loadavg unsupported"); });
    // A pathologically aggressive config that WOULD collapse the cap to floor=1 if the probe
    // were actually working — proving the fallback isn't just "a lenient config happened not
    // to trigger".
    const cfg = dynamicCfg({ floor: 1, cpuHighWatermark: 0.01, cpuLowWatermark: 0.005 });
    tracker.sample(cfg);   // throws internally, caught — marks healthy=false

    const { sup } = makeSupervisor([PARKED, PARKED, PARKED, PARKED], ROOMY_CFG, {
      dynamicCap: tracker, dynamicCapConfig: () => cfg,
    });

    // All 5 (the static ceiling) admit successfully despite the pressure-primed config.
    for (let i = 0; i < 5; i++) {
      const rec = await sup.spawn({ prompt: `p${i}`, cwd: "/tmp", account: "main", isolation: "none" });
      expect(rec.state).toBe("running");
    }
    await expect(sup.spawn({ prompt: "over the static ceiling", cwd: "/tmp", account: "main", isolation: "none" }))
      .rejects.toBeInstanceOf(GuardrailError);
  });

  it("an untouched config (no caps.dynamicCap, no tracker wired) enforces exactly the static maxAgentsTotal — no regression", async () => {
    const { sup } = makeSupervisor([PARKED, PARKED, PARKED], CFG);   // CFG: maxAgentsTotal=2, perAccount.main=1
    await sup.spawn({ prompt: "1", cwd: "/tmp", account: "main", isolation: "none" });
    await expect(sup.spawn({ prompt: "2", cwd: "/tmp", account: "main", isolation: "none" }))
      .rejects.toBeInstanceOf(GuardrailError);
    const err = await sup.spawn({ prompt: "3", cwd: "/tmp", account: "second", isolation: "none" });
    expect(err.state).toBe("running");
    await expect(sup.spawn({ prompt: "4", cwd: "/tmp", account: "second", isolation: "none" }))
      .rejects.toThrow(/^maxAgentsTotal 2 reached$/);
  });
});
