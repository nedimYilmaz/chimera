// VOICE-STOP: the operator could not turn speaking off — `speaking` was only ever left by a
// daemon event. These cover the two new local exits and, just as important, that neither of them
// can disturb any OTHER status (a stray Esc must not reset a live listening turn).
import { describe, expect, it } from "vitest";
import { initialVoiceState, SPEECH_TIMEOUT_MESSAGE, voiceReducer, type VoiceUiState } from "../src/voice.js";

const speakingPtt: VoiceUiState = {
  ...initialVoiceState, status: "speaking", sessionId: "s1", agentId: "a1", lastTtsText: "hello",
};
const speakingConversation: VoiceUiState = { ...speakingPtt, conversationActive: true };

describe("voice stopSpeaking", () => {
  it("push-to-talk: speaking -> idle, session cleared", () => {
    const next = voiceReducer(speakingPtt, { type: "stopSpeaking" });
    expect(next).toEqual(initialVoiceState);
  });

  it("conversation: speaking -> listening, conversation stays active", () => {
    const next = voiceReducer(speakingConversation, { type: "stopSpeaking" });
    expect(next.status).toBe("listening");
    expect(next.conversationActive).toBe(true);
    expect(next.sessionId).toBe("s1");
    expect(next.lastTtsText).toBeNull();
    expect(next.errorMessage).toBeNull();
  });

  it("is a no-op from every other status", () => {
    for (const status of ["idle", "listening", "transcribing", "error"] as const) {
      const state = { ...speakingPtt, status };
      expect(voiceReducer(state, { type: "stopSpeaking" })).toBe(state);
      expect(voiceReducer(state, { type: "speechTimeout" })).toBe(state);
    }
  });
});

describe("voice speechTimeout", () => {
  it("push-to-talk: falls back to idle and says why", () => {
    const next = voiceReducer(speakingPtt, { type: "speechTimeout" });
    expect(next.status).toBe("idle");
    expect(next.errorMessage).toBe(SPEECH_TIMEOUT_MESSAGE);
  });

  it("conversation: keeps listening and says why", () => {
    const next = voiceReducer(speakingConversation, { type: "speechTimeout" });
    expect(next.status).toBe("listening");
    expect(next.conversationActive).toBe(true);
    expect(next.errorMessage).toBe(SPEECH_TIMEOUT_MESSAGE);
  });

  it("a following conversation turn clears the timeout message", () => {
    const timedOut = voiceReducer(speakingConversation, { type: "speechTimeout" });
    expect(voiceReducer(timedOut, { type: "conversationListening" }).errorMessage).toBeNull();
  });
});
