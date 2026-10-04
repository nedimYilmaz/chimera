import type { VoiceIdentity } from "@chimera/protocol/voice-rooms";

function words(value: string): string {
  return value.toLocaleLowerCase("tr").replace(/\u0131/g, "i").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function meetingConductor(participants: VoiceIdentity[]): string | undefined {
  return (participants.find(p => p.role === "conductor") ?? participants[0])?.agentId;
}
export function meetingRecipient(text: string, participants: VoiceIdentity[], partial = false): { agentId?: string; reason: "named" | "conductor" | "ambiguous" | "pending" } {
  const utterance = words(text);
  const normalized = ` ${utterance} `;
  const matches = participants.filter(p => {
    const name = words(p.name);
    // The conductor is commonly addressed as "Codex" rather than its full
    // app label. Only allow that alias when it uniquely identifies a seat.
    const alias = name === "chimera codex" && participants.filter(other => words(other.name).includes("codex")).length === 1 ? "codex" : undefined;
    return !!name && normalized.includes(` ${name} `) || !!alias && normalized.includes(` ${alias} `);
  });
  const leading = matches.filter(p => {
    const name = words(p.name);
    if (!utterance.startsWith(`${name} `)) return false;
    const remainder = utterance.slice(name.length + 1).split(" ");
    if (partial && remainder.length < 2) return false;
    const next = remainder[0];
    return !["ve", "and", "ile", "ya", "or"].includes(next!);
  });
  if (leading.length === 1) return { agentId: leading[0]!.agentId, reason: "named" };
  if (partial) return { reason: "pending" };
  if (matches.length === 1) return { agentId: matches[0]!.agentId, reason: "named" };
  return matches.length ? { reason: "ambiguous" } : { agentId: meetingConductor(participants), reason: "conductor" };
}
