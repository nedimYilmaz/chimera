import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), connected: vi.fn(), audio: [] as any[], speech: [] as any[], voices: [] as any[], privateJoin: vi.fn(),
}));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: mocks.rpc }));
vi.mock("../src/voice/nativeCodex", () => ({ nativeCodexVoice: { join: mocks.privateJoin, getAgentState: () => ({ status: "idle" }) }, createMeetingVoice: (id: string) => {
  let state: any = { status: "idle" }; const listeners = new Set<() => void>();
  const voice = { id, getState: () => state, notify: (next: any) => { state = next; listeners.forEach(fn => fn()); }, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, start: vi.fn(async (agentId: string) => { state = { status: "listening", agentId }; listeners.forEach(fn => fn()); }), stop: vi.fn(() => { state = { status: "idle" }; listeners.forEach(fn => fn()); }), interruptPlayback: vi.fn(), setListeningOnly: vi.fn(async () => {}) };
  Object.assign(voice, { waitUntilConnected: mocks.connected, stopAndWait: vi.fn(async () => { if (state.status === "listening" || state.status === "connecting") voice.stop(); return []; }) });
  mocks.voices.push(voice); return voice;
} }));
vi.mock("../src/voice/meetingAudio", () => ({ MeetingAudio: class {
  floor = { speaker: null, hasPendingAudio: false, waiting: () => [] }; prepare = vi.fn(async () => {}); input = () => ({}); capture = () => () => {};
  setMicrophone = vi.fn(async (enabled: boolean) => enabled); setSpeaker = vi.fn(async () => {}); setPaused = vi.fn(); focus = vi.fn(); close = vi.fn();
  setParticipantListening = vi.fn(); setRecipient = vi.fn();
  addParticipant = vi.fn(); setMaxTurns = vi.fn();
  setParticipantMuted = vi.fn(); removeParticipant = vi.fn(); renewInput = vi.fn(() => ({}));
  operatorTurn: (interrupted?: boolean) => void;
  constructor(...args: any[]) { this.operatorTurn = args[6]; mocks.audio.push(this); }
} }));
vi.mock("../src/voice/meetingSpeech", () => ({ MeetingSpeech: class {
  start = vi.fn(async () => {}); stop = vi.fn(); append = vi.fn();
  constructor(public notify: (event: any) => void) { mocks.speech.push(this); }
} }));
import { MeetingHost } from "../src/voice/meetingHost";
import type { VoiceRoom } from "@chimera/protocol/voice-rooms";
const room = (id = "one"): VoiceRoom => ({ id, revision: 1, ownerAgentId: null, createdAt: 0, expiresAt: null, reason: null, state: "pending", name: "Review", agenda: "review", agentIds: ["a", "b"], participants: [{ agentId: "a", name: "Codex", role: "conductor", state: "running" }, { agentId: "b", name: "Atlas", role: "agent", state: "running" }], durationMinutes: 10, maxUtterances: 20 });
let host: MeetingHost;
beforeEach(() => { vi.useFakeTimers(); mocks.audio.length = 0; mocks.speech.length = 0; mocks.connected.mockImplementation(async () => {}); mocks.voices.length = 0; mocks.rpc.mockImplementation(async (_method, p) => {
  if (_method === "voice.room.plan") {
    const selected = p.input.stage === "initial" ? (p.input.topic.includes("Atlas") ? "b" : "a") : p.input.candidates.find((id: string) => !p.input.spoken.includes(id));
    return { action: selected ? "speak" : "wait", agentId: selected ?? null, discussion: p.input.stage === "followup", topic: p.input.topic, contribution: "Add a relevant point", reason: "Test plan" };
  }
  return { ...room(p.roomId), state: "active" };
}); host = new MeetingHost(); });
afterEach(() => { host.stopAll(); vi.clearAllMocks(); vi.useRealTimers(); });
describe("app-owned meeting media", () => {
  it("a conversational invitation schedules relevant peers, revisits a speaker and finishes on planner wait", async () => {
    const base = mocks.rpc.getMockImplementation()!; const plans = ["b", "a", "b", null];
    mocks.rpc.mockImplementation(async (method, p) => method === "voice.room.plan" ? { action: plans[0] ? "speak" : "wait", agentId: plans.shift(), discussion: true, topic: "Audio latency", contribution: "React to the preceding argument", reason: "Relevant new knowledge" } : base(method, p));
    await host.start(room()); await host.join("one"); host.submitText("one", "Bir sohbet başlatın ve konuşun"); await flush();
    expect(host.getState()[0]!.discussion).toBe(true);
    for (const [i, id] of ["b", "a", "b"].entries()) {
      const voice = mocks.voices.at(-1); expect(voice.start).toHaveBeenCalledWith(id, true);
      const envelope = JSON.parse(textCalls().at(-1)[1].text.split("\n")[1]);
      expect(envelope).toMatchObject({ mode: "discussion", contributionPurpose: "React to the preceding argument" });
      if (i) expect(envelope.earlierConversation).toEqual(expect.arrayContaining([expect.objectContaining({ text: `point-${i - 1}` })]));
      voice.notify({ status: "listening", messages: [{ sessionId: voice.id, id: `answer-${i}`, role: "assistant", text: `point-${i}`, final: true, ts: Date.now() }] });
      await vi.advanceTimersByTimeAsync(1000); await flush();
    }
    expect(textCalls()).toHaveLength(3); expect(host.getState()[0]!.discussion).toBe(false);
    expect(mocks.rpc.mock.calls.some(([method]) => method.startsWith("agent."))).toBe(false);
  });
  it.each(["speech", "leave", "disabled", "manual"])("discards a delayed selection after %s", async action => {
    const base = mocks.rpc.getMockImplementation()!; let resolve!: (value: any) => void;
    mocks.rpc.mockImplementation(async (method, p) => method === "voice.room.plan" ? new Promise(r => { resolve = r; }) : base(method, p));
    await host.start(room()); await host.join("one"); host.submitText("one", "Discuss this"); await flush();
    if (action === "speech") mocks.audio[0].operatorTurn(true);
    if (action === "leave") host.leave();
    if (action === "disabled") host.setAutoParticipation("one", false);
    if (action === "manual") host.chooseRecipient("one", "a");
    await flush(); const count = textCalls().length;
    expect(mocks.rpc).toHaveBeenCalledWith("voice.room.cancelPlan", expect.objectContaining({ requestId: expect.any(String) }));
    resolve({ action: "speak", agentId: "b", discussion: true, topic: "Old topic", contribution: "stale", reason: "stale" }); await flush();
    expect(textCalls()).toHaveLength(count); expect(host.getState()[0]!.discussion).toBe(false);
  });
  it("never grants a listener a planner-selected turn", async () => {
    const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (method, p) => method === "voice.room.plan" ? { action: "speak", agentId: "b", discussion: true, topic: "Topic", contribution: "Wrong seat", reason: "Invalid plan" } : base(method, p));
    await host.start(room()); await host.join("one"); await host.setListener("one", "b", true);
    host.submitText("one", "Atlas soru"); await flush();
    expect(textCalls()).toHaveLength(0);
    expect(mocks.rpc.mock.calls.find(([method]) => method === "voice.room.plan")![1].input.candidates).toEqual(["a"]);
  });
  it("joins with audible playback while keeping microphone capture off", async () => {
    await host.start(room()); await host.join("one");
    expect(host.getState()[0]).toMatchObject({ joined: true, speakerEnabled: true, microphone: false });
    expect(mocks.audio[0].setSpeaker).toHaveBeenCalledWith(true);
    expect(mocks.speech[0].start).not.toHaveBeenCalled();
  });
  it("finishes discussion after each eligible seat speaks once", async () => {
    await host.start(room()); await host.join("one"); host.submitText("one", "Plan"); await flush();
    host.startDiscussion("one"); await flush();
    const before = textCalls().length;
    for (const id of ["first", "second"]) {
      const voice = mocks.voices.at(-1);
      voice.notify({ status: "listening", messages: [{ sessionId: voice.id, id, role: "assistant", text: id, final: true, ts: Date.now() }] });
      await vi.advanceTimersByTimeAsync(1000); await flush();
    }
    expect(host.getState()[0]!.discussion).toBe(false);
    expect(textCalls()).toHaveLength(before + 1);
    await vi.advanceTimersByTimeAsync(5000); expect(textCalls()).toHaveLength(before + 1);
  });

  it("keeps partial speech visible without starting a response", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    mocks.speech[0].notify({ type: "transcript", text: "Atlas", final: false });
    expect(host.getState()[0]!.draftTranscript).toBe("Atlas"); expect(textCalls()).toHaveLength(0);
  });
  it("routes typed questions without microphone capture and gives a named seat explicit turn authority", async () => {
    await host.start(room());
    expect(() => host.submitText("one", "Atlas soru")).toThrow("Join");
    await host.join("one"); host.submitText("one", "Atlas soru"); await flush();
    expect(mocks.speech[0].start).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(1);
    const payload = JSON.parse(textCalls()[0][1].text.split("\n")[1]);
    expect(payload).toMatchObject({ selectedSpeaker: { agentId: "b", name: "Atlas" }, mode: "direct", currentOperatorQuestion: "Atlas soru" });
  });
  it("attributes a speech interruption to the exact selected session without logging conversation text", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    await question("Atlas secret-question"); const voice = mocks.voices.at(-1);
    mocks.audio[0].operatorTurn(true); await flush();
    const stops = mocks.rpc.mock.calls.filter(([method, p]) => method === "voice.room.report" && p.diagnostic.event === "voice-stop-requested").map(([, p]) => p.diagnostic);
    expect(stops).toEqual([expect.objectContaining({ code: "operator-speech", agentId: "b", sessionId: voice.id })]);
    expect(JSON.stringify(stops)).not.toContain("secret-question");
    expect(voice.stop).toHaveBeenCalled();
  });
  it("reuses a completed drained response for the next question to the same agent", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    await question("Atlas soru", "first"); const voice = mocks.voices.at(-1);
    voice.notify({ status: "listening", messages: [{ sessionId: voice.id, id: "answer", role: "assistant", text: "Karar mavi.", final: true, ts: Date.now() }] });
    mocks.audio[0].operatorTurn(false);
    mocks.speech[0].notify({ type: "transcript", sessionId: "speech", utteranceId: "second", text: "Atlas neden?", final: true }); await flush();
    expect(textCalls()).toHaveLength(2); expect(textCalls()[1][1].sessionId).toBe(voice.id);
    expect(voice.start).toHaveBeenCalledOnce(); expect(voice.stop).not.toHaveBeenCalled();
    expect(textCalls()[1][1].text).toContain("Karar mavi.");
  });
  it("runs one operator-authorized discussion round with peer context and stops on new human input", async () => {
    await host.start(room()); await host.join("one"); host.submitText("one", "Planı değerlendirelim"); await flush();
    host.startDiscussion("one"); await flush();
    const first = mocks.voices.at(-1);
    first.notify({ status: "listening", messages: [{ sessionId: first.id, id: "discuss", role: "assistant", text: "Önce gecikmeyi ölçelim.", final: true, ts: Date.now() }] });
    mocks.audio[0].floor.hasPendingAudio = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.voices.at(-1)).toBe(first);
    mocks.audio[0].floor.hasPendingAudio = false;
    await vi.advanceTimersByTimeAsync(250); await flush();
    expect(textCalls().at(-1)[1].text).toContain("Önce gecikmeyi ölçelim.");
    expect(JSON.parse(textCalls().at(-1)[1].text.split("\n")[1])).toMatchObject({ selectedSpeaker: { agentId: "b" }, mode: "discussion" });
    host.submitText("one", "Dur, benim sorum var"); await flush();
    expect(host.getState()[0]!.discussion).toBe(false);
    const count = textCalls().length; await vi.advanceTimersByTimeAsync(5000); expect(textCalls()).toHaveLength(count);
  });

  it.each(["speech", "capture"])("recognition error invalidates pending %s enable and allows an explicit retry", async phase => {
    await host.start(room()); await host.join("one");
    let complete!: (value?: any) => void;
    const pending = new Promise(resolve => { complete = resolve; });
    if (phase === "speech") mocks.speech[0].start.mockReturnValueOnce(pending);
    else mocks.audio[0].setMicrophone.mockImplementationOnce(() => pending);
    const enable = host.setMicrophone("one", true);
    await flush();
    mocks.speech[0].notify({ type: "error", error: "On-device speech recognition failed: Siri and Dictation are disabled" });
    expect(host.getState()[0]).toMatchObject({ microphone: false, micPending: false });
    expect(host.getState()[0]!.routingNote).toContain("Dictation");
    const captureCalls = mocks.audio[0].setMicrophone.mock.calls.length;
    complete(true); await enable; await flush();
    expect(mocks.audio[0].setMicrophone.mock.calls).toHaveLength(captureCalls);
    expect(host.getState()[0]).toMatchObject({ microphone: false, micPending: false });
    expect(mocks.rpc.mock.calls.some(([method, args]) => method === "voice.room.report" && args.diagnostic.event === "enabled")).toBe(false);
    await host.setMicrophone("one", true);
    expect(host.getState()[0]).toMatchObject({ microphone: true, micPending: false, routingNote: undefined });
  });

  it("deduplicates repeated finals within their native session while preserving session attribution", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    await question("Atlas soru", "one"); const first = mocks.voices.at(-1);
    const message = { id: "same-message-id", sessionId: first.id, role: "assistant", final: true, text: "Atlas yanıt", ts: Date.now() };
    first.notify({ status: "listening", messages: [message, message] });
    await question("Yeni soru", "two"); const second = mocks.voices.at(-1);
    second.notify({ status: "listening", messages: [{ ...message, sessionId: second.id, text: "Codex yanıt" }] });
    expect(host.getState()[0]!.context.filter(line => line.id === message.id)).toMatchObject([
      { sessionId: first.id, speaker: "b", text: "Atlas yanıt" },
      { sessionId: second.id, speaker: "a", text: "Codex yanıt" },
    ]);
  });
  it("retains final messages returned while changing a responder to a listener", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    await question("Atlas fikrin?", "first");
    const active = mocks.voices.at(-1);
    const polled = { id: "already-polled", role: "assistant", final: true, text: "Ön karar.", ts: Date.now() };
    const final = { id: "listener-final", role: "assistant", final: true, text: "Son karar mavi.", ts: Date.now() };
    active.notify({ status: "listening", messages: [polled] });
    let acknowledge!: (messages: unknown[]) => void;
    active.stopAndWait.mockImplementationOnce(() => {
      active.stop();
      return new Promise(resolve => { acknowledge = resolve; });
    });
    const toggling = host.setListener("one", "b", true);
    expect(host.getState()[0]!.participants.b!.pending).toBe(true);
    acknowledge([polled, final, final]); await toggling;
    expect(host.getState()[0]!.context.filter(line => line.id === "listener-final")).toMatchObject([{ id: final.id, speaker: "b", text: final.text }]);
    expect(host.getState()[0]!.context.filter(line => line.id === polled.id)).toHaveLength(1);
    await question("Karar neydi?", "second");
    expect(textCalls().at(-1)[1].text).toContain("Son karar mavi.");
    expect(mocks.voices.at(-1).start).toHaveBeenCalledWith("a", true);
    expect(textCalls().at(-1)[1].sessionId).not.toBe(active.id);
  });
  it.each(["microphone", "leave", "recognition-error"])("cancels a connecting responder immediately on %s", async action => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    let ready!: () => void;
    mocks.connected.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    await question("Atlas soru");
    const active = mocks.voices.at(-1);
    active.notify({ status: "connecting", agentId: "b" });
    if (action === "microphone") await host.setMicrophone("one", false);
    if (action === "leave") host.leave();
    if (action === "recognition-error") mocks.speech[0].notify({ type: "error", error: "Recognition lost" });
    try {
      expect(active.stop).toHaveBeenCalledOnce();
      const reason = { microphone: "microphone-off", leave: "operator-leave", "recognition-error": "speech-recognition-error" }[action];
      expect(mocks.rpc).toHaveBeenCalledWith("voice.room.report", expect.objectContaining({ diagnostic: expect.objectContaining({
        event: "voice-stop-requested", agentId: "b", sessionId: active.id, code: reason,
      }) }));
      expect(textCalls()).toHaveLength(0);
    } finally { ready(); await flush(); }
    expect(textCalls()).toHaveLength(0);
    expect(mocks.rpc.mock.calls.some(([method]) => method.startsWith("agent."))).toBe(false);
  });
  it("mic-off cancellation leaves another room's seat and coding agents untouched", async () => {
    await host.start(room()); await host.start({ ...room("two"), agentIds: ["c", "d"] });
    await host.join("one"); await host.setMicrophone("one", true); await flush();
    const unrelated = mocks.voices[2]; unrelated.notify({ status: "listening", agentId: "c" });
    let ready!: () => void;
    mocks.connected.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    await question("Atlas soru"); const selected = mocks.voices.at(-1);
    await host.setMicrophone("one", false);
    expect(selected.stop).toHaveBeenCalledOnce();
    ready(); await flush();
    expect(unrelated.stop).not.toHaveBeenCalled();
    expect(mocks.audio[1].close).not.toHaveBeenCalled();
    expect(textCalls()).toHaveLength(0);
    expect(mocks.rpc.mock.calls.some(([method]) => method.startsWith("agent."))).toBe(false);
  });
  it("opens no provider session until a finalized local question addresses one seat", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    expect(mocks.voices.every(v => !v.start.mock.calls.length)).toBe(true);
    expect(textCalls()).toHaveLength(0);
    mocks.speech[0].notify({ type: "transcript", text: "Atlas", final: false });
    await flush(); expect(textCalls()).toHaveLength(0);
    await question("Atlas, bu nasıl çalışıyor?");
    expect(mocks.voices.filter(v => v.start.mock.calls.length).map(v => v.start.mock.calls[0][0])).toEqual(["b"]);
    expect(textCalls()).toHaveLength(1);
    expect(textCalls()[0][1]).toMatchObject({ sessionId: mocks.voices.at(-1).id, role: "user", text: expect.stringContaining("Atlas, bu nasıl çalışıyor?") });
    mocks.speech[0].notify({ type: "transcript", sessionId: "speech", utteranceId: "same", text: "Atlas, bu nasıl çalışıyor?", final: true });
    await flush(); expect(textCalls()).toHaveLength(1);
    expect(mocks.rpc.mock.calls.some(([m]) => m === "agent.send")).toBe(false);
  });
  it("waits for the old provider to stop before starting the conductor for a generic question", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    await question("Atlas fikrin ne?");
    let stopped!: () => void;
    const old = mocks.voices.at(-1);
    old.stopAndWait.mockImplementationOnce(() => new Promise<any[]>(resolve => { stopped = () => { old.stop(); resolve([]); }; }));
    mocks.audio[0].operatorTurn();
    mocks.speech[0].notify({ type: "transcript", text: "Ne durumdayız?", final: true });
    await flush();
    expect(textCalls()).toHaveLength(1); expect(mocks.voices.filter(v => v.start.mock.calls.length)).toHaveLength(1);
    stopped(); await flush();
    expect(textCalls()).toHaveLength(2); expect(mocks.voices.at(-1).start).toHaveBeenCalledWith("a", true);
  });
  it("sends nothing before RTC readiness and rejects a stale question after navigation", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    let ready!: () => void;
    mocks.connected.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    await question("Atlas soru"); expect(textCalls()).toHaveLength(0);
    ready(); await flush(); expect(textCalls()).toHaveLength(1);
    mocks.connected.mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    await question("Codex ikinci soru", "second"); expect(textCalls()).toHaveLength(1);
    host.leave(); ready(); await flush(); expect(textCalls()).toHaveLength(1);
  });
  it("keeps superseded human text and unpolled agent answers without generating extra responses", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    mocks.speech[0].notify({ type: "transcript", sessionId: "speech", utteranceId: "superseded", text: "Önceki sorum", final: true, respond: false });
    await flush(); expect(textCalls()).toHaveLength(0);
    await question("Atlas fikrin?", "first");
    mocks.voices.at(-1).stopAndWait.mockResolvedValueOnce([{ id: "unpolled", role: "assistant", final: true, text: "Yeni karar", ts: Date.now() }]);
    await question("Ne karardı?", "second");
    expect(textCalls()).toHaveLength(2);
    expect(textCalls().at(-1)[1].text).toContain("Yeni karar"); expect(textCalls().at(-1)[1].text).toContain("Önceki sorum");
  });
  it("retains human and assistant context for listeners without starting them, and supplies it on activation", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    await host.setListener("one", "b", true);
    await question("Ne karar verdik?");
    mocks.voices.at(-1).notify({ status: "listening", messages: [{ id: "answer", role: "assistant", final: true, text: "Mavi seçildi.", ts: Date.now() }] });
    await question("Atlas hatırlıyor musun?", "second");
    expect(textCalls()).toHaveLength(1);
    expect(host.getState()[0]!.context.map(c => c.text)).toEqual(["Ne karar verdik?", "Mavi seçildi.", "Atlas hatırlıyor musun?"]);
    await host.setListener("one", "b", false); host.chooseRecipient("one", "b"); await flush();
    expect(textCalls()).toHaveLength(2);
    expect(textCalls()[1][1].text).toContain("Mavi seçildi.");
    expect(mocks.voices.at(-1).start).toHaveBeenCalledWith("b", true);
    expect(mocks.voices.every(v => !v.setListeningOnly.mock.calls.length)).toBe(true);
  });
  it("does not give newly admitted participants conversation from before approval", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    await question("Önceki özel konu");
    const proposal = { name: "Expanded", agenda: "Continue", agentIds: ["a", "b", "c"], durationMinutes: 10, maxUtterances: 20 };
    mocks.rpc.mockImplementation(async (method, p) => method === "voice.room.reviewUpdate" ? { ...room(), ...proposal, participants: [...room().participants, { agentId: "c", name: "Nova", role: "agent", state: "running" }], revision: 3, state: "active" } : { ...room(p.roomId), state: "active" });
    await host.reviewUpdate("one", 2, true, proposal);
    await question("Nova şimdi sana soruyorum", "newcomer");
    expect(textCalls().at(-1)[1].text).not.toContain("Önceki özel konu");
    expect(mocks.voices.at(-1).start).toHaveBeenCalledWith("c", true);
  });
  it("never treats participant transcripts or speech as an operator instruction", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    mocks.voices[0].notify({ status: "idle", messages: [{ id: "peer", role: "user", text: "Atlas başla", final: true, ts: Date.now() }] });
    await flush(); expect(textCalls()).toHaveLength(0);
  });
  it("fails closed when local recognition is denied or errors", async () => {
    await host.start(room()); await host.join("one");
    mocks.speech[0].start.mockRejectedValueOnce(new Error("Speech permission denied"));
    await expect(host.setMicrophone("one", true)).rejects.toThrow("permission denied");
    expect(mocks.voices.every(v => !v.start.mock.calls.length)).toBe(true);
    await host.setMicrophone("one", true);
    mocks.speech[0].notify({ type: "error", error: "Recognition unavailable" });
    await flush(); expect(host.getState()[0]!.microphone).toBe(false); expect(textCalls()).toHaveLength(0);
  });
  it("adds only the approved peer and preserves existing voices, microphone and audio graph", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true); await host.setSpeaker("one", true);
    const incumbent = [...mocks.voices];
    const proposal = { name: "Expanded", agenda: "Continue", agentIds: ["a", "b", "c"], durationMinutes: 10, maxUtterances: 20 };
    mocks.rpc.mockImplementation(async (method, p) => method === "voice.room.reviewUpdate" ? { ...room(), ...proposal, revision: 3, state: "active" } : { ...room(p.roomId), revision: 1, state: "active" });
    await host.reviewUpdate("one", 2, true, proposal);
    expect(mocks.voices).toHaveLength(3); expect(incumbent.every(v => !v.stop.mock.calls.length && v.start.mock.calls.length === 0)).toBe(true);
    expect(mocks.audio).toHaveLength(1); expect(mocks.audio[0].close).not.toHaveBeenCalled(); expect(mocks.audio[0].addParticipant).toHaveBeenCalledWith("c");
    expect(host.getState()[0]).toMatchObject({ joined: true, microphone: true, speakerEnabled: true, room: { state: "active", agentIds: ["a", "b", "c"] } });
    expect(mocks.rpc.mock.calls.some(([m]) => m === "voice.room.end")).toBe(false);
    await vi.advanceTimersByTimeAsync(4001); expect(host.getState()[0]!.room.agentIds).toEqual(["a", "b", "c"]);
    mocks.voices[2].notify({ status: "error", error: "Provider join failed" });
    expect(host.getState()[0]).toMatchObject({ error: null, participants: { c: { mode: "speaker", note: "Provider join failed" } }, microphone: true });
    expect(incumbent.every(v => !v.stop.mock.calls.length)).toBe(true);
  });
  it("does not let expected departure during approval close the remaining meeting", async () => {
    await host.start(room()); const survivor = mocks.voices[1];
    const proposal = { name: "Review", agenda: "Continue", agentIds: ["b", "c"], durationMinutes: 10, maxUtterances: 20 };
    mocks.rpc.mockImplementation(async method => {
      if (method === "voice.room.reviewUpdate") { mocks.voices[0].notify({ status: "idle" }); return { ...room(), ...proposal, state: "active", revision: 3 }; }
      return {};
    });
    await host.reviewUpdate("one", 2, true, proposal);
    expect(survivor.stop).not.toHaveBeenCalled(); expect(mocks.audio[0].removeParticipant).toHaveBeenCalledWith("a");
    expect(host.getState()[0]!.room.state).toBe("active"); expect(mocks.rpc.mock.calls.some(([m]) => m === "voice.room.end")).toBe(false);
  });
  it("retains a failed response in the room without ending other seats", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    mocks.voices[0].notify({ status: "error", agentId: "a", error: "Native voice event channel closed" });
    expect(host.getState()[0]).toMatchObject({ error: null, room: { state: "active" }, participants: { a: { note: "Native voice event channel closed" } } });
    expect(mocks.rpc.mock.calls.some(([m]) => m === "voice.room.end")).toBe(false);
  });
  it("distinguishes app shutdown from a microphone permission failure", async () => {
    await host.start(room()); await host.join("one");
    mocks.audio[0].setMicrophone.mockRejectedValueOnce(new Error("permission denied"));
    await expect(host.setMicrophone("one", true)).rejects.toThrow("permission denied");
    expect(mocks.rpc).toHaveBeenCalledWith("voice.room.report", expect.objectContaining({ diagnostic: { source: "microphone", event: "enable-failed", message: "Error: permission denied" } }));
    expect(mocks.rpc.mock.calls.some(([method]) => method === "voice.room.end")).toBe(false);
    host.stopAll("pagehide");
    expect(mocks.rpc).toHaveBeenCalledWith("voice.room.end", { roomId: "one", source: "pagehide" });
  });
  it("making a speaker a listener stops native voice and enabling it waits for a new question", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true); await question("Atlas selam");
    const active = mocks.voices.at(-1);
    await host.setListener("one", "b", true); expect(active.stop).toHaveBeenCalledOnce();
    await host.setListener("one", "b", false);
    expect(textCalls()).toHaveLength(1); expect(host.getState()[0]!.participants.b!.mode).toBe("speaker");
  });
  it("removes just one participant while keeping the room, mic and other voices alive", async () => {
    await host.start(room()); await host.join("one"); await host.setMicrophone("one", true);
    mocks.rpc.mockImplementation(async (method, p) => method === "voice.room.removeParticipant" ? { ...room(), state: "active", revision: 2, agentIds: ["b"] } : { ...room(p.roomId), state: "active" });
    await host.removeParticipant("one", "a");
    expect(mocks.voices[0].stop).toHaveBeenCalledOnce(); expect(mocks.voices[1].stop).not.toHaveBeenCalled();
    expect(mocks.audio[0].removeParticipant).toHaveBeenCalledWith("a"); expect(mocks.audio[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4001); // stale heartbeat cannot restore the old roster.
    expect(host.getState()[0]).toMatchObject({ room: { agentIds: ["b"], revision: 2 }, joined: true, microphone: true, error: null });
  });
  it("restores the local speaking gate if removal fails instead of pretending the participant left", async () => {
    await host.start(room()); mocks.rpc.mockRejectedValueOnce(new Error("changed"));
    await expect(host.removeParticipant("one", "a")).rejects.toThrow("changed");
    expect(host.getState()[0]!.room.agentIds).toEqual(["a", "b"]); expect(mocks.audio[0].setParticipantMuted).toHaveBeenLastCalledWith("a", false);
    expect(mocks.voices[0].stop).not.toHaveBeenCalled();
  });
  it("starts without a microphone, leaves only the human seat, and continues heartbeating", async () => {
    await host.start(room()); expect(mocks.audio[0].setMicrophone).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "voice.native.text")).toHaveLength(0);
    host.observe("one"); await host.setSpeaker("one", true);
    expect(host.getState()[0]).toMatchObject({ observing: true, joined: false, speakerEnabled: true, microphone: false });
    await expect(host.setMicrophone("one", true)).rejects.toThrow("Join the meeting");
    await host.join("one"); expect(mocks.audio[0].setMicrophone).not.toHaveBeenCalled();
    expect(host.getState()[0]).toMatchObject({ joined: true, speakerEnabled: true, microphone: false });
    await host.setMicrophone("one", true);
    host.leave(); expect(mocks.audio[0].focus).toHaveBeenLastCalledWith(false);
    expect(mocks.audio[0].close).not.toHaveBeenCalled(); expect(mocks.voices.every(v => v.stop.mock.calls.length === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.rpc.mock.calls.filter(([method]) => method === "voice.room.heartbeat").length).toBeGreaterThan(1);
  });
  it("switches rooms without ending either and stops only an explicitly ended room", async () => {
    await host.start(room()); await host.start({ ...room("two"), agentIds: ["c", "d"] });
    await host.join("one"); await host.join("two");
    expect(mocks.audio[0].focus).toHaveBeenLastCalledWith(false);
    expect(host.getState()[1]).toMatchObject({ joined: true, microphone: false, speakerEnabled: true });
    host.end("one"); expect(mocks.audio[0].close).toHaveBeenCalledOnce(); expect(mocks.audio[1].close).not.toHaveBeenCalled();
  });
  it("a late microphone grant after navigation cannot rejoin the human", async () => {
    await host.start(room()); await host.join("one"); let grant!: (enabled: boolean) => void;
    mocks.audio[0].setMicrophone.mockImplementation(() => new Promise<boolean>(resolve => { grant = resolve; }));
    const joining = host.setMicrophone("one", true); await flush(); host.leave(); grant(true); await joining;
    expect(mocks.audio[0].focus).toHaveBeenLastCalledWith(false); expect(host.getState()[0]?.joined).toBe(false);
    expect(host.getState()[0]).toMatchObject({ microphone: false, micPending: false });
  });
  it("keeps mic and speaker independent and pauses only audio", async () => {
    await host.start(room()); await host.join("one"); await host.setSpeaker("one", false); await host.setMicrophone("one", true);
    expect(host.getState()[0]).toMatchObject({ microphone: true, speakerEnabled: false });
    host.setPaused("one", true); expect(mocks.audio[0].setPaused).toHaveBeenLastCalledWith(true);
    expect(mocks.voices.every(v => v.stop.mock.calls.length === 0)).toBe(true);
    host.observe("one"); expect(host.getState()[0]).toMatchObject({ joined: false, observing: true, microphone: false, paused: true });
    host.setPaused("one", false); expect(mocks.audio[0].setPaused).toHaveBeenLastCalledWith(false);
  });
  it("microphone denial leaves a joined observer able to listen", async () => {
    await host.start(room()); await host.join("one"); await host.setSpeaker("one", true);
    mocks.audio[0].setMicrophone.mockRejectedValueOnce(new Error("denied"));
    await expect(host.setMicrophone("one", true)).rejects.toThrow("denied");
    expect(host.getState()[0]).toMatchObject({ joined: true, microphone: false, micPending: false, speakerEnabled: true });
    expect(mocks.audio[0].close).not.toHaveBeenCalled();
  });
  it("a late approval after app shutdown cannot create new audio", async () => {
    let approve!: (value: VoiceRoom) => void;
    mocks.rpc.mockImplementation((method: string) => method === "voice.room.approve" ? new Promise<VoiceRoom>(resolve => { approve = resolve; }) : Promise.resolve({}));
    const starting = host.start(room()); host.stopAll(); approve({ ...room(), state: "active" }); await starting;
    expect(mocks.audio).toHaveLength(0); expect(mocks.voices).toHaveLength(0);
    expect(mocks.rpc).toHaveBeenCalledWith("voice.room.end", { roomId: "one", source: "start-cancelled", reason: "Desktop closed while meeting approval was pending" });
  });
  it("closes media on a revoked lease without trying to kill or pause coding agents", async () => {
    await host.start(room()); mocks.rpc.mockImplementation(async (method: string) => { if (method === "voice.room.heartbeat") throw new Error("expired"); return {}; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.audio[0].close).toHaveBeenCalledOnce(); expect(host.getState()[0]?.error).toContain("expired");
    expect(mocks.rpc.mock.calls.some(([m]) => m === "agent.kill" || m === "agent.hold")).toBe(false);
  });
});

const textCalls = () => mocks.rpc.mock.calls.filter(([m]) => m === "voice.native.text");
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function question(text: string, utteranceId = "same") {
  mocks.audio[0].operatorTurn();
  mocks.speech[0].notify({ type: "transcript", sessionId: "speech", utteranceId, text, final: true });
  await flush();
}
