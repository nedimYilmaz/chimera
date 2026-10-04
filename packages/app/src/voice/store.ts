// VOICE S6: the app-local observable store wrapping ui-state's pure voiceReducer — same
// getState/subscribe shape as commands.agents.ts's createLocalStore, driven by dispatch(action)
// instead of set(patch) since the state machine (§7's error transitions) belongs in the shared
// pure reducer, not scattered across call sites.
import { useSyncExternalStore } from "react";
import { initialVoiceState, voiceReducer, type VoiceAction, type VoiceUiState } from "@chimera/ui-state";

export type VoiceStore = {
  getState(): VoiceUiState;
  dispatch(action: VoiceAction): void;
  subscribe(fn: () => void): () => void;
};

function createVoiceStore(): VoiceStore {
  let state = initialVoiceState;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      state = voiceReducer(state, action);
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

/** The ONE app-wide voice-session store (module singleton — mirrors composerLocal). */
export const voiceLocal: VoiceStore = createVoiceStore();

export function useVoiceStore<T>(selector: (s: VoiceUiState) => T): T {
  return useSyncExternalStore(voiceLocal.subscribe, () => selector(voiceLocal.getState()));
}
