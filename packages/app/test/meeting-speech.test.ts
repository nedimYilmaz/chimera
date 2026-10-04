import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingSpeech, type MeetingSpeechEvent } from "../src/voice/meetingSpeech";
const mock = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as any[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke, Channel: class { onmessage: any; constructor() { mock.channels.push(this); } } }));
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const speech = new Float32Array(4096).fill(0.1);
const silence = new Float32Array(4096);
const starts = () => mock.invoke.mock.calls.filter(([method]) => method === "meeting_speech_start");
const finishes = () => mock.invoke.mock.calls.filter(([method]) => method === "meeting_speech_finish");
const send = (event: Record<string, unknown>, index = mock.channels.length - 1) => mock.channels[index].onmessage({ sessionId: starts()[index]![1].sessionId, type: "transcript", ...event });
const end = async (recognizer: MeetingSpeech) => { for (let i = 0; i < 11; i++) recognizer.append(silence, 48000, false); await flush(); };
const finalEvents = (events: MeetingSpeechEvent[]) => events.filter(event => event.type === "transcript" && event.final);
beforeEach(() => { mock.invoke.mockReset().mockResolvedValue(undefined); mock.channels.length = 0; });

describe("local meeting utterance aggregation", () => {
  it("clears a noise-only utterance and accepts the next question without restarting capture", async () => {
    const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
    await recognizer.start(["Atlas"]); recognizer.append(speech, 48000, true);
    send({ utteranceId: "noise", text: "At", final: false }); await end(recognizer);
    send({ utteranceId: "noise", boundaryId: finishes()[0]![1].boundaryId, text: "", final: true });
    expect(finalEvents(events)).toMatchObject([{ text: "", final: true }]);
    recognizer.append(speech, 48000, true); await end(recognizer);
    send({ utteranceId: "actual", boundaryId: finishes()[1]![1].boundaryId, text: "Atlas soru", final: true });
    expect(finalEvents(events).at(-1)?.text).toBe("Atlas soru");
    expect(events.some(event => event.type === "error")).toBe(false); expect(starts()).toHaveLength(1); recognizer.stop();
  });
  it("holds natural finals and request rollover segments until the 900ms boundary is finalized", async () => {
    const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
    await recognizer.start(["Atlas"]); recognizer.append(speech, 48000, true); await flush();
    send({ utteranceId: "native-1", text: "Atlas", final: false });
    send({ utteranceId: "native-1", text: "Atlas", final: true });
    send({ utteranceId: "native-1", text: "Atlas", final: true });
    send({ utteranceId: "native-2", text: "bu öneriyi", final: true });
    expect(finalEvents(events)).toEqual([]);
    await end(recognizer); expect(finishes()).toHaveLength(1);
    expect(finalEvents(events)).toEqual([]);
    send({ utteranceId: "native-3", boundaryId: finishes()[0]![1].boundaryId, text: "değerlendirir misin?", final: true });
    expect(finalEvents(events)).toMatchObject([{ text: "Atlas bu öneriyi değerlendirir misin?", utteranceId: finishes()[0]![1].boundaryId }]);
    recognizer.stop();
  });
  it("deduplicates native finals while retaining equal repeated human questions as distinct turns", async () => {
    const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
    await recognizer.start(["Nova"]);
    for (let i = 0; i < 2; i++) {
      recognizer.append(speech, 48000, true); await end(recognizer);
      const event = { utteranceId: `native-${i}`, text: "Nova nasılsın?", final: true, boundaryId: finishes()[i]![1].boundaryId };
      send(event); send(event);
    }
    expect(finalEvents(events).map(event => event.text)).toEqual(["Nova nasılsın?", "Nova nasılsın?"]);
    expect(new Set(finalEvents(events).map(event => event.utteranceId)).size).toBe(2);
    recognizer.stop();
  });
  it("does not answer an older question when new speech begins during its finalization", async () => {
    const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
    await recognizer.start(["Atlas", "Nova"]);
    recognizer.append(speech, 48000, true); await end(recognizer);
    const firstBoundary = finishes()[0]![1].boundaryId;
    recognizer.append(speech, 48000, true); await flush();
    send({ utteranceId: "first-native", boundaryId: firstBoundary, text: "Atlas cevapla", final: true });
    expect(finalEvents(events)).toMatchObject([{ text: "Atlas cevapla", respond: false }]);
    await end(recognizer);
    send({ utteranceId: "second-native", boundaryId: finishes()[1]![1].boundaryId, text: "Nova sen cevapla", final: true });
    expect(finalEvents(events).filter(event => event.respond !== false)).toMatchObject([{ text: "Nova sen cevapla" }]); recognizer.stop();
  });
  it("accepts an empty boundary acknowledgement after a natural final without losing its text", async () => {
    const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
    await recognizer.start(["Atlas"]); recognizer.append(speech, 48000, true);
    send({ utteranceId: "natural", text: "Atlas soru", final: true });
    await end(recognizer);
    send({ utteranceId: "empty-request", boundaryId: finishes()[0]![1].boundaryId, text: "", final: true });
    expect(finalEvents(events)).toMatchObject([{ text: "Atlas soru" }]); recognizer.stop();
  });
  it("serializes audio before finish and ignores old callbacks after a restart", async () => {
    const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
    let release!: () => void;
    mock.invoke.mockImplementation(async method => { if (method === "meeting_speech_append") await new Promise<void>(resolve => { release = resolve; }); });
    await recognizer.start(["Atlas"]); recognizer.append(speech, 48000, true); await flush();
    await end(recognizer); expect(finishes()).toEqual([]);
    recognizer.stop(); await recognizer.start(["Nova"]);
    send({ type: "error", error: "old failure" }, 0); release(); await flush();
    expect(events).toEqual([]);
    mock.invoke.mockResolvedValue(undefined);
    recognizer.append(speech, 48000, true); await end(recognizer);
    expect(finishes()).toHaveLength(1);
    expect(mock.invoke.mock.calls.filter(([method]) => method === "meeting_speech_append").every(([, args]) => args.samples.length <= 4096)).toBe(true);
    recognizer.stop();
  });
  it("fails closed on backlog overflow and does not send queued audio after stopping", async () => {
    const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
    mock.invoke.mockImplementation(method => method === "meeting_speech_append" ? new Promise(() => {}) : Promise.resolve());
    await recognizer.start(["Atlas"]);
    for (let i = 0; i < 25; i++) recognizer.append(speech, 48000, true);
    await flush();
    expect(events).toMatchObject([{ type: "error", error: expect.stringContaining("could not keep up") }]);
    expect(mock.invoke.mock.calls.some(([method]) => method === "meeting_speech_finish")).toBe(false);
    expect(mock.invoke.mock.calls.some(([method]) => method === "meeting_speech_stop")).toBe(true);
  });
  it("rejects unidentified finals, invalid PCM and mismatched native boundaries", async () => {
    for (const fault of ["missing-id", "audio", "boundary"]) {
      const events: MeetingSpeechEvent[] = []; const recognizer = new MeetingSpeech(event => events.push(event));
      await recognizer.start(["Atlas"]); recognizer.append(speech, 48000, true);
      if (fault === "missing-id") send({ text: "question", final: true });
      if (fault === "audio") recognizer.append(new Float32Array([NaN]), 48000, true);
      if (fault === "boundary") {
        await end(recognizer); recognizer.append(speech, 48000, true); await end(recognizer);
        send({ utteranceId: "wrong-order", text: "question", final: true, boundaryId: finishes().at(-1)![1].boundaryId });
      }
      expect(events.at(-1)?.type).toBe("error"); expect(finalEvents(events)).toEqual([]); recognizer.stop();
    }
  });
});
