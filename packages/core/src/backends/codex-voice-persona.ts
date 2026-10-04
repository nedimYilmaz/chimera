import type { VoiceIdentity } from "@chimera/protocol/voice-rooms";

// Codex CLI 0.153.4 validates realtime V3 against the V1 list, not V2.
// https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/realtime_conversation.rs#L1484
export const CODEX_V3_VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"] as const;
type Voice = typeof CODEX_V3_VOICES[number];

export function codexVoicePersona(identity?: VoiceIdentity): { voice: Voice; delivery: string } | undefined {
  if (!identity) return undefined;
  const role = identity.role.trim().toLowerCase();
  if (role === "conductor") return { voice: "cove", delivery: "Use a calm, clear delivery when coordinating the conversation." };
  // Names and actual roles identify a character; they do not imply gender,
  // accent, or personality traits. Keep selection independent of room order.
  const key = `${role}\0${identity.name.trim().normalize("NFKC").toLowerCase() || identity.agentId}`;
  let hash = 2166136261;
  for (const codepoint of key) hash = Math.imul(hash ^ codepoint.codePointAt(0)!, 16777619) >>> 0;
  const voice = CODEX_V3_VOICES[hash % (CODEX_V3_VOICES.length - 1)]!;
  const delivery = /(?:review|audit|analyst|research)/.test(role)
    ? "Use a measured, precise delivery when explaining findings."
    : /(?:engineer|developer|implement|builder)/.test(role)
      ? "Use a direct, practical delivery when explaining technical work."
      : "Use a natural delivery consistent with your existing character and instructions.";
  return { voice, delivery };
}
