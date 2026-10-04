import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeetingAudio } from "../src/voice/meetingAudio";

const track = () => ({ enabled: true, stop: vi.fn() });
const stream = () => { const audio = track(); return { getTracks: () => [audio], getAudioTracks: () => [audio] }; };
const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } });
let rooms: MeetingAudio[];
let mic: ReturnType<typeof vi.fn>;
let players: any[];
let meters: any[];
beforeEach(() => {
  rooms = []; players = []; meters = []; mic = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: mic } });
  vi.stubGlobal("AudioWorkletNode", class {
    connect = vi.fn(); disconnect = vi.fn(); port = { onmessage: null as any, close: vi.fn() };
    constructor() { meters.push(this); }
  });
  vi.stubGlobal("AudioContext", class {
    currentTime = 0; sampleRate = 48000; destination = node();
    audioWorklet = { addModule: vi.fn(async () => {}) };
    resume = vi.fn(async () => {}); close = vi.fn(async () => {});
    createGain = node;
    createMediaStreamDestination = () => ({ ...node(), stream: stream() });
    createMediaStreamSource = node;
    createBuffer = () => ({ copyToChannel: vi.fn() });
    createBufferSource = () => { const source = { ...node(), start: vi.fn(), stop: vi.fn(), onended: null }; players.push(source); return source; };
  });
});
afterEach(() => { for (const room of rooms) room.close(); vi.unstubAllGlobals(); });
async function setup(interrupt = vi.fn()) {
  const room = new MeetingAudio(["a", "b"], 20, () => {}, () => {}, interrupt); rooms.push(room); await room.prepare(); return room;
}

it("observer playback never asks for a mic; joining mic does not enable the speaker", async () => {
  const room = await setup(); await room.setSpeaker(true); expect(mic).not.toHaveBeenCalled();
  await room.setSpeaker(false);
  const media = stream(); mic.mockResolvedValue(media); await room.setMicrophone(true);
  expect(media.getAudioTracks()[0]!.enabled).toBe(true);
  await room.setMicrophone(false); expect(media.getTracks()[0]!.stop).toHaveBeenCalledOnce();
});

it("late mic grants cannot leak after leaving or stop a newer mic on the same room", async () => {
  const room = await setup(); const old = stream(), latest = stream(); let grant!: (value: unknown) => void;
  mic.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
  const pending = room.setMicrophone(true); await vi.waitFor(() => expect(grant).toBeDefined());
  room.focus(false); mic.mockResolvedValueOnce(latest); await room.setMicrophone(true);
  grant(old); expect(await pending).toBe(false);
  expect(old.getTracks()[0]!.stop).toHaveBeenCalledOnce(); expect(latest.getTracks()[0]!.stop).not.toHaveBeenCalled();
  expect(latest.getAudioTracks()[0]!.enabled).toBe(true);
});

it("speech onset cancels already scheduled buffers and queued voices without killing the room", async () => {
  const interrupt = vi.fn(); const room = await setup(interrupt);
  const frame = { samples: new Float32Array(1024).fill(0.2), rate: 48000 };
  room.floor.push("a", frame); room.floor.push("b", frame); room.floor.tick(); expect(players).toHaveLength(1);
  mic.mockResolvedValue(stream()); await room.setMicrophone(true);
  expect(players[0].stop).not.toHaveBeenCalled(); expect(interrupt).not.toHaveBeenCalled();
  const speech = { data: { samples: new Float32Array(1024).fill(0.1), capturedAt: 0 } };
  for (let i = 0; i < 6; i++) meters.at(-1).port.onmessage(speech);
  expect(players[0].stop).toHaveBeenCalledOnce(); expect(room.floor.waiting()).toEqual([]); expect(interrupt).toHaveBeenCalledOnce();
  Object.assign(room.context, { currentTime: 1 }); room.floor.tick();
  room.floor.push("a", frame); room.floor.tick(); expect(players).toHaveLength(2);
  meters.at(-1).port.onmessage({ data: { samples: new Float32Array(1024) } });
  for (let i = 0; i < 6; i++) meters.at(-1).port.onmessage(speech);
  expect(players[1].stop).toHaveBeenCalledOnce(); expect(interrupt).toHaveBeenCalledTimes(2);
  expect(room.context.close).not.toHaveBeenCalled();
});

it("mutes only the chosen output and removes its receiver without closing another participant", async () => {
  const room = await setup(); const a = room.input("a"), b = room.input("b");
  const frame = { samples: new Float32Array(1024).fill(0.2), rate: 48000 };
  room.floor.push("a", frame); room.floor.push("b", frame); room.floor.tick();
  room.setParticipantMuted("a", true); expect(players[0].stop).toHaveBeenCalledOnce();
  room.floor.push("a", frame); room.floor.tick(); expect(room.floor.speaker).toBe("b");
  expect(a.getTracks()[0]!.stop).not.toHaveBeenCalled(); // Still hears the room as a listener.
  room.removeParticipant("a"); expect(a.getTracks()[0]!.stop).toHaveBeenCalledOnce(); expect(b.getTracks()[0]!.stop).not.toHaveBeenCalled();
  expect(() => room.input("a")).toThrow("Unknown participant"); expect(room.context.close).not.toHaveBeenCalled();
});


it("enabling a silent microphone preserves the current answer and does not invent an operator turn", async () => {
  const operator = vi.fn(); const room = new MeetingAudio(["a"], 20, vi.fn(), vi.fn(), vi.fn(), vi.fn(), operator);
  rooms.push(room); await room.prepare(); room.setRecipient("a");
  room.floor.push("a", { samples: new Float32Array(1024).fill(0.2), rate: 48000 }); room.floor.tick();
  mic.mockResolvedValue(stream()); await room.setMicrophone(true);
  expect(operator).not.toHaveBeenCalled(); expect(players[0].stop).not.toHaveBeenCalled();
});

it.each([16000, 48000, 96000])("ignores short noise but interrupts sustained speech once at %i Hz", async rate => {
  const operator = vi.fn(), frames = vi.fn(), diagnostic = vi.fn();
  const room = new MeetingAudio(["a"], 20, vi.fn(), vi.fn(), vi.fn(), diagnostic, operator, frames);
  rooms.push(room); await room.prepare(); Object.assign(room.context, { sampleRate: rate });
  mic.mockResolvedValue(stream()); await room.setMicrophone(true); operator.mockClear();
  Object.assign(room.context, { currentTime: 2 }); room.floor.tick(); room.setRecipient("a");
  room.floor.push("a", { samples: new Float32Array(1024).fill(0.2), rate }); room.floor.tick();
  const feed = (seconds: number, amplitude: number) => meters.at(-1).port.onmessage({ data: { samples: new Float32Array(Math.round(rate * seconds)).fill(amplitude) } });
  // Two energetic frames followed by silence were enough to cancel a response.
  feed(0.022, 0.1); feed(0.022, 0.1); feed(0.03, 0);
  expect(operator).not.toHaveBeenCalled(); expect(players[0].stop).not.toHaveBeenCalled();
  expect(frames).toHaveBeenCalledTimes(3); expect(frames.mock.calls.every(call => call[2] === false)).toBe(true);
  for (let i = 0; i < 7; i++) feed(0.022, 0.1);
  expect(operator).toHaveBeenCalledExactlyOnceWith(true); expect(players[0].stop).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ source: "microphone", event: "speech-onset", code: "audio-pending" }));
  expect(frames).toHaveBeenCalledTimes(10);
  expect(room.context.close).not.toHaveBeenCalled();
});
