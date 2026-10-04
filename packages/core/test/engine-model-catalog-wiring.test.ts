import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { FakeAccountProber } from "@chimera/core/prober";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { ModelCatalogService } from "@chimera/core/providers/model-catalog";
import type { AgentBackend } from "@chimera/core/backend";
import type { BuildBackendsDeps } from "@chimera/core/providers/registry";
import type { ProviderProfile, ModelMetadataLookup } from "@chimera/protocol";

// DYNAMIC-MODEL-METADATA (engine wiring, gap 1): the Engine constructs ONE ModelCatalogService,
// exposes it via `get modelCatalog()`, reads config's `modelCatalog.overrides` live through it,
// and forwards that SAME instance into (a) the supervisor's deps (ctx-limit stamp) and (b) the
// backendBuildDeps a live hot-reload build receives. The service's own layered-resolution behavior
// is covered in model-catalog.test.ts; this file pins only that the Engine actually wires it in.

// A non-hardcoded model pinned to a context window via config override — proves resolution flows
// through the engine's catalog service, not protocol's hardcoded map (which has no such model).
const WIRING_MODEL = "wiring-omega-model";
const WIRING_WINDOW = 321_000;

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chm-catalog-wiring-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    // Codex must use its own session telemetry even when the shared API catalog
    // contains a plausible capacity for the selected model.
    accounts: [{ name: "main", provider: "codex", auth: { type: "subscription", homeDir: mkdtempSync(join(tmpdir(), "chm-catalog-wiring-cx-")) } }],
    autoOrder: ["main"],
    // remote fetch OFF so nothing touches the network; overrides (layer 1) still resolve.
    modelCatalog: {
      overrides: { [WIRING_MODEL]: { contextWindow: WIRING_WINDOW } },
      remote: { enabled: false, url: "https://example.test/catalog.json", ttlHours: 24 },
    },
  }, null, 2));
  return home;
}

// A fake builder standing in for the real buildBackends — captures the deps the engine hands it on
// a live reconcile so the test can prove `modelCatalog` is threaded through (mirrors the fake in
// engine-hotreload-backends.test.ts, plus a modelCatalog capture).
function fakeBuilder() {
  const seen: Array<{ providers: string[]; modelCatalog?: () => ModelMetadataLookup | undefined }> = [];
  const builder = async (_catalog: ProviderProfile[], deps: BuildBackendsDeps) => {
    seen.push({ providers: deps.providers ?? [], modelCatalog: deps.modelCatalog });
    const built = new Map<string, AgentBackend>();
    for (const p of deps.providers ?? []) built.set(p, new FakeAgentBackend([], p));
    return built;
  };
  return { builder, seen };
}

function makeEngine(home: string, backendBuilder: ReturnType<typeof fakeBuilder>["builder"]) {
  const backends = new Map<string, AgentBackend>([
    ["codex", new FakeAgentBackend([[{ awaitSend: true }]], "codex")],
  ]);
  return new Engine({
    home, backends,
    keychain: new InMemoryKeychain(),
    accountProber: new FakeAccountProber("ok"),
    backendBuilder,
  });
}

describe("Engine: model-catalog service wiring", () => {
  it("exposes the constructed ModelCatalogService via get modelCatalog()", () => {
    const { builder } = fakeBuilder();
    const engine = makeEngine(makeHome(), builder);
    expect(engine.modelCatalog).toBeInstanceOf(ModelCatalogService);
  });

  it("the exposed service reads config's modelCatalog.overrides (layer 1) live", () => {
    const { builder } = fakeBuilder();
    const engine = makeEngine(makeHome(), builder);
    // The `() => this.cfg.modelCatalog` accessor means the override resolves with no network.
    expect(engine.modelCatalog.contextWindow(WIRING_MODEL)).toBe(WIRING_WINDOW);
    // A model in neither the overrides nor the (disabled) remote misses every service layer.
    expect(engine.modelCatalog.contextWindow("no-such-wiring-model")).toBeUndefined();
  });

  it("does not use an API catalog override as a Codex session capacity", async () => {
    const { builder } = fakeBuilder();
    const engine = makeEngine(makeHome(), builder);
    // Catalog availability does not establish a Codex session's active window.
    const rec = await engine.handle("agent.spawn", {
      spec: { prompt: "hi", cwd: "/tmp", isolation: "none", account: "main", model: WIRING_MODEL },
    }) as { agentId: string; effectiveContextLimit?: number };
    expect(rec.effectiveContextLimit).toBe(0);
  });

  it("forwards the SAME service instance into the backendBuildDeps a live reconcile uses", async () => {
    const { builder, seen } = fakeBuilder();
    const engine = makeEngine(makeHome(), builder);

    // Adding a new provider drives doReconcileBackends, which calls the (fake) builder with the
    // engine's backendBuildDeps — including its modelCatalog accessor.
    await engine.handle("accounts.add", { name: "grok", provider: "xai" });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

    const built = seen.find((s) => s.providers.includes("xai"));
    expect(built?.modelCatalog).toBeTypeOf("function");
    // The accessor returns the very instance the engine exposes — one catalog, no divergence.
    expect(built!.modelCatalog!()).toBe(engine.modelCatalog);
  });
});
