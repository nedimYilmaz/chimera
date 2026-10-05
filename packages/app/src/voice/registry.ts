// VOICE S5 (§4 "Engine layer"): the engine registry — id-keyed, carries each engine's privacy
// metadata (EngineMetadata.isLocal/healthy), consumed by S6's settings scaffold and S7/S8's
// future adapters. Ships local-first per §2's hard privacy rule: cloud is never registered here
// by default, only ever added behind an explicit opt-in (S8).
import { createSpeechSynthesisEngine, SYSTEM_TTS_ENGINE_ID } from "./engines/speechSynthesisEngine";
import { createMockSttEngine, MOCK_STT_ENGINE_ID } from "./engines/mockSttEngine";
import { createMockRealtimeEngine, MOCK_REALTIME_ENGINE_ID } from "./realtime/mockRealtimeEngine";
import type { RealtimeEngine } from "./realtime/types";
import type { EngineMetadata, SpeechEngine } from "./types";

const engines = new Map<string, SpeechEngine>();

export function register(engine: SpeechEngine): void {
  engines.set(engine.meta.id, engine);
}

register(createSpeechSynthesisEngine());
if (import.meta.env.DEV && typeof window !== "undefined" && window.__CHIMERA_MOCK__) register(createMockSttEngine());

export const DEFAULT_TTS_ENGINE_ID = SYSTEM_TTS_ENGINE_ID;
export let DEFAULT_STT_ENGINE_ID: string | null = engines.has(MOCK_STT_ENGINE_ID) ? MOCK_STT_ENGINE_ID : null;
export function selectSttEngine(id: string | null): void { DEFAULT_STT_ENGINE_ID = id; }

export function listEngines(): EngineMetadata[] {
  return [...engines.values()].map((e) => e.meta);
}

export function getEngine(id: string): SpeechEngine | undefined {
  return engines.get(id);
}

function requireEngine(id: string): SpeechEngine {
  const engine = engines.get(id);
  if (!engine) throw new Error(`voice engine "${id}" is not registered`);
  return engine;
}

export function getDefaultSttEngine(): SpeechEngine | undefined {
  const selected = DEFAULT_STT_ENGINE_ID ? engines.get(DEFAULT_STT_ENGINE_ID) : undefined;
  if (DEFAULT_STT_ENGINE_ID) return selected?.meta.healthy && selected.transcribe ? selected : undefined;
  return [...engines.values()].find(e => e.meta.isLocal && e.meta.healthy && e.transcribe);
}

export function getDefaultTtsEngine(): SpeechEngine {
  return requireEngine(DEFAULT_TTS_ENGINE_ID);
}

// VOICE R2 (§4 "Registry seam — RealtimeEngine is a NEW adapter kind"): a PARALLEL registry,
// not a variant of `engines` above — Realtime is duplex + session-lifetime, request/response
// SpeechEngine can't express it. The real `openai-realtime` (RK2) and `openai-s2s` (RK3)
// adapters register here only when an OpenAI voice account is present (S8's cloud-opt-in
// pattern); the mock always registers so headless tests never depend on a key.
const realtimeEngines = new Map<string, RealtimeEngine>();

function registerRealtime(engine: RealtimeEngine): void {
  realtimeEngines.set(engine.meta.id, engine);
}

registerRealtime(createMockRealtimeEngine());

export const DEFAULT_REALTIME_ENGINE_ID = MOCK_REALTIME_ENGINE_ID;

export function listRealtimeEngines(): (EngineMetadata & { realtime: true })[] {
  return [...realtimeEngines.values()].map((e) => e.meta);
}

export function getRealtimeEngine(id: string): RealtimeEngine | undefined {
  return realtimeEngines.get(id);
}
