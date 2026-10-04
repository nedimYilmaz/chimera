import { describe, expect, it, vi } from "vitest";
import { MeetingFloor } from "../src/voice/meetingFloor";
function setup(maxTurns = 10) {
  let now = 0; const play = vi.fn(); const fail = vi.fn(); const changed = vi.fn();
  const interrupt = vi.fn();
  const floor = new MeetingFloor({ now: () => now, play, fail, changed, interrupt, maxTurns });
  const frame = { samples: new Float32Array(100).fill(0.2), rate: 1000 };
  return { floor, play, fail, frame, interrupt, advance: (s: number) => { now += s; floor.tick(); } };
}
describe("native meeting audio floor", () => {
  it("holds early agent audio until routing resolves and plays only the selected answer", () => {
    const s = setup(); s.floor.setRecipient(null);
    s.floor.push("a", s.frame); s.floor.push("b", s.frame); s.advance(1);
    expect(s.play).not.toHaveBeenCalled();
    s.floor.setRecipient("b"); s.floor.tick();
    expect(s.play.mock.calls.map(c => c[0])).toEqual(["b"]);
    s.floor.push("a", s.frame); s.advance(1); expect(s.play).toHaveBeenCalledOnce();
    s.floor.humanSpeaking(); s.floor.setRecipient(null); s.floor.push("a", s.frame); s.advance(1);
    expect(s.play).toHaveBeenCalledOnce();
    s.floor.setRecipient("a"); s.floor.tick(); expect(s.play.mock.calls.map(c => c[0])).toEqual(["b", "a"]);
  });
  it("queues overlapping speakers without mixing/dropping responses", () => {
    const s = setup(); s.floor.push("a", s.frame); s.floor.push("b", s.frame); s.floor.tick();
    expect(s.play.mock.calls.map(c => c[0])).toEqual(["a"]); expect(s.floor.waiting()).toEqual(["b"]);
    s.advance(0.8); expect(s.play.mock.calls.map(c => c[0])).toEqual(["a", "b"]);
  });
  it("allows the human to interrupt without ending agent sessions", () => {
    const s = setup(); s.floor.push("a", s.frame); s.floor.humanSpeaking(); s.floor.tick(); expect(s.play).not.toHaveBeenCalled();
    s.advance(0.9); expect(s.play).not.toHaveBeenCalled(); expect(s.interrupt).toHaveBeenCalledOnce();
    s.floor.push("b", s.frame); s.floor.tick(); expect(s.play).toHaveBeenCalledOnce(); expect(s.fail).not.toHaveBeenCalled();
  });
  it("cancels scheduled output and discards stale queued replies on human speech, only once per utterance", () => {
    const s = setup(); s.floor.push("a", s.frame); s.floor.push("b", s.frame); s.floor.tick();
    s.floor.humanSpeaking(); s.floor.humanSpeaking();
    expect(s.interrupt).toHaveBeenCalledOnce(); expect(s.floor.speaker).toBeNull(); expect(s.floor.waiting()).toEqual([]);
    s.advance(1); expect(s.play).toHaveBeenCalledOnce();
    s.floor.humanSpeaking(); expect(s.interrupt).toHaveBeenCalledTimes(2);
  });
  it("keeps PCM contiguous under callback jitter rather than adding a fresh gap every frame", () => {
    const s = setup(); const frame = { samples: new Float32Array(1024).fill(0.2), rate: 48000 };
    for (let i = 0; i < 120; i++) { s.floor.push("a", frame); s.advance(i % 2 ? 0.030 : 0.013); }
    const calls = s.play.mock.calls;
    expect(calls.length).toBeGreaterThan(100);
    for (let i = 1; i < calls.length; i++) expect(calls[i]![2] - calls[i-1]![2]).toBeCloseTo(1024 / 48000, 6);
  });
  it("pauses immediately, drops audio while paused, then accepts only new speech", () => {
    const s = setup(); s.floor.push("a", s.frame); s.floor.tick(); s.floor.setPaused(true);
    s.floor.push("a", s.frame); s.advance(1); expect(s.play).toHaveBeenCalledOnce();
    s.floor.setPaused(false); s.advance(1); expect(s.play).toHaveBeenCalledOnce();
    s.floor.push("b", s.frame); s.floor.tick(); expect(s.play).toHaveBeenCalledTimes(2);
  });
  it("bounds audio memory, turns and shutdown", () => {
    const s = setup(1); s.floor.push("a", s.frame); s.floor.push("b", s.frame); s.floor.tick(); s.advance(1);
    expect(s.fail).toHaveBeenCalledWith(expect.stringContaining("budget"));
    const overflow = setup(); overflow.floor.push("a", { samples: new Float32Array(31_000).fill(0.1), rate: 1000 });
    expect(overflow.fail).toHaveBeenCalledWith(expect.stringContaining("30-second"));
    overflow.floor.push("b", overflow.frame); overflow.floor.tick(); expect(overflow.play).not.toHaveBeenCalled();
  });
  it("has no global room mixing state and ignores idle silence", () => {
    const one = setup(), two = setup(); one.floor.push("a", one.frame); two.floor.push("b", { ...two.frame, samples: new Float32Array(100) });
    one.floor.tick(); two.floor.tick(); expect(one.play).toHaveBeenCalledOnce(); expect(two.play).not.toHaveBeenCalled();
  });
});
