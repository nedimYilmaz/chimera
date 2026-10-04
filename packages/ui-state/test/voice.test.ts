import { describe, expect, it } from "vitest";
import { initialVoiceState, voiceReducer, type VoiceUiState } from "../src/voice.js";

describe("voiceReducer", () => {
  it("starts idle", () => {
    expect(initialVoiceState.status).toBe("idle");
  });

  it("sessionStarted resets any stale fields and moves to listening", () => {
    const dirty: VoiceUiState = {
      status: "error", sessionId: "old", agentId: "old-agent",
      partialTranscript: "stale", lastTtsText: "stale", errorMessage: "boom",
      conversationActive: true,
    };
    const next = voiceReducer(dirty, { type: "sessionStarted", sessionId: "s1", agentId: "a1" });
    expect(next).toEqual({
      status: "listening", sessionId: "s1", agentId: "a1",
      partialTranscript: "", lastTtsText: null, errorMessage: null,
      conversationActive: false,
    });
  });

  it("walks the full push-to-talk happy path: listening -> transcribing -> speaking -> idle", () => {
    let s = voiceReducer(initialVoiceState, { type: "sessionStarted", sessionId: "s1", agentId: "a1" });
    expect(s.status).toBe("listening");

    s = voiceReducer(s, { type: "transcribing" });
    expect(s.status).toBe("transcribing");

    s = voiceReducer(s, { type: "speaking", text: "hello there" });
    expect(s.status).toBe("speaking");
    expect(s.lastTtsText).toBe("hello there");

    s = voiceReducer(s, { type: "idle" });
    expect(s).toEqual(initialVoiceState);
  });

  it("partialTranscript updates the in-progress text without changing status", () => {
    let s = voiceReducer(initialVoiceState, { type: "sessionStarted", sessionId: "s1", agentId: "a1" });
    s = voiceReducer(s, { type: "partialTranscript", text: "hel" });
    expect(s.status).toBe("listening");
    expect(s.partialTranscript).toBe("hel");
  });

  it("error transitions from any state and carries the message (§7: didn't catch that / engine unavailable / etc)", () => {
    const fromListening = voiceReducer(
      voiceReducer(initialVoiceState, { type: "sessionStarted", sessionId: "s1", agentId: "a1" }),
      { type: "error", message: "didn't catch that" },
    );
    expect(fromListening.status).toBe("error");
    expect(fromListening.errorMessage).toBe("didn't catch that");
    // error keeps the session context around (e.g. sessionId) rather than wiping it —
    // only an explicit `idle`/new `sessionStarted` resets.
    expect(fromListening.sessionId).toBe("s1");
  });

  it("a remote voice_session_state event (sessionState action) folds directly into status", () => {
    const s = voiceReducer(initialVoiceState, { type: "sessionState", state: "speaking" });
    expect(s.status).toBe("speaking");
  });

  it("idle always resets to the pristine initial state, even mid-error", () => {
    const errored = voiceReducer(initialVoiceState, { type: "error", message: "mic denied" });
    expect(voiceReducer(errored, { type: "idle" })).toEqual(initialVoiceState);
  });

  // VOICE R3 (§5 "Turn state"): ⌥Space conversation mode's own lifecycle — distinct from
  // sessionStarted/idle so a turn's end returns to `listening`, not a full session reset.
  describe("conversation mode", () => {
    it("conversationStarted moves to listening with conversationActive true", () => {
      const s = voiceReducer(initialVoiceState, { type: "conversationStarted", sessionId: "s1", agentId: "a1" });
      expect(s).toEqual({
        status: "listening", sessionId: "s1", agentId: "a1",
        partialTranscript: "", lastTtsText: null, errorMessage: null,
        conversationActive: true,
      });
    });

    it("walks a full conversation turn: listening -> transcribing -> speaking -> conversationListening (NOT idle)", () => {
      let s = voiceReducer(initialVoiceState, { type: "conversationStarted", sessionId: "s1", agentId: "a1" });
      s = voiceReducer(s, { type: "transcribing" });
      expect(s.status).toBe("transcribing");
      expect(s.conversationActive).toBe(true);

      s = voiceReducer(s, { type: "speaking", text: "hi there" });
      expect(s.status).toBe("speaking");

      s = voiceReducer(s, { type: "conversationListening" });
      expect(s.status).toBe("listening");
      expect(s.conversationActive).toBe(true); // still active — the session keeps going
      expect(s.sessionId).toBe("s1");
      expect(s.lastTtsText).toBeNull();
    });

    it("conversationListening (barge-in resume) clears the error/partial state, staying active", () => {
      let s = voiceReducer(initialVoiceState, { type: "conversationStarted", sessionId: "s1", agentId: "a1" });
      s = voiceReducer(s, { type: "speaking", text: "hi" });
      s = voiceReducer(s, { type: "error", message: "boom" });
      s = voiceReducer(s, { type: "conversationListening" });
      expect(s.status).toBe("listening");
      expect(s.errorMessage).toBeNull();
      expect(s.conversationActive).toBe(true);
    });

    it("conversationEnded fully resets to the pristine initial state", () => {
      let s = voiceReducer(initialVoiceState, { type: "conversationStarted", sessionId: "s1", agentId: "a1" });
      s = voiceReducer(s, { type: "speaking", text: "hi" });
      expect(voiceReducer(s, { type: "conversationEnded" })).toEqual(initialVoiceState);
    });
  });
});
