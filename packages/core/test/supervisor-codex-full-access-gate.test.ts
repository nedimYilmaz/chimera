import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { GuardrailError } from "@chimera/core/supervisor";
import { makeMultiProviderSupervisor } from "./helpers.js";

// CODEX-GATE-EXPOSURE: codex has no decidePermission hook, so permissionProfile "full" maps
// to sandboxMode "danger-full-access" with NO sandbox and NONE of chimera's own permission
// policies enforced. A codex spawn requesting "full" must be refused unless the caller
// explicitly names the risk — this is the guarantee added at supervisor.ts launch().
const HAPPY: FakeStep[] = [{ end: { resultText: "ok", costUsd: 0 } }];

describe("codex permissionProfile full access gate", () => {
  it("refuses a codex spawn with permissionProfile full and no acknowledgement", async () => {
    const { sup, codex } = makeMultiProviderSupervisor([], [HAPPY]);
    await expect(sup.spawn({
      prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex", permissionProfile: "full",
    })).rejects.toBeInstanceOf(GuardrailError);
    expect(codex.spawns.length).toBe(0);
  });

  it("allows a codex spawn with permissionProfile full when explicitly acknowledged", async () => {
    const { sup, codex } = makeMultiProviderSupervisor([], [HAPPY]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex", permissionProfile: "full",
      acknowledgeCodexFullAccessRisk: true,
    });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(codex.spawns.length).toBe(1);
  });

  it("an unaffected codex spawn (default acceptEdits) still works unchanged", async () => {
    const { sup, codex } = makeMultiProviderSupervisor([], [HAPPY]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(codex.spawns.length).toBe(1);
  });

  it("a claude spawn with permissionProfile full is unaffected by the codex-only gate", async () => {
    const { sup, claude } = makeMultiProviderSupervisor([HAPPY], []);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", provider: "claude", permissionProfile: "full" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(claude.spawns.length).toBe(1);
  });
});
