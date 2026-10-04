import { afterEach, describe, expect, it, vi } from "vitest";

// VOICE S5 — registry unit tests (§9 "Unit: engine registry (local default, cloud gated)").
// The registry's `healthy` flags are computed at MODULE-EVAL time from `window` (mirrors
// rpc/bridge.ts's own mock-detection pattern), so each case needs its own fresh module graph —
// vi.resetModules() + a dynamic import AFTER stubbing window, same discipline
// agents-window-harness.ts documents for the rpc bridge.

const ORIGINAL_WINDOW = (globalThis as unknown as { window?: unknown }).window;

afterEach(() => {
  (globalThis as unknown as { window?: unknown }).window = ORIGINAL_WINDOW;
  vi.resetModules();
});

describe("voice engine registry", () => {
  it("registers a local TTS default and a local (mock) STT default, both isLocal — never a cloud engine", async () => {
    (globalThis as unknown as { window: unknown }).window = { speechSynthesis: {} };
    vi.resetModules();
    const { listEngines, DEFAULT_TTS_ENGINE_ID, DEFAULT_STT_ENGINE_ID } = await import("../src/voice/registry");
    const engines = listEngines();
    expect(engines.length).toBeGreaterThanOrEqual(2);
    for (const e of engines) expect(e.isLocal).toBe(true);
    expect(engines.some((e) => e.id === DEFAULT_TTS_ENGINE_ID)).toBe(true);
    expect(engines.some((e) => e.id === DEFAULT_STT_ENGINE_ID)).toBe(true);
  });

  it("system-tts reports healthy when window.speechSynthesis exists", async () => {
    (globalThis as unknown as { window: unknown }).window = { speechSynthesis: {} };
    vi.resetModules();
    const { getDefaultTtsEngine } = await import("../src/voice/registry");
    expect(getDefaultTtsEngine().meta.healthy).toBe(true);
  });

  it("system-tts reports unhealthy when speechSynthesis is absent", async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    vi.resetModules();
    const { getDefaultTtsEngine } = await import("../src/voice/registry");
    expect(getDefaultTtsEngine().meta.healthy).toBe(false);
  });

  it("mock-stt reports healthy only under the __CHIMERA_MOCK__ dev/test seam", async () => {
    (globalThis as unknown as { window: unknown }).window = { __CHIMERA_MOCK__: { rpc: async () => ({}) } };
    vi.resetModules();
    const { getDefaultSttEngine } = await import("../src/voice/registry");
    expect(getDefaultSttEngine().meta.healthy).toBe(true);
  });

  it("mock-stt reports unhealthy in a real (non-mock) window — no local STT ships until S7", async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    vi.resetModules();
    const { getDefaultSttEngine } = await import("../src/voice/registry");
    expect(getDefaultSttEngine().meta.healthy).toBe(false);
  });
});
