import { randomUUID } from "node:crypto";
import type { ContractHandlers, NativeVoiceState, NativeVoiceMessage, NativeVoiceRequest } from "@chimera/protocol/contract";
import type { NativeVoiceHandle } from "../backend.js";
import type { VoiceStartContext, VoiceDiagnosticInput } from "@chimera/protocol/voice-rooms";

type Session = NativeVoiceState & {
  agentId: string; handle?: NativeVoiceHandle; expiresAt: number;
  timer: ReturnType<typeof setInterval>;
  messages: NativeVoiceMessage[];
  roomId?: string;
};
export type NativeVoiceDeps = {
  maxSessions?(): number;
  identity?(agentId: string): NonNullable<VoiceStartContext["identity"]>;
  meeting?(roomId: string, hostId: string, agentId: string): NonNullable<VoiceStartContext["meeting"]>;
  check(agentId: string): { needsTransition: boolean };
  prepare(agentId: string, acknowledged: boolean): Promise<NativeVoiceHandle>;
  current(agentId: string): NativeVoiceHandle | undefined;
  configure(agentId: string, enabled: boolean): Promise<{ enabled: boolean }>;
  validateCaller(agentId: string): void;
  history(agentId: string): Promise<NativeVoiceMessage[]>;
  persist(agentId: string, message: NativeVoiceMessage): void;
  ended(agentId: string): void;
  diagnostic?(agentId: string, roomId: string | undefined, diagnostic: VoiceDiagnosticInput): void;
};

// Only the operator can negotiate audio; MCP can request consent or end its own
// conversation. A short renewable lease shuts off native sessions if the window
// dies without sending stop. No audio/SDP is
// persisted, and a session never follows an agent across provider attempts.
export class NativeVoiceRpc {
  readonly handlers: Pick<ContractHandlers, "voice.native.check" | "voice.native.configure" | "voice.native.start" | "voice.native.poll" | "voice.native.stop" | "voice.native.history" | "voice.native.request" | "voice.native.requests" | "voice.native.dismiss" | "voice.native.end" | "voice.native.text">;
  private sessions = new Map<string, Session>();
  private stopping = new Map<string, { promise: Promise<void>; agentId: string; roomId?: string }>();
  private requests = new Map<string, NativeVoiceRequest>();
  constructor(private deps: NativeVoiceDeps, private now = Date.now) {
    this.handlers = {
      "voice.native.check": (p) => this.deps.check(p.agentId),
      "voice.native.history": async p => ({ messages: await this.deps.history(p.agentId) }),
      "voice.native.requests": () => { this.pruneRequests(); return [...this.requests.values()]; },
      "voice.native.dismiss": p => ({ dismissed: this.requests.delete(p.requestId) }),
      "voice.native.request": p => {
        if (p.callerAgentId) this.deps.validateCaller(p.callerAgentId);
        this.deps.check(p.agentId);
        this.pruneRequests();
        if ([...this.sessions.values()].some(s => s.active && s.agentId === p.agentId)) throw new Error("Native voice is already active for this agent");
        const pending = [...this.requests.values()].find(r => r.agentId === p.agentId);
        if (pending) return pending;
        if (this.requests.size >= 16) throw new Error("Too many pending voice requests");
        const request: NativeVoiceRequest = { requestId: randomUUID(), agentId: p.agentId, reason: p.reason,
          ...(p.callerAgentId ? { callerAgentId: p.callerAgentId } : {}), expiresAt: this.now() + 120_000 };
        this.requests.set(request.requestId, request);
        return request;
      },
      "voice.native.end": p => {
        if (p.callerAgentId && p.callerAgentId !== p.agentId) throw new Error("Agents may only end their own voice conversation");
        if (p.callerAgentId) this.deps.validateCaller(p.callerAgentId);
        let stopped = false;
        for (const [id, r] of this.requests) if (r.agentId === p.agentId) { this.requests.delete(id); stopped = true; }
        for (const [id, s] of this.sessions) if (s.agentId === p.agentId) stopped = this.stop(id) || stopped;
        // Also cancels a browser still waiting for microphone permission.
        this.deps.ended(p.agentId);
        return { stopped };
      },
      "voice.native.configure": async (p) => {
        const result = await this.deps.configure(p.agentId, p.enabled);
        if (!p.enabled) {
          for (const [id, session] of this.sessions) if (session.agentId === p.agentId) this.stop(id);
          for (const [id, r] of this.requests) if (r.agentId === p.agentId) this.requests.delete(id);
          this.deps.ended(p.agentId);
        }
        return result;
      },
      "voice.native.start": async (p) => {
        this.pruneRequests();
        for (const [id, session] of this.sessions) if (!session.active) this.stop(id);
        const shutdowns = [...this.stopping.values()].filter(s => s.agentId === p.agentId || p.meeting && s.roomId === p.meeting.roomId);
        if (shutdowns.length) await Promise.all(shutdowns.map(s => s.promise));
        const meeting = p.meeting ? this.deps.meeting?.(p.meeting.roomId, p.meeting.hostId, p.agentId) : undefined;
        if (p.meeting && !meeting) throw new Error("Meeting is not approved");
        if (meeting && [...this.sessions.values()].some(s => s.active && s.roomId === meeting.roomId)) throw new Error("Stop the current meeting speaker before opening another voice session");
        if (p.requestId && this.requests.get(p.requestId)?.agentId !== p.agentId) throw new Error("Voice request expired or was cancelled; request consent again");
        if (this.sessions.size >= (this.deps.maxSessions?.() ?? 16)) throw new Error("Too many native voice sessions");
        if (this.sessions.has(p.sessionId) || [...this.sessions.values()].some(s => s.active && s.agentId === p.agentId)) throw new Error("Native voice is already opening or active for this agent");
        const session: Session = {
          agentId: p.agentId, active: true, transcript: "", messages: [], error: null, expiresAt: this.now() + 30_000, roomId: meeting?.roomId,
          timer: setInterval(() => {
            if (session.expiresAt < this.now() || session.handle && this.deps.current(p.agentId) !== session.handle) {
              this.stop(p.sessionId, session.expiresAt < this.now() ? "native-lease-expired" : "agent-handle-changed");
            }
          }, 1000),
        };
        session.timer.unref();
        this.sessions.set(p.sessionId, session);
        this.report(p.sessionId, session, "start-requested");
        for (const [id, r] of this.requests) if (r.agentId === p.agentId) this.requests.delete(id);
        try {
          const handle = await this.deps.prepare(p.agentId, p.acknowledgeTransition);
          if (!session.active || this.deps.current(p.agentId) !== handle) throw new Error("Native voice start cancelled: agent connection changed");
          if (p.meeting) this.deps.meeting?.(p.meeting.roomId, p.meeting.hostId, p.agentId);
          session.handle = handle;
          const sdp = await handle.start(p.sdp, (state) => {
            if (!session.active) return;
            if (state.transcript !== undefined) session.transcript = state.transcript.slice(-16384);
            if (state.message) {
              const update = state.message;
              let message = session.messages.find(m => !m.final && m.role === update.role);
              if (!message) {
                message = { id: randomUUID(), sessionId: p.sessionId, role: update.role, text: "", final: false, ts: this.now(), ...(session.roomId ? { roomId: session.roomId } : {}) };
                session.messages.push(message);
              }
              message.text = (update.final ? update.text : message.text + update.text).slice(0, 8192);
              message.final = update.final;
              session.messages = session.messages.slice(-100);
              if (update.final) this.deps.persist(p.agentId, { ...message });
            }
            if (state.closed || state.error) {
              this.report(p.sessionId, session, state.error ? "provider-error" : "provider-closed", state.error);
              session.active = false;
              session.error = state.error?.slice(0, 4000) ?? null;
              // Once stopped, this tombstone must not stop a newer session on
              // the same agent handle when its old lease eventually expires.
              session.handle = undefined;
              this.trackStop(p.sessionId, handle, session);
            }
          }, { identity: this.deps.identity?.(p.agentId), meeting });
          if (!session.active || this.deps.current(p.agentId) !== handle) throw new Error("Native voice start cancelled");
          if (p.meeting) this.deps.meeting?.(p.meeting.roomId, p.meeting.hostId, p.agentId);
          session.expiresAt = this.now() + 15_000;
          this.report(p.sessionId, session, "sdp-ready");
          return { sdp };
        } catch (err) { this.report(p.sessionId, session, "start-failed", String(err)); this.stop(p.sessionId, "start-failed"); throw err; }
      },
      "voice.native.poll": (p) => {
        const s = this.sessions.get(p.sessionId);
        if (!s) return { active: false, transcript: "", error: null };
        if (s.handle && this.deps.current(s.agentId) !== s.handle) {
          this.stop(p.sessionId, "agent-handle-changed");
          return { active: false, transcript: "", error: "Agent connection changed; native voice stopped" };
        }
        if (s.active) s.expiresAt = this.now() + 15_000;
        return { active: s.active, transcript: s.transcript, error: s.error, messages: s.messages.map(m => ({ ...m })) };
      },
      "voice.native.stop": async p => {
        // Preserve finals that arrived between the last desktop poll and stop.
        const messages = this.sessions.get(p.sessionId)?.messages.map(m => ({ ...m }));
        const stopped = this.stop(p.sessionId);
        await this.stopping.get(p.sessionId)?.promise;
        return { stopped, ...(messages ? { messages } : {}) };
      },
      "voice.native.text": async p => {
        const s = this.sessions.get(p.sessionId);
        if (!s?.active || !s.handle?.text || this.deps.current(s.agentId) !== s.handle) throw new Error("Native voice text is unavailable for this session");
        await s.handle.text(p.text, p.role); return { accepted: true };
      },
    };
  }

  private pruneRequests(): void {
    for (const [id, r] of this.requests) {
      try {
        if (r.expiresAt <= this.now()) { this.requests.delete(id); continue; }
        this.deps.check(r.agentId);
        // The requester may finish its task after leaving a valid invitation.
        // Only the target must remain voice-capable until the operator accepts.
      } catch { this.requests.delete(id); }
    }
  }

  updateRoomContext(_roomId: string, _context: unknown): void {
    // AVAS appendText can start a response even with role=developer. The host
    // includes the latest roster in the next explicitly addressed question;
    // roster changes alone must never cause native response generation.
  }

  stopRoom(roomId: string): void { for (const [id, s] of this.sessions) if (s.roomId === roomId) this.stop(id, "room-ended"); }
  stopParticipant(roomId: string, agentId: string): void { for (const [id, s] of this.sessions) if (s.roomId === roomId && s.agentId === agentId) this.stop(id, "participant-removed"); }

  private report(sessionId: string, s: Session, event: string, message?: string): void {
    this.deps.diagnostic?.(s.agentId, s.roomId, { source: "provider", event, sessionId, ...(message ? { message: message.slice(0, 1000) } : {}) });
  }
  private trackStop(id: string, handle: NativeVoiceHandle, session: Session): void {
    if (this.stopping.has(id)) return;
    const stopping = handle.stop();
    this.stopping.set(id, { promise: stopping, agentId: session.agentId, roomId: session.roomId });
    void stopping.then(() => { this.stopping.delete(id); }, () => { /* failed stop blocks a replacement session */ });
  }
  private stop(id: string, cause = "stop-requested"): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.report(id, s, cause);
    s.active = false;
    clearInterval(s.timer);
    this.sessions.delete(id);
    if (s.handle) this.trackStop(id, s.handle, s);
    return true;
  }
}
