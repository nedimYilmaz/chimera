import type { UiState } from "@chimera/ui-state";
import { useEffect, useRef } from "react";
import { appStore } from "../state/store";
import { getDefaultSttEngine } from "../voice/registry";
import { useStore } from "../state/useStore";
import { cancelPushToTalk, isPushToTalkBusy, startPushToTalk, stopPushToTalkAndInsert, stopSpeakingNow } from "../voice/session";
import { useVoiceStore, voiceLocal } from "../voice/store";
import { useSpeakReplies } from "../voice/ttsGate";
import { voiceControlView } from "../voice/controlView";
import { useLocalStt } from "../voice/localStt";
import styles from "./PushToTalkControl.module.css";

type GestureOwner =
  | { kind: "keyboard"; key: "Enter" | "Space"; mode: "capture" | "stop" }
  | { kind: "pointer"; pointerId: number; mode: "capture" | "stop" };
type GestureStart =
  | { kind: "keyboard"; key: "Enter" | "Space" }
  | { kind: "pointer"; pointerId: number };

function activationKey(key: string): "Enter" | "Space" | null {
  if (key === "Enter") return "Enter";
  if (key === " " || key === "Spacebar" || key === "Space") return "Space";
  return null;
}

// Label/glyph/title copy lives in voice/controlView.ts — a pure view-model, so the operator-facing
// wording is assertable in a node-env test without rendering React.
export function PushToTalkControl({ agentId, draftOwner, onInsert }: { agentId: string | null; draftOwner?: string | null; onInsert: (text: string) => void }) {
  const localSpeech = useLocalStt();
  const noEngine = !!localSpeech.status && !getDefaultSttEngine();
  const connected = useStore((s: UiState) => s.connected);
  const status = useVoiceStore((s) => s.status);
  const errorMessage = useVoiceStore((s) => s.errorMessage);
  const conversationActive = useVoiceStore((s) => s.conversationActive);
  const speakReplies = useSpeakReplies();
  const view = voiceControlView({ status, errorMessage, conversationActive, connected, agentId, speakReplies });
  const { stopMode, disabled } = view;
  const gesture = useRef<GestureOwner | null>(null);

  const invalidateCapture = (): void => {
    gesture.current = null;
    // Effect cleanup and retained blur handlers can belong to the previous render. Read
    // the live owner so an idle-to-conversation transition cannot cancel the new session.
    if (!voiceLocal.getState().conversationActive && isPushToTalkBusy()) cancelPushToTalk();
  };

  // A late transcription belongs to the original selection, never the newly
  // selected agent's send callback. Window/page interruption is the same ownership loss as
  // leaving the pane: invalidate the generation and release any capture exactly once.
  useEffect(() => {
    const windowTarget = typeof window === "undefined" ? null : window;
    const documentTarget = typeof document === "undefined" ? null : document;
    const onWindowBlur = (): void => invalidateCapture();
    const onVisibilityChange = (): void => { if (documentTarget?.hidden) invalidateCapture(); };
    windowTarget?.addEventListener("blur", onWindowBlur);
    if (typeof documentTarget?.addEventListener === "function") {
      documentTarget.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
      windowTarget?.removeEventListener("blur", onWindowBlur);
      if (typeof documentTarget?.removeEventListener === "function") {
        documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
      }
      invalidateCapture();
    };
  }, [agentId, draftOwner, connected, conversationActive]);

  // R3: while a ⌥Space conversation owns the mic, the click/hold gesture is inert — the chord is
  // the only control surface (mirrors session.ts's startPushToTalk guard).
  const begin = (owner: GestureStart): boolean => {
    if (gesture.current) return false;
    if (noEngine && !stopMode) { appStore.dispatch({ type: "selectTab", tab: "settings" }); return false; }
    if (stopMode) {
      gesture.current = { ...owner, mode: "stop" } as GestureOwner;
      stopSpeakingNow();
      return true;
    }
    if (disabled || conversationActive || isPushToTalkBusy()) return false;
    gesture.current = { ...owner, mode: "capture" } as GestureOwner;
    void startPushToTalk(agentId!);
    return true;
  };

  const releaseCapture = (): void => {
    if (conversationActive) return;
    // Releasing while the permission prompt/RPC is opening cancels that pending
    // capture; otherwise it could start recording after the button was released.
    if (status !== "listening") { if (isPushToTalkBusy() && status !== "transcribing") cancelPushToTalk(); return; }
    void stopPushToTalkAndInsert(onInsert);
  };
  const finish = (owner: GestureOwner, cancelled: boolean): void => {
    if (owner.mode === "stop") return;
    if (cancelled) invalidateCapture();
    else releaseCapture();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "Escape" && !conversationActive && isPushToTalkBusy()) {
      event.preventDefault(); event.stopPropagation(); invalidateCapture(); return;
    }
    const key = activationKey(event.key);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    begin({ kind: "keyboard", key });
  };

  const onKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const key = activationKey(event.key);
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    const owner = gesture.current;
    if (!owner || owner.kind !== "keyboard" || owner.key !== key) return;
    gesture.current = null;
    finish(owner, false);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!event.isPrimary || event.button !== 0 || gesture.current) return;
    if (begin({ kind: "pointer", pointerId: event.pointerId })) {
      event.preventDefault();
      event.stopPropagation();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { invalidateCapture(); }
    }
  };

  const finishPointer = (event: React.PointerEvent<HTMLButtonElement>, cancelled: boolean): void => {
    const owner = gesture.current;
    if (!owner || owner.kind !== "pointer" || owner.pointerId !== event.pointerId) return;
    gesture.current = null;
    event.preventDefault();
    event.stopPropagation();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* capture may already have been revoked by the browser */ }
    const rect = event.currentTarget.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    finish(owner, cancelled || outside);
  };

  const onLostPointerCapture = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const owner = gesture.current;
    if (!owner || owner.kind !== "pointer" || owner.pointerId !== event.pointerId) return;
    gesture.current = null;
    finish(owner, true);
  };

  const statusClass = styles[view.tone] ?? styles.idle;

  return (
    <button
      type="button"
      className={`${styles.control} ${statusClass}${view.muted && !stopMode ? ` ${styles.muted}` : ""}`}
      disabled={disabled}
      title={stopMode ? `${view.title} · press Space or Enter while focused` : `${view.title} · hold Space or Enter while focused, release to insert into draft · Esc cancels`}
      aria-label={stopMode ? "stop speaking" : undefined}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onPointerDown={onPointerDown}
      onPointerUp={(event) => finishPointer(event, false)}
      onPointerCancel={(event) => finishPointer(event, true)}
      onLostPointerCapture={onLostPointerCapture}
      onBlur={invalidateCapture}
      data-push-to-talk
      data-voice-status={status}
      data-conversation-active={conversationActive || undefined}
      data-voice-stop={stopMode || undefined}
      data-voice-muted={view.muted || undefined}
    >
      <span className={styles.glyph}>{view.glyph}</span>
      <span className={styles.label}>{noEngine && status === "idle" ? "Set up local speech" : view.label}</span>
    </button>
  );
}
