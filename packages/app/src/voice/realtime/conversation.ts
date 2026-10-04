// VOICE R3 (docs/superpowers/specs/2026-07-24-voice-realtime-design.md §2/§5): the ⌥Space
// conversation-mode orchestration — idle -> listening -> (VAD onSpeechEnd) transcribing -> send
// via the EXISTING agent send path -> agent streams -> speaking (TTS via the RealtimeEngine from
// R2) -> back to listening, with barge-in (VAD onSpeechStart while speaking -> stopSpeaking() +
// interrupt the agent's in-flight turn via the existing agent.interrupt RPC -> resume listening).
// Reuses voice.session.start/voice.conversation.set (landed) exactly as §2's data flow specifies
// — this module never invents a second session/toggle RPC.
import { rpcCall } from "../../rpc/bridge";
import { errorText } from "../../state/errorText";
import type { VoiceSessionRecord } from "@chimera/protocol/contract";
import { DEFAULT_REALTIME_ENGINE_ID, getRealtimeEngine } from "../registry";
import type { RealtimeSession } from "./types";
import { createVad, type VoiceActivityDetector } from "./vad";
import { voiceLocal } from "../store";
import { clearSpeechLatch } from "../ttsGate";

// §1 "Gating correction": this is what a real user sees before RK1/RK2 (the OpenAI token mint +
// adapter) ship, or on any machine with no OpenAI voice account configured — never the raw
// "OpenAI voice account not configured" credential-error text (that's an internal RPC message).
export const VOICE_REALTIME_NOT_CONFIGURED_MESSAGE =
  "Voice not configured — add an OpenAI voice account in Settings to talk to your agents";

type ActiveConversation = {
  agentId: string;
  sessionId: string;
  session: RealtimeSession;
  vad: VoiceActivityDetector;
  latestFinalTranscript: string;
};

let active: ActiveConversation | null = null;

export function isConversationActive(): boolean {
  return active !== null;
}

/** voiceEvents.ts's ONE voice_tts_chunk consumer checks this to decide whether a chunk plays
 * through the RealtimeSession (conversation mode, so stopSpeaking() can actually cancel it) or
 * the plain SpeechEngine (push-to-talk, unchanged) — same event, different consumer (§4/§8). */
export function activeConversationFor(agentId: string): RealtimeSession | undefined {
  return active && active.agentId === agentId ? active.session : undefined;
}

function isCredentialError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "credential";
}

/** Releases the landed session/conversation RPCs opened at the top of startConversation — used
 * both by its own abort paths (token mint / engine / session-open failure) and by the full
 * teardown below. */
function releaseSession(agentId: string, sessionId: string): void {
  void rpcCall("voice.conversation.set", { agentId, enabled: false }).catch(() => {});
  void rpcCall("voice.session.stop", { sessionId }).catch(() => {});
}

/** ⌥Space toggle ON (§2 data flow): mint the realtime token, open the RealtimeEngine session,
 * start client VAD. Any failure (no OpenAI voice account yet, engine unavailable) surfaces as a
 * clear error and never leaves a half-started conversation behind. */
export async function startConversation(agentId: string, send: (text: string) => void): Promise<void> {
  if (active || !agentId) return;
  clearSpeechLatch();   // a stop in a previous turn must never mute this conversation

  let record: VoiceSessionRecord;
  try {
    record = await rpcCall<VoiceSessionRecord>("voice.session.start", { agentId });
  } catch (err) {
    voiceLocal.dispatch({ type: "error", message: errorText(err) || "voice session failed to start" });
    return;
  }
  await rpcCall("voice.conversation.set", { agentId, enabled: true }).catch(() => {});

  let token: string;
  try {
    const res = await rpcCall<{ token: string }>("voice.realtime.token", { mode: "transcription" });
    token = res.token;
  } catch (err) {
    voiceLocal.dispatch({ type: "error", message: isCredentialError(err) ? VOICE_REALTIME_NOT_CONFIGURED_MESSAGE : (errorText(err) || "voice realtime token mint failed") });
    releaseSession(agentId, record.sessionId);
    return;
  }

  const engine = getRealtimeEngine(DEFAULT_REALTIME_ENGINE_ID);
  if (!engine) {
    voiceLocal.dispatch({ type: "error", message: VOICE_REALTIME_NOT_CONFIGURED_MESSAGE });
    releaseSession(agentId, record.sessionId);
    return;
  }

  let session: RealtimeSession;
  try {
    session = await engine.start({ token, agentId, mode: "transcription" });
  } catch (err) {
    voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "realtime session failed to start" });
    releaseSession(agentId, record.sessionId);
    return;
  }

  const conv: ActiveConversation = { agentId, sessionId: record.sessionId, session, vad: null as unknown as VoiceActivityDetector, latestFinalTranscript: "" };

  session.onPartialTranscript((text) => voiceLocal.dispatch({ type: "partialTranscript", text }));
  session.onFinalTranscript((text) => { conv.latestFinalTranscript = text; });

  conv.vad = createVad({
    // End of utterance (§5): take whatever final transcript the STT session has produced and
    // send it via the caller's EXISTING send path — never a second send pipe.
    onSpeechEnd: () => {
      const transcript = conv.latestFinalTranscript.trim();
      conv.latestFinalTranscript = "";
      if (!transcript) return;
      voiceLocal.dispatch({ type: "transcribing" });
      send(transcript);
    },
    // Barge-in (§5): only while the agent is actually speaking — otherwise this is just the
    // user's own turn starting, which onSpeechEnd above already handles.
    onSpeechStart: () => {
      if (active !== conv || voiceLocal.getState().status !== "speaking") return;
      conv.session.stopSpeaking();
      void rpcCall("agent.interrupt", { agentId: conv.agentId }).catch(() => {});
      voiceLocal.dispatch({ type: "conversationListening" });
    },
  });
  try {
    await conv.vad.start();
  } catch (err) {
    // Same leak class as VOICE-SESSION-START-MIC-LEAK, one step later: MicVAD.new() (getUserMedia
    // + WASM init) can reject (mic permission denied, no device, model load failure) AFTER the
    // realtime engine session is already open — without this catch, that session and the daemon's
    // voice.session/conversation.set(enabled:true) state leak forever with no error surfaced.
    voiceLocal.dispatch({ type: "error", message: err instanceof Error ? err.message : "microphone failed to start" });
    await conv.session.close().catch(() => {});
    releaseSession(agentId, record.sessionId);
    return;
  }

  active = conv;
  voiceLocal.dispatch({ type: "conversationStarted", sessionId: conv.sessionId, agentId });
}

/** VOICE-STOP: cancel the conversation's own in-flight playback WITHOUT ending the conversation —
 * exactly what barge-in does (stop the audio, interrupt the agent's turn), just triggered by Esc
 * or the control instead of the user's voice. Returns false when no conversation owns the audio,
 * which is how session.ts knows to stop the plain push-to-talk TTS engine instead. */
export function stopActiveConversationSpeaking(): boolean {
  const conv = active;
  if (!conv) return false;
  conv.session.stopSpeaking();
  void rpcCall("agent.interrupt", { agentId: conv.agentId }).catch(() => {});
  return true;
}

/** ⌥Space toggle OFF: tear down VAD + realtime session + the landed session/conversation RPCs,
 * in that order, so nothing keeps listening or keeps the daemon's TTS tap gated open. */
export async function stopConversation(): Promise<void> {
  const conv = active;
  if (!conv) return;
  active = null;
  await conv.vad.stop().catch(() => {});
  await conv.session.close().catch(() => {});
  releaseSession(conv.agentId, conv.sessionId);
  voiceLocal.dispatch({ type: "conversationEnded" });
}

export async function toggleConversation(agentId: string, send: (text: string) => void): Promise<void> {
  if (active) {
    await stopConversation();
  } else {
    await startConversation(agentId, send);
  }
}
