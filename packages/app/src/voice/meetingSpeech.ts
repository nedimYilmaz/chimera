import { Channel, invoke } from "@tauri-apps/api/core";

export type MeetingSpeechEvent = { sessionId: string; type: "ready" | "transcript" | "error"; text?: string; utteranceId?: string; final?: boolean; respond?: boolean; error?: string };
type NativeSpeechEvent = MeetingSpeechEvent & { boundaryId?: string };
type Utterance = { id: string; boundary?: string; segments: string[]; superseded: boolean };
type Session = { id: string; ready: boolean; serial: Promise<void>; pending: number; frames: number[]; rate?: number; voiced: boolean; silence: number; next: number; utterances: Utterance[]; seen: Set<string> };

// Native recognition requests can finalize naturally or roll over while the
// human is still speaking. Only our VAD boundary commits a logical utterance.
export class MeetingSpeech {
  private session?: Session;
  constructor(private event: (event: MeetingSpeechEvent) => void) {}
  async start(names: string[], locale = "tr-TR"): Promise<void> {
    this.stop();
    const session: Session = { id: crypto.randomUUID(), ready: false, serial: Promise.resolve(), pending: 0, frames: [], voiced: false, silence: 0, next: 0, utterances: [], seen: new Set() };
    this.session = session;
    const onEvent = new Channel<NativeSpeechEvent>();
    onEvent.onmessage = event => this.receive(session, event);
    try {
      await invoke("meeting_speech_start", { sessionId: session.id, locale, contextualStrings: names, onEvent });
      if (this.session === session) session.ready = true;
      else await invoke("meeting_speech_stop", { sessionId: session.id });
    } catch (error) { if (this.session === session) this.stop(); throw error; }
  }
  append(samples: Float32Array, sampleRate: number, voiced: boolean): void {
    const session = this.session;
    if (!session?.ready) return;
    if (!samples.length || samples.length > 16384 || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || session.rate !== undefined && sampleRate !== session.rate || samples.some(sample => !Number.isFinite(sample) || Math.abs(sample) > 1.01)) {
      this.fail(session, "Invalid microphone audio for local speech recognition."); return;
    }
    session.rate = sampleRate;
    if (voiced && !session.voiced) {
      // If a fresh utterance starts before the previous one finalizes, the
      // older question must not open a voice session over the new speech.
      for (const utterance of session.utterances) utterance.superseded = true;
      if (session.utterances.length >= 8) { this.fail(session, "Local speech recognition could not finalize your questions. Enable the microphone to retry."); return; }
      session.utterances.push({ id: `${session.id}:${++session.next}`, segments: [], superseded: false });
      session.voiced = true;
    }
    if (voiced) session.silence = 0;
    else session.silence += samples.length / sampleRate;
    session.frames.push(...samples);
    while (session.frames.length >= 4096) this.appendBatch(session, session.frames.splice(0, 4096), sampleRate);
    if (this.session !== session) return;
    if (session.voiced && session.silence >= 0.9) {
      session.voiced = false; session.silence = 0;
      const utterance = session.utterances.at(-1)!;
      utterance.boundary = utterance.id;
      if (session.frames.length) this.appendBatch(session, session.frames.splice(0), sampleRate);
      this.enqueue(session, () => invoke("meeting_speech_finish", { sessionId: session.id, boundaryId: utterance.boundary }));
    }
  }
  private appendBatch(session: Session, samples: number[], sampleRate: number): void {
    this.enqueue(session, () => invoke("meeting_speech_append", { sessionId: session.id, samples, sampleRate }));
  }
  private enqueue(session: Session, work: () => Promise<unknown>): void {
    if (this.session !== session) return;
    if (session.pending >= 24) { this.fail(session, "Local speech recognition could not keep up. Enable the microphone to retry."); return; }
    session.pending++;
    session.serial = session.serial.then(async () => { if (this.session === session) await work(); })
      .catch(error => this.fail(session, String(error))).finally(() => { session.pending--; });
  }
  private receive(session: Session, event: NativeSpeechEvent): void {
    if (this.session !== session || event.sessionId !== session.id) return;
    if (event.type === "error") { this.fail(session, event.error ?? "Local speech recognition failed."); return; }
    if (event.type === "ready") { this.event(event); return; }
    const utterance = session.utterances[0];
    if (!utterance || event.type !== "transcript") return;
    if (!event.utteranceId) { this.fail(session, "Local speech recognition returned an unidentified transcript. Update the app before retrying."); return; }
    if (event.final && session.seen.has(event.utteranceId)) return;
    if (event.final && event.boundaryId && event.boundaryId !== utterance.boundary) {
      if (!session.utterances.some(next => next.boundary === event.boundaryId)) return;
      this.fail(session, "Local speech boundaries arrived out of order. Enable the microphone to retry."); return;
    }
    const text = event.text?.trim() ?? "";
    if (event.final && !session.seen.has(event.utteranceId)) {
      session.seen.add(event.utteranceId);
      if (session.seen.size > 256) session.seen.delete(session.seen.values().next().value!);
      if (text) utterance.segments.push(text);
    }
    const combined = [...utterance.segments, ...(!event.final && text ? [text] : [])].join(" ");
    if (combined.length > 8192) { this.fail(session, "Your question is too long. Please split it into shorter questions."); return; }
    if (event.final && event.boundaryId) {
      session.utterances.shift();
      this.event({ sessionId: session.id, type: "transcript", text: combined, final: true, utteranceId: utterance.id, ...(utterance.superseded || session.voiced ? { respond: false } : {}) });
    } else if (!utterance.superseded) {
      this.event({ sessionId: session.id, type: "transcript", text: combined, final: false, utteranceId: utterance.id });
    }
  }
  private fail(session: Session, error: string): void {
    if (this.session !== session) return;
    this.stop(); this.event({ sessionId: session.id, type: "error", error });
  }
  stop(): void {
    const session = this.session; this.session = undefined;
    if (session) {
      session.frames = []; session.utterances = [];
      void invoke("meeting_speech_stop", { sessionId: session.id }).catch(() => {});
    }
  }
}
