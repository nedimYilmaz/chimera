import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SttStatusSchema, type SttStatus } from "@chimera/protocol";
import { rpcCall, onDaemonState } from "../rpc/bridge";
import { createLoadStatus, runLoad } from "../state/loadStatus";
import { register, selectSttEngine } from "./registry";
import { createWhisperEngine } from "./engines/whisperEngine";
import { createAppleOnDeviceEngine } from "./engines/appleOnDeviceEngine";

export const sttLoadStatus = createLoadStatus();
let state: { status?: SttStatus; appleLocales: string[] } = { appleLocales: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const sttState = () => state;
export async function loadLocalStt(): Promise<void> {
  await runLoad(sttLoadStatus, async () => {
    const [raw, appleLocales] = await Promise.all([rpcCall("stt.status"), typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? invoke<string[]>("local_speech_status") : Promise.resolve([])]);
    return { status: SttStatusSchema.parse(raw), appleLocales };
  }, next => {
    state = next;
    register(createWhisperEngine(next.status.engines.some(e => e.id === "whisper-cpp" && e.available && e.installed)));
    register(createAppleOnDeviceEngine(next.appleLocales.filter(l => ["en-US", "tr-TR"].includes(l)), next.status.preferences.language));
    selectSttEngine(next.status.preferences.engine); emit();
  }, { isUnsupported: e => /unknown.*method|not.*implemented/i.test(String((e as { message?: string })?.message ?? e)) });
}
export function sttLanguage(): "en" | "tr" { return state.status?.preferences.language ?? "en"; }
export async function configureLocalStt(engine: "apple-on-device" | "whisper-cpp" | null, language: "en" | "tr") {
  await rpcCall("stt.configure", { v: 1, engine, language }); await loadLocalStt();
}
let consumers = 0; let disconnect: (() => void) | undefined;
export function useLocalStt() {
  const snapshot = useSyncExternalStore(subscribe, sttState);
  useEffect(() => {
    if (++consumers === 1) {
      disconnect = onDaemonState(s => { if (s === "connected") void loadLocalStt(); else { sttLoadStatus.interrupt("Local speech status disconnected"); register(createWhisperEngine(false)); } });
    }
    return () => { if (--consumers === 0) { disconnect?.(); disconnect = undefined; sttLoadStatus.interrupt("Local speech status view closed"); } };
  }, []);
  return snapshot;
}
