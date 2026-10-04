// VOICE S2 (docs/superpowers/specs/2026-07-24-voice-agents-design.md §6/§10): voice.session.*/
// voice.conversation.* RPC family, mirroring sub-rpc.ts's thin-dispatch-onto-a-registry shape.
// A trivial in-memory registry — no audio/STT/TTS here (S5/S7/S8). S4's supervisor EventSink tap
// reads activeSessionForAgent() below to gate voice_tts_chunk emission. Sessions/toggles are
// process-lifetime only, matching this slice's app-driven, non-durable scope.
import { randomUUID } from "node:crypto";
import type { ContractHandlers, VoiceSessionRecord } from "@chimera/protocol/contract";

export type VoiceRpcHandlers = Pick<ContractHandlers,
  "voice.session.start" | "voice.session.stop" | "voice.conversation.set" | "voice.realtime.token">;

// VOICE R1: thrown by the "voice.realtime.token" stub until RK1 wires the real
// `POST /v1/realtime/client_secrets` mint against a configured OpenAI voice account.
// "credential"-coded like CredentialError (core/credentials.ts) — same failover.ts
// classifyError() bucket, since both mean "no usable key for this call".
export class VoiceRealtimeNotConfiguredError extends Error {
  code = "credential" as const;
  name = "VoiceRealtimeNotConfiguredError";
}

export class VoiceRpc {
  readonly handlers: VoiceRpcHandlers;
  private readonly sessions = new Map<string, VoiceSessionRecord>();
  private readonly conversationEnabled = new Map<string, boolean>();

  constructor(private readonly deps: { now: () => number } = { now: () => Date.now() }) {
    this.handlers = {
      "voice.session.start": (p) => {
        const record: VoiceSessionRecord = {
          sessionId: randomUUID(), agentId: p.agentId, state: "listening", startedAt: this.deps.now(),
        };
        this.sessions.set(record.sessionId, record);
        return record;
      },
      "voice.session.stop": (p) => ({ stopped: this.sessions.delete(p.sessionId) }),
      "voice.conversation.set": (p) => {
        this.conversationEnabled.set(p.agentId, p.enabled);
        return { agentId: p.agentId, enabled: p.enabled };
      },
      "voice.realtime.token": () => {
        throw new VoiceRealtimeNotConfiguredError("OpenAI voice account not configured");
      },
    };
  }

  // S4 (backend TTS-tap seam): the supervisor's EventSink tap gates voice_tts_chunk emission on
  // this — an agent with no active session gets no synthetic events (voice is opt-in per agent).
  // Linear scan over `sessions` is fine at this scale (process-lifetime, one row per live mic
  // session, matches voice.session.stop's own Map-based footprint).
  activeSessionForAgent(agentId: string): VoiceSessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agentId === agentId) return record;
    }
    return undefined;
  }
}
