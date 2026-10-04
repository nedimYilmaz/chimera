import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { makeSupervisor } from "./helpers.js";

// WS-OPT (model tiering): opus (the account default, model unset) is reserved for
// the depth-0 primary; every depth>0 spawn whose spec.model is unset is stamped
// with caps.subAgentModel so descendants run on the cheap model.
const HAPPY = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "ok", costUsd: 0 } }] as const;

// Same accounts/caps as the shared CFG, plus a configured cheap sub-agent model.
const TIER_CFG = ChimeraConfigSchema.parse({
  accounts: [
    { name: "main", provider: "claude", auth: { type: "subscription" } },
    { name: "second", provider: "claude", auth: { type: "keychain", service: "svc", injectAs: "ANTHROPIC_AUTH_TOKEN" } },
  ],
  autoOrder: ["main", "second"],
  caps: { maxAgentsTotal: 4, perAccount: {}, subAgentModel: "claude-sonnet-5" },
});

describe("AgentSupervisor model tiering (WS-OPT)", () => {
  it("stamps the cheap model on a depth>0 spawn whose model is unset", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], TIER_CFG);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { depth: 1 });
    expect(fake.spawns[0]!.model).toBe("claude-sonnet-5");
  });

  it("never downgrades the depth-0 primary", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], TIER_CFG);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { depth: 0 });
    expect(fake.spawns[0]!.model).toBeUndefined();
  });

  it("never overrides an explicit spec.model, even at depth>0", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], TIER_CFG);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", model: "claude-opus-4-8" }, { depth: 1 });
    expect(fake.spawns[0]!.model).toBe("claude-opus-4-8");
  });

  it("uses a presence check, not truthiness: an explicit empty-string model is not overridden", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], TIER_CFG);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", model: "" }, { depth: 1 });
    expect(fake.spawns[0]!.model).toBe("");
  });

  it("is a no-op when caps.subAgentModel is unconfigured (byte-identical behavior)", async () => {
    // makeSupervisor's default CFG has no subAgentModel — a depth>0 spawn stays unset.
    const { sup, fake } = makeSupervisor([HAPPY]);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { depth: 1 });
    expect(fake.spawns[0]!.model).toBeUndefined();
  });

  // R2 EFFORT: the tiering block only ever touches spec.model — effort must pass through
  // completely untouched, whether or not model tiering fires on the same spawn.
  it("leaves an explicit spec.effort untouched at depth>0 (effort is orthogonal to model tiering)", async () => {
    const { sup, fake } = makeSupervisor([HAPPY], TIER_CFG);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", effort: "high" }, { depth: 1 });
    expect(fake.spawns[0]!.model).toBe("claude-sonnet-5");   // tiering still applies to model
    expect(fake.spawns[0]!.effort).toBe("high");             // effort is untouched
  });
});
