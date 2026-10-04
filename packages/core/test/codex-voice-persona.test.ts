import { describe, expect, it } from "vitest";
import { codexVoicePersona } from "@chimera/core/backends/codex-voice-persona";

describe("Codex V3 voice characters", () => {
  it("keeps named characters stable across recreated agents and distinguishes the meeting guests", () => {
    const characters = ["Atlas", "Nova", "sohbet-arkadasi"].map(name => ({ name, role: "agent", agentId: `first-${name}` }));
    const voices = characters.map(character => codexVoicePersona(character)!.voice);
    expect(new Set(voices).size).toBe(3);
    for (const character of characters) {
      expect(codexVoicePersona({ ...character, agentId: "recreated" })).toEqual(codexVoicePersona(character));
    }
  });

  it("uses only the native V3 voice family for role and unnamed identity fallbacks", () => {
    const allowed = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];
    for (const role of ["conductor", "reviewer", "researcher", "engineer", "agent"]) {
      for (const name of ["Atlas", "Nova", "", "Türkçe kimlik"]) {
        expect(allowed).toContain(codexVoicePersona({ agentId: "agent", name, role })!.voice);
      }
    }
    expect(codexVoicePersona()).toBeUndefined();
  });

  it("derives delivery only from actual responsibilities without guessing traits from names", () => {
    const profile = (name: string, role: string) => codexVoicePersona({ name, role, agentId: name })!;
    expect(profile("Atlas", "conductor").delivery).toContain("coordinating");
    expect(profile("Nova", "reviewer").delivery).toContain("findings");
    expect(profile("Nova", "engineer").delivery).toContain("technical work");
    expect(profile("Atlas", "agent").delivery).toBe(profile("Nova", "agent").delivery);
  });
});
