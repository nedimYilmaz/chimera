import { afterEach, describe, expect, it, vi } from "vitest";

// VOICE R2 (§9 "R2 realtime iface + registry + mock") — mirrors voice-registry.test.ts's
// discipline: `healthy` is computed at MODULE-EVAL time from `window.__CHIMERA_MOCK__`, so each
// case gets its own fresh module graph via vi.resetModules() + a dynamic import AFTER stubbing
// window.

const ORIGINAL_WINDOW = (globalThis as unknown as { window?: unknown }).window;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = ORIGINAL_WINDOW;
  vi.resetModules();
});

describe("realtime engine registry", () => {
  it("registers a local mock realtime engine with realtime:true metadata", async () => {
    (globalThis as unknown as { window: unknown }).window = { __CHIMERA_MOCK__: { rpc: async () => ({}) } };
    vi.resetModules();
    const { listRealtimeEngines, DEFAULT_REALTIME_ENGINE_ID } = await import("../src/voice/registry");
    const engines = listRealtimeEngines();
    expect(engines.length).toBeGreaterThanOrEqual(1);
    for (const e of engines) {
      expect(e.realtime).toBe(true);
      expect(e.isLocal).toBe(true);
    }
    expect(engines.some((e) => e.id === DEFAULT_REALTIME_ENGINE_ID)).toBe(true);
  });

  it("mock realtime engine reports healthy only under the __CHIMERA_MOCK__ seam", async () => {
    (globalThis as unknown as { window: unknown }).window = { __CHIMERA_MOCK__: { rpc: async () => ({}) } };
    vi.resetModules();
    const { getRealtimeEngine, DEFAULT_REALTIME_ENGINE_ID } = await import("../src/voice/registry");
    expect(getRealtimeEngine(DEFAULT_REALTIME_ENGINE_ID)?.meta.healthy).toBe(true);
  });

  it("mock realtime engine reports unhealthy in a real (non-mock) window", async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    vi.resetModules();
    const { getRealtimeEngine, DEFAULT_REALTIME_ENGINE_ID } = await import("../src/voice/registry");
    expect(getRealtimeEngine(DEFAULT_REALTIME_ENGINE_ID)?.meta.healthy).toBe(false);
  });

  it("getRealtimeEngine returns undefined for an unregistered id", async () => {
    (globalThis as unknown as { window: unknown }).window = { __CHIMERA_MOCK__: { rpc: async () => ({}) } };
    vi.resetModules();
    const { getRealtimeEngine } = await import("../src/voice/registry");
    expect(getRealtimeEngine("openai-realtime")).toBeUndefined();
  });
});
