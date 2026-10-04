// VOICE-STOP: the "can never be stuck speaking" backstop. It observes the STORE rather than the
// TTS queue on purpose — the wedged case the operator hit is a daemon `voice_session_state:
// speaking` with no local playback at all, so nothing in voiceEvents' queue would ever fire. Any
// path into `speaking` arms it; every chunk (lastTtsText change) re-arms it; leaving `speaking`
// disarms it. Timers/clock are injected so the fallback is testable without waiting 2 minutes.
import { abortSpeech } from "./session";
import { voiceLocal, type VoiceStore } from "./store";

/** Generous by design: a long reply legitimately speaks for a while, and this is a stuck-state
 * backstop, not a playback deadline. */
export const SPEAKING_TIMEOUT_MS = 120_000;

export type WatchdogDeps = {
  store: VoiceStore;
  timeoutMs: number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onTimeout: () => void;
};

const DEFAULT_DEPS: WatchdogDeps = {
  store: voiceLocal,
  timeoutMs: SPEAKING_TIMEOUT_MS,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onTimeout: () => { abortSpeech("timeout"); },
};

/** Idempotent per call site — returns the unsubscribe. */
export function installSpeakingWatchdog(overrides: Partial<WatchdogDeps> = {}): () => void {
  const deps: WatchdogDeps = { ...DEFAULT_DEPS, ...overrides };
  let handle: unknown = null;
  let armedFor: string | null = null;   // the lastTtsText the current timer was armed for

  const disarm = (): void => {
    if (handle !== null) deps.clearTimer(handle);
    handle = null;
    armedFor = null;
  };
  const arm = (key: string): void => {
    if (handle !== null) deps.clearTimer(handle);
    armedFor = key;
    handle = deps.setTimer(() => { handle = null; armedFor = null; deps.onTimeout(); }, deps.timeoutMs);
  };

  const check = (): void => {
    const s = deps.store.getState();
    if (s.status !== "speaking") { disarm(); return; }
    // `lastTtsText` is the only progress signal the state carries: a new chunk means playback is
    // alive, so the clock restarts. Null (a remote `speaking` with no chunk yet) still arms.
    const key = s.lastTtsText ?? "";
    if (handle === null || armedFor !== key) arm(key);
  };

  const off = deps.store.subscribe(check);
  check();
  return () => { off(); disarm(); };
}
