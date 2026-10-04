import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeCodexVoice, NativeVoiceRooms } from "../src/voice/nativeCodex";

function setup() {
  const peers: any[] = []; const tracks: any[] = []; const audio: any[] = [];
  const pending = new Map<string, (s: MediaStream) => void>();
  const rpc = vi.fn(async (method: string) => method === "voice.native.start" ? { sdp: "answer" } : method === "voice.native.poll" ? { active: true, transcript: "", error: null } : { stopped: true });
  let delayMic = false; let count = 0;
  const rooms = new NativeVoiceRooms(id => {
    const track = { enabled: true, stop: vi.fn(), onended: null }; tracks.push(track);
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
    const pc = { connectionState: "connected", iceGatheringState: "complete", localDescription: { sdp: "offer" }, addTrack: vi.fn(),
      createDataChannel: () => ({ close: vi.fn() }), createOffer: async () => ({}), setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close: vi.fn(), ontrack: null as any };
    const player = { muted: false, autoplay: false, play: vi.fn(async () => {}), pause: vi.fn(), srcObject: null };
    peers.push(pc); audio.push(player);
    if (delayMic) pending.set(id, () => {});
    return new NativeCodexVoice({ rpc, mic: () => delayMic ? new Promise(resolve => { pending.set(id, () => resolve(stream)); }) : Promise.resolve(stream),
      peer: () => pc as unknown as RTCPeerConnection, audio: () => player as unknown as HTMLAudioElement,
      id: () => id, disconnected: () => () => {},
    });
  }, () => `room-${++count}`);
  return { rooms, tracks, peers, audio, rpc, delay: () => { delayMic = true; }, grant: (id: string) => pending.get(id)!({} as MediaStream) };
}
afterEach(() => vi.useRealTimers());
describe("isolated persistent voice rooms", () => {
  it("keeps two peers alive but routes the microphone and playback to only the joined room", async () => {
    const s = setup();
    try {
      await s.rooms.start("a", false); await s.rooms.start("b", false);
      expect(s.rooms.getRooms()).toHaveLength(2);
      expect(s.tracks.map(t => t.enabled)).toEqual([false, true]);
      expect(s.audio.map(a => a.muted)).toEqual([true, false]);
      expect(s.peers[0].close).not.toHaveBeenCalled();
      s.rooms.join("a");
      expect(s.tracks.map(t => t.enabled)).toEqual([true, false]);
      expect(s.audio.map(a => a.muted)).toEqual([false, true]);
      s.rooms.join(null);
      expect(s.tracks.map(t => t.enabled)).toEqual([false, false]);
      expect(s.rooms.getState().status).toBe("listening"); // blocks legacy capture while rooms exist
      expect(s.rpc.mock.calls.filter(([m]) => m === "voice.native.start")).toHaveLength(2);
    } finally { s.rooms.stop(); }
  });
  it("ending a background room cannot stop the foreground room, and ending foreground never auto-unmutes another", async () => {
    const s = setup();
    await s.rooms.start("a", false); await s.rooms.start("b", false);
    s.rooms.stop("a");
    expect(s.tracks[0].stop).toHaveBeenCalledOnce(); expect(s.tracks[1].stop).not.toHaveBeenCalled();
    s.rooms.stop("b"); expect(s.rooms.getRooms()).toEqual([]);
  });
  it("late microphone grants respect the current room and cannot revive a cancelled room", async () => {
    const s = setup(); s.delay();
    const a = s.rooms.start("a", false); const b = s.rooms.start("b", false);
    s.grant("room-1"); await a;
    expect(s.tracks[0].enabled).toBe(false);
    s.rooms.stop("b"); s.grant("room-2"); await b;
    expect(s.tracks[1].stop).toHaveBeenCalledOnce();
    expect(s.tracks[0].enabled).toBe(false); // no implicit return to a
    expect(s.rpc.mock.calls.filter(([m]) => m === "voice.native.start")).toHaveLength(1);
    s.rooms.stop();
  });
  it("a failed room doesn't close or unmute its neighbour; all open rooms renew their leases", async () => {
    vi.useFakeTimers(); const s = setup();
    await s.rooms.start("a", false); await s.rooms.start("b", false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.rpc.mock.calls.filter(([m]) => m === "voice.native.poll").length).toBeGreaterThanOrEqual(4);
    s.peers[1].connectionState = "failed"; s.peers[1].onconnectionstatechange();
    expect(s.rooms.getAgentState("b").status).toBe("error");
    expect(s.rooms.getAgentState("a").status).toBe("listening");
    expect(s.tracks[0].enabled).toBe(false);
    s.rooms.stop();
  });
  it("bounds concurrent rooms and rejoining never duplicates a session", async () => {
    const s = setup();
    try {
      s.rooms.setLimit(5);
      for (const id of ["a", "b", "c", "d", "e"]) await s.rooms.start(id, false);
      await expect(s.rooms.start("f", false)).rejects.toThrow("maximum 5");
      await s.rooms.start("a", false);
      expect(s.peers).toHaveLength(5); expect(s.rooms.getState().agentId).toBe("a");
    } finally { s.rooms.stop(); }
  });
});
