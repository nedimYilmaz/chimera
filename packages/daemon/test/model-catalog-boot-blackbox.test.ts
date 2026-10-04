import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";

// DYNAMIC-MODEL-METADATA (daemon boot wiring, gap 2): a deterministic full-boot blackbox — a REAL
// chimerad subprocess (CHIMERA_BACKEND=fake substitutes FakeAgentBackend per provider, mirrors
// effective-context-limit-blackbox.test.ts) driven only through the real RPC/ChimeraClient surface.
// Proves main.ts's boot actually constructs the Engine's ModelCatalogService against the live config
// and threads it through the supervisor: a claude agent pinned to a model known ONLY to config's
// `modelCatalog.overrides` gets its effectiveContextLimit from that override end-to-end, over the
// wire. (init()'s remote refresh is skipped under the fake backend — this asserts the observable
// override path, which never needs the network.)
//
// Provider choice is load-bearing, because neither provider's default lets the catalog show through:
//  - claude: L1-DEFAULT-THRESHOLD (F39) gives it a fleet-default compaction window that wins over
//    every model's native window, so this file writes the documented one-line rollback
//    (providerOverrides.claude.compactionThreshold: null -> the model's own window) to expose it.
//  - codex: since da6eed0f a Codex window is never derived from the shared API catalog — it is 0
//    (unknown) until the provider reports a session window — so the same override must NOT leak in.
//    The second test pins that negative end to end.

const BOOT_MODEL = "boot-wiring-omega";
const BOOT_WINDOW = 271_000;

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chimera-catalog-boot-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [
      { name: "cl", provider: "claude", auth: { type: "subscription" } },
      { name: "cx", provider: "codex", auth: { type: "subscription", homeDir: mkdtempSync(join(tmpdir(), "chimera-catalog-boot-cx-")) } },
    ],
    autoOrder: ["cl", "cx"],
    // explicit null (written into the BASE config.json — a config.d overlay would delete the key and
    // land back on the 120k default) = claude's native window, so the catalog override is observable.
    providerOverrides: { claude: { compactionThreshold: null } },
    modelCatalog: {
      overrides: { [BOOT_MODEL]: { contextWindow: BOOT_WINDOW } },
      // remote OFF so the fake-backend daemon never even considers a fetch.
      remote: { enabled: false, url: "https://example.test/catalog.json", ttlHours: 24 },
    },
  }));
  return home;
}

const home = makeHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("model-catalog boot wiring: daemon-level blackbox", () => {
  it("a claude agent pinned to an overrides-only model resolves effectiveContextLimit from config's modelCatalog.overrides", async () => {
    const client = await ChimeraClient.connect({ home, env });

    // The ctx-limit denominator is stamped SYNCHRONOUSLY inside launch(), which agent.spawn awaits —
    // the spawn response itself carries it, so no polling is needed.
    const spawned = await client.request<{ agentId: string; effectiveContextLimit?: number }>(
      "agent.spawn", { spec: { prompt: "hi", cwd: "/tmp", isolation: "none", model: BOOT_MODEL } });
    expect(spawned.effectiveContextLimit).toBe(BOOT_WINDOW);

    // Re-confirm via agent.status (the OTHER real read path a client uses for the same field).
    const status = await client.request<{ effectiveContextLimit?: number }>(
      "agent.status", { agentId: spawned.agentId });
    expect(status.effectiveContextLimit).toBe(BOOT_WINDOW);

    client.close();
  }, 20_000);

  it("the same overrides-only model does NOT become a codex window — codex stays unknown (0) until the provider reports one", async () => {
    const client = await ChimeraClient.connect({ home, env });

    const spawned = await client.request<{ agentId: string; effectiveContextLimit?: number }>(
      "agent.spawn", { spec: { prompt: "hi", cwd: "/tmp", isolation: "none", provider: "codex", model: BOOT_MODEL } });
    expect(spawned.effectiveContextLimit).toBe(0);

    const status = await client.request<{ effectiveContextLimit?: number }>(
      "agent.status", { agentId: spawned.agentId });
    expect(status.effectiveContextLimit).toBe(0);

    client.close();
  }, 20_000);
});
