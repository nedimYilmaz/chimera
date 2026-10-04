export type AudioFrame = { samples: Float32Array; rate: number; capturedAt?: number };
type Speaker = { frames: AudioFrame[]; samples: number; lastVoice: number };
// The floor queues PCM, not model prompts: overlapping native responses are
// played in order rather than mixed over one another or resubmitted as work.
export class MeetingFloor {
  private speakers = new Map<string, Speaker>();
  private queue: string[] = [];
  speaker: string | null = null;
  private humanUntil = 0;
  private scheduledUntil = 0;
  private grants = 0;
  private stopped = false;
  private muted = new Set<string>();
  private paused = false;
  private humanVisible = false;
  private recipient: string | null | undefined;
  constructor(private deps: { now(): number; play(id: string, frame: AudioFrame, at: number): void; changed(): void; interrupt?(): void; fail(reason: string): void; maxTurns: number }) {}
  push(id: string, frame: AudioFrame): void {
    if (this.stopped || this.paused || this.muted.has(id) || !frame.samples.length || frame.rate <= 0) return;
    if (typeof this.recipient === "string" && id !== this.recipient) return;
    const now = this.deps.now();
    let speaker = this.speakers.get(id);
    const energy = Math.sqrt(frame.samples.reduce((s, v) => s + v * v, 0) / frame.samples.length);
    if (energy < 0.002 && (!speaker || now - speaker.lastVoice > 0.4)) return;
    if (!speaker) { speaker = { frames: [], samples: 0, lastVoice: now }; this.speakers.set(id, speaker); }
    if (energy >= 0.002) speaker.lastVoice = now;
    if (speaker.samples + frame.samples.length > frame.rate * 30) { this.stop(); this.deps.fail("A speaker exceeded the 30-second audio queue; meeting stopped to prevent feedback"); return; }
    speaker.frames.push(frame); speaker.samples += frame.samples.length;
    if (id !== this.speaker && !this.queue.includes(id)) { this.queue.push(id); this.deps.changed(); }
  }
  // undefined allows agent discussion, null buffers until the human utterance
  // has been transcribed, and a seat ID admits only that speaker's audio.
  setRecipient(id: string | null | undefined): void {
    this.recipient = id;
    if (typeof id === "string") {
      for (const other of this.speakers.keys()) if (other !== id) this.speakers.delete(other);
      this.queue = this.queue.filter(other => other === id);
      if (this.speaker && this.speaker !== id) { this.speaker = null; this.scheduledUntil = 0; }
    }
    this.deps.changed();
  }
  setMaxTurns(maxTurns: number): void { this.deps.maxTurns = maxTurns; }
  get hasPendingAudio(): boolean { return !!this.speaker || this.queue.length > 0 || [...this.speakers.values()].some(s => s.frames.length > 0); }
  get humanActive(): boolean { return !this.stopped && this.deps.now() < this.humanUntil; }
  setMuted(id: string, muted: boolean): void {
    if (muted) {
      this.muted.add(id); this.speakers.delete(id); this.queue = this.queue.filter(speaker => speaker !== id);
      if (this.speaker === id) { this.speaker = null; this.scheduledUntil = 0; }
    } else this.muted.delete(id);
    this.deps.changed();
  }
  private clear(): void {
    this.speakers.clear(); this.queue = []; this.speaker = null; this.scheduledUntil = 0;
    this.deps.interrupt?.(); this.deps.changed();
  }
  humanSpeaking(): void {
    if (this.stopped) return;
    // Cancel already scheduled PCM AND stale queued replies on the speech edge.
    // Merely delaying tick leaves the old conversation playing over the human.
    const started = !this.humanActive;
    this.humanUntil = this.deps.now() + 0.8;
    if (started) { this.humanVisible = true; this.clear(); }
  }
  setPaused(paused: boolean): void {
    if (this.stopped || this.paused === paused) return;
    this.paused = paused;
    if (paused) this.clear();
  }
  tick(): void {
    if (this.stopped || this.paused || this.recipient === null) return;
    const now = this.deps.now();
    if (this.humanVisible && !this.humanActive) { this.humanVisible = false; this.deps.changed(); }
    if (now < this.humanUntil) return;
    if (this.speaker) {
      const s = this.speakers.get(this.speaker)!;
      if (!s.frames.length && now >= this.scheduledUntil && now - s.lastVoice > 0.6) { this.speaker = null; this.deps.changed(); }
    }
    if (!this.speaker && this.queue.length) {
      if (++this.grants > this.deps.maxTurns) { this.stop(); this.deps.fail("Meeting speaking-turn budget reached"); return; }
      this.speaker = this.queue.shift()!; this.deps.changed();
    }
    if (!this.speaker) return;
    const s = this.speakers.get(this.speaker)!;
    while (s.frames.length && this.scheduledUntil < now + 0.25) {
      const frame = s.frames.shift()!; s.samples -= frame.samples.length;
      // One jitter-buffer lead per underrun, not a new delay on every frame.
      // Keep adjacent PCM blocks sample-contiguous despite worklet IPC jitter.
      const at = this.scheduledUntil > now + 0.005 ? this.scheduledUntil : now + 0.12;
      this.deps.play(this.speaker, frame, at);
      this.scheduledUntil = at + frame.samples.length / frame.rate;
    }
  }
  waiting(): string[] { return [...this.queue]; }
  stop(): void { this.stopped = true; this.speakers.clear(); this.queue = []; this.speaker = null; }
}
