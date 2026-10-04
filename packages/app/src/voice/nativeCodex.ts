import { rpcCall, onDaemonState } from "../rpc/bridge";
import type { NativeVoiceState, NativeVoiceMessage } from "@chimera/protocol/contract";
import type { VoiceDiagnosticInput } from "@chimera/protocol/voice-rooms";

export type NativeVoiceView = {
  status: "idle" | "connecting" | "listening" | "error";
  agentId: string | null; transcript: string; error: string | null;
  messages?: NativeVoiceMessage[];
  inputLevel?: number; outputLevel?: number;
  controlWarning?: string;
};
type Deps = {
  rpc: typeof rpcCall;
  mic(): Promise<MediaStream>;
  peer(): RTCPeerConnection;
  audio(): HTMLAudioElement;
  id(): string;
  disconnected(cb: () => void): () => void;
  meter?(stream: MediaStream, level: (value: number) => void): () => void;
  remote?(stream: MediaStream): () => void;
  meeting?: { roomId: string; hostId: string };
  diagnostic?(event: VoiceDiagnosticInput): void;
};
type Call = {
  id: string; agentId: string; stopped: boolean; stream?: MediaStream;
  peer?: RTCPeerConnection; audio?: HTMLAudioElement;
  channel?: RTCDataChannel;
  timer?: ReturnType<typeof setTimeout>; off?: () => void;
  watchdog?: ReturnType<typeof setTimeout>;
  cancelWait?: () => void;
  inputMeter?: () => void; outputMeter?: () => void;
  offRemote?: () => void;
};

// WebRTC carries native audio directly; Chimera only negotiates the existing
// Codex thread and renews its lease. Never resubmit transcripts as agent.send:
// Codex already performs the handoff, so doing both would execute tasks twice.
export class NativeCodexVoice {
  private call: Call | null = null;
  private view: NativeVoiceView = { status: "idle", agentId: null, transcript: "", error: null };
  private listeners = new Set<() => void>();
  private audible = true;
  private stopping: Promise<unknown> = Promise.resolve();
  constructor(private deps: Deps) {}
  getState = (): NativeVoiceView => this.view;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  private set(view: NativeVoiceView): void { this.view = view; for (const fn of this.listeners) fn(); }
  private report(source: VoiceDiagnosticInput["source"], event: string, detail: Partial<VoiceDiagnosticInput> = {}): void {
    const call = this.call;
    try { this.deps.diagnostic?.({ ...detail, source, event, agentId: call?.agentId, sessionId: call?.id }); }
    catch (error) { console.warn("Voice diagnostic failed", error); }
  }

  setAudible(audible: boolean): void {
    this.audible = audible;
    for (const track of this.call?.stream?.getAudioTracks() ?? []) track.enabled = audible;
    if (this.call?.audio) this.call.audio.muted = !audible;
  }

  interruptPlayback(): boolean {
    const call = this.call;
    if (!call || call.stopped) return false;
    // Native Codex/AVAS rejects the public Realtime cancellation events and
    // forwards that rejection to app-server, which ends the native session.
    // Never probe support by sending them. MeetingAudio already clears local
    // playback and gates incoming audio while the human speaks or pauses.
    if (!this.view.controlWarning) {
      const warning = "Voice interruption is local only; native Codex does not support cancelling generation. End meeting to stop the voice sessions.";
      this.report("webrtc", "interruption-local-only", { message: warning });
      this.set({ ...this.view, controlWarning: warning });
    }
    return false;
  }

  async start(agentId: string, acknowledgeTransition: boolean, requestId?: string): Promise<void> {
    if (this.call) return;
    const call: Call = { id: this.deps.id(), agentId, stopped: false };
    this.call = call;
    this.set({ status: "connecting", agentId, transcript: "", error: null });
    const live = () => this.call === call && !call.stopped;
    const fail = (error: unknown) => {
      if (!live()) return;
      this.report("webrtc", "session-failed", { message: message(error).slice(0, 1000), connectionState: call.peer?.connectionState, iceConnectionState: call.peer?.iceConnectionState, signalingState: call.peer?.signalingState, channelState: call.channel?.readyState });
      // MeetingHost treats idle as an ended participant. Publish the actual
      // failure atomically with cleanup so it can retain the diagnostic.
      this.finish({ ...this.view, status: "error", agentId, error: message(error) });
    };
    call.off = this.deps.disconnected(() => fail(new Error("Daemon disconnected; native voice stopped")));
    if (!live()) { call.off(); return; }
    try {
      const stream = await this.deps.mic();
      if (!live()) { for (const track of stream.getTracks()) track.stop(); return; }
      call.stream = stream;
      for (const track of stream.getAudioTracks()) track.enabled = this.audible;
      call.inputMeter = this.deps.meter?.(stream, inputLevel => { if (live()) this.set({ ...this.view, inputLevel }); });
      call.watchdog = setTimeout(() => fail(new Error("Native voice connection timed out")), 30_000);
      for (const track of stream.getAudioTracks()) track.onended = () => { this.report("webrtc", "input-track-ended"); fail(new Error("Microphone disconnected")); };
      const pc = this.deps.peer(); call.peer = pc;
      const audio = this.deps.audio(); call.audio = audio;
      audio.muted = !!this.deps.remote || !this.audible;
      audio.autoplay = !this.deps.remote;
      pc.ontrack = (event) => {
        if (!live()) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        if (this.deps.remote) {
          try { call.offRemote?.(); call.offRemote = this.deps.remote(audio.srcObject as MediaStream); }
          catch (error) { fail(error); }
          return;
        }
        call.outputMeter?.();
        call.outputMeter = this.deps.meter?.(audio.srcObject as MediaStream, outputLevel => { if (live()) this.set({ ...this.view, outputLevel }); });
        void audio.play().catch(() => fail(new Error("Audio playback was blocked; end voice and try again")));
      };
      pc.onconnectionstatechange = () => {
        this.report("webrtc", "connection-state", { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, signalingState: pc.signalingState });
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) fail(new Error("Native voice connection lost; reconnect manually"));
        else if (pc.connectionState === "connected" && live()) {
          clearTimeout(call.watchdog);
          this.set({ ...this.view, status: "listening" });
        }
      };
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.oniceconnectionstatechange = () => { if (live()) this.report("webrtc", "ice-state", { iceConnectionState: pc.iceConnectionState }); };
      pc.onsignalingstatechange = () => { if (live()) this.report("webrtc", "signaling-state", { signalingState: pc.signalingState }); };
      // Codex's WebRTC transport requires the realtime events data channel to
      // exist before the offer. No client-generated agent tasks go over it.
      const channel = pc.createDataChannel("oai-events"); call.channel = channel;
      channel.onerror = event => {
        const error = (event as RTCErrorEvent | undefined)?.error;
        this.report("webrtc", "channel-error", { channelState: channel.readyState, code: error?.errorDetail, message: error?.message?.slice(0, 1000) });
        fail(new Error(error?.message ? `Native voice event channel failed: ${error.message}` : "Native voice event channel failed"));
      };
      channel.onclose = () => { this.report("webrtc", "channel-closed", { channelState: channel.readyState }); fail(new Error("Native voice event channel closed")); };
      channel.onmessage = (event) => {
        if (!live() || typeof event.data !== "string" || event.data.length > 65536) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === "error" || data.type === "session.error") this.report("provider", "data-channel-error", { code: String(data.error?.code ?? data.type).slice(0, 100), message: String(data.error?.message ?? data.message ?? "Native voice service error").slice(0, 1000) });
          if (data.type === "error" || data.type === "session.error") {
            fail(new Error(String(data.error?.message ?? data.message ?? "Native voice service error").slice(0, 4000)));
          }
        } catch { /* Non-JSON/unknown native events do not become application commands. */ }
      };
      await pc.setLocalDescription(await pc.createOffer());
      if (!live()) return;
      if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", changed);
          call.cancelWait = undefined;
        };
        const changed = () => { if (pc.iceGatheringState === "complete") { done(); resolve(); } };
        const timer = setTimeout(() => { done(); reject(new Error("Microphone connection negotiation timed out")); }, 8_000);
        call.cancelWait = () => { done(); reject(new Error("Native voice cancelled")); };
        pc.addEventListener("icegatheringstatechange", changed);
        changed();
      });
      if (!live()) return;
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("WebRTC did not produce an audio offer");
      const response = await this.deps.rpc<{ sdp: string }>("voice.native.start", {
        agentId, sessionId: call.id, sdp, acknowledgeTransition,
        ...(requestId ? { requestId } : {}),
        ...(this.deps.meeting ? { meeting: this.deps.meeting } : {}),
      });
      if (!live()) {
        // A stop can overtake a slow start response. Close only that exact
        // session, never whatever the user may have opened since.
        void this.deps.rpc("voice.native.stop", { sessionId: call.id }).catch(() => {});
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: response.sdp });
      if (!live()) return;
      this.set({ status: pc.connectionState === "connected" ? "listening" : "connecting", agentId, transcript: "", error: null });
      if (pc.connectionState === "connected") clearTimeout(call.watchdog);
      const poll = async () => {
        if (!live()) return;
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const state = await Promise.race([
            this.deps.rpc<NativeVoiceState>("voice.native.poll", { sessionId: call.id }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Voice connection heartbeat timed out")), 5000); }),
          ]).finally(() => clearTimeout(timer));
          if (!live()) return;
          // The terminal poll can carry the last final answer. Let meeting
          // subscribers retain it before normal stop clears the local view.
          this.set({ ...this.view, transcript: state.transcript, messages: state.messages ?? [] });
          if (!live()) return;
          if (!state.active) { this.report("provider", "poll-inactive", { message: state.error?.slice(0, 1000) ?? "Native session ended without an error" }); if (state.error) fail(new Error(state.error)); else this.stop(); return; }
          call.timer = setTimeout(() => { void poll(); }, 1000);
        } catch (error) { fail(error); }
      };
      void poll();
    } catch (error) { fail(error); }
  }

  stop(): void {
    this.finish({ status: "idle", agentId: null, transcript: "", error: null });
  }

  async waitUntilConnected(): Promise<void> {
    if (this.view.status === "listening") return;
    if (this.view.status !== "connecting") throw new Error(this.view.error ?? "Voice session ended before connecting");
    await new Promise<void>((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); reject(new Error("Voice connection timed out")); }, 20_000);
      off = this.subscribe(() => {
        if (this.view.status === "connecting") return;
        clearTimeout(timer); off();
        if (this.view.status === "listening") resolve();
        else reject(new Error(this.view.error ?? "Voice connection cancelled"));
      });
    });
  }
  async stopAndWait(): Promise<NativeVoiceMessage[]> {
    this.stop();
    const result = await this.stopping as { messages?: NativeVoiceMessage[] } | undefined;
    return result?.messages ?? [];
  }

  private finish(view: NativeVoiceView): void {
    const call = this.call;
    if (!call) {
      if (this.view.status !== view.status) this.set(view);
      return;
    }
    this.report("webrtc", "media-disposed", { message: view.error?.slice(0, 1000) ?? "Native voice stopped" });
    this.call = null; call.stopped = true;
    clearTimeout(call.timer); clearTimeout(call.watchdog); call.cancelWait?.(); call.off?.();
    call.inputMeter?.(); call.outputMeter?.();
    call.offRemote?.();
    for (const track of call.stream?.getTracks() ?? []) { track.onended = null; track.stop(); }
    if (call.channel) { call.channel.onclose = null; call.channel.onerror = null; call.channel.onmessage = null; call.channel.close(); }
    if (call.peer) { call.peer.ontrack = null; call.peer.onconnectionstatechange = null; call.peer.oniceconnectionstatechange = null; call.peer.onsignalingstatechange = null; call.peer.close(); }
    if (call.audio) { call.audio.pause(); call.audio.srcObject = null; }
    const stopping = this.deps.rpc("voice.native.stop", { sessionId: call.id }).then(result => {
      const messages = (result as { messages?: NativeVoiceMessage[] } | undefined)?.messages;
      // Stop acknowledgement may contain finals missed by the last poll.
      // A replacement call must never receive its predecessor's transcript.
      if (!this.call && this.stopping === stopping && messages?.length) this.set({ ...this.view, messages });
      return result;
    });
    this.stopping = stopping;
    void this.stopping.catch(() => {});
    this.set(view);
  }
}

function message(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

const nativeVoiceDeps: Deps = {
  rpc: rpcCall,
  mic: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
  peer: () => {
    if (typeof RTCPeerConnection === "undefined") throw new Error("This desktop WebView does not support WebRTC native voice; update the app/system WebView");
    return new RTCPeerConnection();
  },
  audio: () => new Audio(),
  id: () => crypto.randomUUID(),
  disconnected: (cb) => onDaemonState((state) => { if (state !== "connected") cb(); }),
  meter: measureAudioLevel,
};

export type NativeVoiceRoom = NativeVoiceView & { roomId: string; joined: boolean };
const IDLE: NativeVoiceView = { status: "idle", agentId: null, transcript: "", error: null };
const isLive = (view: NativeVoiceView) => view.status === "connecting" || view.status === "listening";

// One WebRTC peer and mic track per room. There is deliberately no remote-audio
// -> microphone graph: only the explicitly joined room can capture or play.
export class NativeVoiceRooms {
  onJoin?: () => void;
  private maxSessions = 16;
  setLimit(value: number): void { if (Number.isInteger(value) && value >= 1 && value <= 32) this.maxSessions = value; }
  private rooms = new Map<string, { id: string; voice: NativeCodexVoice; off: () => void }>();
  private joined: string | null = null;
  private view: NativeVoiceView = IDLE;
  private snapshot: NativeVoiceRoom[] = [];
  private listeners = new Set<() => void>();
  constructor(private create: (roomId: string) => NativeCodexVoice, private id = () => crypto.randomUUID()) {}
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getState = (): NativeVoiceView => this.view;
  getRooms = (): NativeVoiceRoom[] => this.snapshot;
  getAgentState = (agentId: string | null): NativeVoiceView => agentId ? this.rooms.get(agentId)?.voice.getState() ?? IDLE : IDLE;
  private emit(): void {
    this.snapshot = [...this.rooms.entries()].filter(([, r]) => r.voice.getState().status !== "idle").map(([agentId, r]) => ({ ...r.voice.getState(), roomId: r.id, joined: this.joined === agentId }));
    this.view = this.joined ? this.rooms.get(this.joined)?.voice.getState() ?? IDLE : IDLE;
    // Legacy capture guards must also see open but unjoined rooms.
    if (!isLive(this.view) && this.snapshot.some(isLive)) this.view = { ...IDLE, status: "listening" };
    for (const fn of this.listeners) fn();
  }
  async start(agentId: string, transition: boolean, requestId?: string): Promise<void> {
    const previous = this.rooms.get(agentId);
    if (previous && isLive(previous.voice.getState())) { this.join(agentId); return; }
    if (this.snapshot.filter(isLive).length >= this.maxSessions) throw new Error(`End a voice room before opening another (maximum ${this.maxSessions})`);
    // Retain no unbounded history of idle controller objects; text lives in the log.
    for (const [id, room] of this.rooms) if (!isLive(room.voice.getState())) { room.off(); this.rooms.delete(id); }
    const id = this.id(); const voice = this.create(id);
    voice.setAudible(false);
    const room = { id, voice, off: voice.subscribe(() => this.emit()) };
    this.rooms.set(agentId, room);
    this.join(agentId);
    await voice.start(agentId, transition, requestId);
    this.emit();
  }
  join(agentId: string | null): void {
    if (agentId && !this.rooms.has(agentId)) return;
    if (agentId) this.onJoin?.();
    // Break before make: no moment where two mic tracks or players are enabled.
    for (const room of this.rooms.values()) room.voice.setAudible(false);
    this.joined = agentId;
    if (agentId) this.rooms.get(agentId)!.voice.setAudible(true);
    this.emit();
  }
  stop(agentId?: string): void {
    for (const [id, room] of this.rooms) if (!agentId || id === agentId) {
      room.off(); room.voice.stop(); this.rooms.delete(id);
      if (this.joined === id) this.joined = null;
    }
    // Never automatically unmute a different room after ending one.
    this.emit();
  }
}

export const nativeCodexVoice = new NativeVoiceRooms(roomId => new NativeCodexVoice({ ...nativeVoiceDeps, id: () => roomId }));

export function createMeetingVoice(sessionId: string, meeting: { roomId: string; hostId: string }, stream: MediaStream, remote: (stream: MediaStream) => () => void, diagnostic?: (event: VoiceDiagnosticInput) => void): NativeCodexVoice {
  // The room already owns metering/capture. An extra AudioContext + timer per
  // participant adds no UI information and can exhaust WebView audio resources.
  return new NativeCodexVoice({ ...nativeVoiceDeps, meter: undefined, id: () => sessionId, mic: async () => stream, remote, meeting, diagnostic });
}

// Local amplitude only: never record audio or route microphone monitoring to
// speakers. Missing Web Audio support must not break an otherwise working call.
export function measureAudioLevel(stream: MediaStream, level: (value: number) => void): () => void {
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { clearInterval(timer); source?.disconnect(); void context?.close().catch(() => {}); };
  try {
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser(); analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    void context.resume().catch(() => {});
    timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0; for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      level(Math.min(1, Math.sqrt(sum / samples.length) * 5));
    }, 100);
    return stop;
  } catch { stop(); return () => {}; }
}
