import { MeetingFloor, type AudioFrame } from "./meetingFloor";
import type { VoiceDiagnosticInput } from "@chimera/protocol/voice-rooms";

// Each meeting owns its audio graph. Human PCM goes only to local speech
// recognition; native input buses stay silent. Selected output plays to the
// operator, while transcript context is retained for passive seats.
export class MeetingAudio {
  readonly context = new AudioContext();
  private inputs = new Map<string, MediaStreamAudioDestinationNode>();
  private sources = new Map<AudioBufferSourceNode, string>();
  private captures = new Set<() => void>();
  private speaker = this.context.createGain();
  private listening = new Set<string>();
  private joinedAt = new Map<string, number>();
  private peers = new Map<string, GainNode>();
  private human = this.context.createGain();
  private humanSource?: MediaStreamAudioSourceNode;
  private humanMeter?: () => void;
  private humanStream?: MediaStream;
  private closed = false;
  private micEpoch = 0;
  private speakerEpoch = 0;
  private microphone = false;
  readonly floor: MeetingFloor;
  private timer: ReturnType<typeof setInterval>;
  private ready: Promise<void>;
  constructor(ids: string[], maxTurns: number, changed: () => void, fail: (error: string) => void, interrupt: () => void = () => {}, private diagnostic: (event: VoiceDiagnosticInput) => void = () => {}, private operatorTurn?: (interrupted: boolean) => void, private microphoneFrame?: (samples: Float32Array, rate: number, voiced: boolean) => void) {
    this.context.onstatechange = () => this.diagnostic({ source: "microphone", event: "audio-context-state", code: this.context.state });
    if (!this.context.audioWorklet) {
      void this.context.close().catch(() => {});
      throw new Error("Meeting audio requires AudioWorklet in a secure desktop context");
    }
    this.speaker.gain.value = 0; this.human.gain.value = 0;
    this.speaker.connect(this.context.destination);
    for (const id of ids) this.addParticipant(id);
    this.floor = new MeetingFloor({ now: () => this.context.currentTime, play: (id, frame, at) => this.play(id, frame, at), changed, fail, maxTurns,
      interrupt: () => { this.clearPlayback(); interrupt(); } });
    if (this.operatorTurn) this.floor.setRecipient(null);
    this.ready = this.context.audioWorklet.addModule("/voice-room-capture.js").then(() => this.context.resume());
    void this.ready.catch(error => { if (!this.closed) fail(`Meeting audio is unavailable: ${String(error)}`); });
    this.timer = setInterval(() => this.floor.tick(), 40);
  }
  async prepare(): Promise<void> { await this.ready; if (this.closed) throw new Error("Meeting was closed"); }
  input(id: string): MediaStream { const bus = this.inputs.get(id); if (!bus) throw new Error("Unknown participant"); return bus.stream; }
  addParticipant(id: string): void {
    if (this.closed || this.inputs.has(id)) throw new Error("Participant already exists or meeting is closed");
    const bus = this.context.createMediaStreamDestination(); this.inputs.set(id, bus);
    const peer = this.context.createGain(); peer.connect(bus); this.peers.set(id, peer);
    // Join only future playout; never replay already scheduled room audio to
    // someone who was not yet an approved participant when it was captured.
    this.joinedAt.set(id, this.context.currentTime);
    this.updatePeers();
  }
  setMaxTurns(maxTurns: number): void { this.floor.setMaxTurns(maxTurns); }
  setParticipantMuted(id: string, muted: boolean): void {
    this.floor.setMuted(id, muted);
    if (muted) for (const [source, owner] of this.sources) if (owner === id) {
      source.onended = null; source.stop(); source.disconnect(); this.sources.delete(source);
    }
  }
  setParticipantListening(id: string, listening: boolean): void {
    if (listening) this.listening.add(id); else this.listening.delete(id);
    this.setParticipantMuted(id, listening); this.updatePeers();
  }
  removeParticipant(id: string): void {
    this.setParticipantMuted(id, true);
    const input = this.inputs.get(id), peer = this.peers.get(id);
    if (input) { input.stream.getTracks().forEach(t => t.stop()); input.disconnect(); }
    peer?.disconnect(); this.inputs.delete(id); this.peers.delete(id); this.joinedAt.delete(id); this.listening.delete(id);
  }
  renewInput(id: string): MediaStream {
    if (this.closed || !this.inputs.has(id)) throw new Error("Participant is no longer in the room");
    const old = this.inputs.get(id)!; old.stream.getTracks().forEach(t => t.stop()); old.disconnect();
    const bus = this.context.createMediaStreamDestination(); this.inputs.set(id, bus);
    const peer = this.peers.get(id)!; peer.disconnect(); peer.connect(bus);
    return bus.stream;
  }
  capture(id: string, stream: MediaStream): () => void {
    if (this.closed) return () => {};
    const source = this.context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(this.context, "chimera-room-capture");
    const silent = this.context.createGain(); silent.gain.value = 0;
    source.connect(worklet); worklet.connect(silent); silent.connect(this.context.destination);
    worklet.port.onmessage = event => {
      if (!this.closed && event.data?.samples instanceof Float32Array) {
        this.floor.push(id, { samples: event.data.samples, rate: this.context.sampleRate, capturedAt: event.data.capturedAt });
        // Audio callbacks keep playout moving even when background timers are
        // throttled. The interval is only an idle/floor-transition backstop.
        this.floor.tick();
      }
    };
    const stop = () => { source.disconnect(); worklet.port.onmessage = null; worklet.port.close(); worklet.disconnect(); silent.disconnect(); this.captures.delete(stop); };
    this.captures.add(stop); return stop;
  }
  private play(id: string, frame: AudioFrame, at: number): void {
    if (this.closed) return;
    const buffer = this.context.createBuffer(1, frame.samples.length, frame.rate);
    buffer.copyToChannel(new Float32Array(frame.samples), 0);
    const source = this.context.createBufferSource(); source.buffer = buffer;
    // Meeting context is shared as text. Peer audio must never trigger another response.
    source.connect(this.speaker); this.sources.set(source, id);
    source.onended = () => { source.disconnect(); this.sources.delete(source); }; source.start(at);
  }
  async setMicrophone(enabled: boolean): Promise<boolean> {
    const version = ++this.micEpoch;
    this.detachHuman(); this.microphone = false; this.human.gain.value = 0; this.updatePeers();
    if (!enabled || this.closed) { this.floor.setRecipient(undefined); return false; }
    await this.context.resume();
    if (version !== this.micEpoch || this.closed) return false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (version !== this.micEpoch || this.closed) { stream.getTracks().forEach(t => t.stop()); return false; }
    this.humanStream = stream;
    this.diagnostic({ source: "microphone", event: "capture-acquired" });
    for (const track of stream.getAudioTracks()) {
      track.onended = () => this.diagnostic({ source: "microphone", event: "capture-ended" });
      track.onmute = () => this.diagnostic({ source: "microphone", event: "capture-muted" });
      track.onunmute = () => this.diagnostic({ source: "microphone", event: "capture-unmuted" });
    }
    for (const track of stream.getAudioTracks()) track.enabled = false;
    this.humanSource = this.context.createMediaStreamSource(stream); this.humanSource.connect(this.human);
    // Detect speech on the room's audio clock, not a 100ms background timer in
    // a separate AudioContext. Never monitor the microphone through speakers.
    const meter = new AudioWorkletNode(this.context, "chimera-room-capture");
    const silent = this.context.createGain(); silent.gain.value = 0;
    this.humanSource.connect(meter); meter.connect(silent); silent.connect(this.context.destination);
    let voicedSeconds = 0;
    meter.port.onmessage = event => {
      if (!this.microphone || this.closed || !(event.data?.samples instanceof Float32Array)) return;
      const samples: Float32Array = event.data.samples;
      const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
      // A click or brief noise burst must not tear down a responding session.
      // Use audio duration so the onset policy is identical across sample rates.
      voicedSeconds = rms > 0.012 ? voicedSeconds + samples.length / this.context.sampleRate : 0;
      const speaking = voicedSeconds >= 0.12;
      if (speaking) this.humanSpeaking();
      // Preserve all PCM, including the onset, for the local recognizer.
      this.microphoneFrame?.(samples, this.context.sampleRate, speaking);
    };
    this.humanMeter = () => { meter.port.onmessage = null; meter.port.close(); meter.disconnect(); silent.disconnect(); };
    this.microphone = true; this.human.gain.value = 1; this.updatePeers();
    for (const track of stream.getAudioTracks()) track.enabled = true;
    return true;
  }
  private humanSpeaking(): void {
    const started = !this.floor.humanActive;
    const interrupted = this.floor.hasPendingAudio;
    this.floor.humanSpeaking();
    if (started && this.operatorTurn) {
      this.diagnostic({ source: "microphone", event: "speech-onset", code: interrupted ? "audio-pending" : "no-audio-pending", message: "sustainedMs=120" });
      this.floor.setRecipient(null);
      this.operatorTurn(interrupted);
    }
  }
  setRecipient(id: string): void {
    this.floor.setRecipient(id);
    for (const [source, owner] of this.sources) if (owner !== id) {
      source.onended = null; source.stop(); source.disconnect(); this.sources.delete(source);
    }
  }
  async setSpeaker(enabled: boolean): Promise<void> {
    const version = ++this.speakerEpoch;
    if (enabled) await this.context.resume();
    if (!this.closed && version === this.speakerEpoch) this.speaker.gain.value = enabled ? 1 : 0;
  }
  setPaused(paused: boolean): void { this.updatePeers(); this.floor.setPaused(paused); }
  private updatePeers(): void {
    // Native input buses are silent. Only the selected session receives the
    // finalized human transcript; no microphone or peer audio is broadcast.
    for (const gain of this.peers.values()) gain.gain.value = 0;
  }
  focus(joined: boolean): void {
    if (!joined) { void this.setMicrophone(false); void this.setSpeaker(false); }
  }
  private clearPlayback(): void {
    for (const source of this.sources.keys()) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
  }
  private detachHuman(): void {
    if (this.humanStream) this.diagnostic({ source: "microphone", event: "capture-released" });
    for (const track of this.humanStream?.getAudioTracks() ?? []) { track.onended = null; track.onmute = null; track.onunmute = null; }
    this.humanMeter?.(); this.humanSource?.disconnect(); this.humanStream?.getTracks().forEach(t => t.stop());
    this.humanMeter = undefined; this.humanSource = undefined; this.humanStream = undefined;
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    this.focus(false); this.detachHuman(); clearInterval(this.timer); this.floor.stop();
    for (const stop of [...this.captures]) stop();
    this.clearPlayback();
    for (const input of this.inputs.values()) { input.stream.getTracks().forEach(t => t.stop()); input.disconnect(); }
    this.human.disconnect(); this.speaker.disconnect(); this.context.onstatechange = null; void this.context.close().catch(() => {});
    for (const gain of this.peers.values()) gain.disconnect();
  }
}
