import { describe, it, expect } from "vitest";
import { EventKindSchema, NormalizedEventSchema } from "@chimera/protocol";

// native-CLI-parity Phase 3, Task SC1: surface the SDK's slash_commands/skills/plugins/
// apiKeySource from init, and the live commands_changed push, as a new event kind.
// data stays a loose z.record; documented (not schema-enforced) shape for commands_changed:
// { commands: SlashCommand[] } where SlashCommand = { name, description, argumentHint, aliases? }.

describe("commands_changed event kind (native-CLI-parity Phase 3, Task SC1)", () => {
  it("accepts 'commands_changed' as a valid EventKind", () => {
    expect(EventKindSchema.parse("commands_changed")).toBe("commands_changed");
  });

  it("round-trips a NormalizedEvent with kind:'commands_changed' through the locked shape (loose data preserved)", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "a1", kind: "commands_changed",
      data: { commands: [{ name: "compact", description: "compact the transcript", argumentHint: "" }] },
    });
    expect(ev.kind).toBe("commands_changed");
    expect(ev.data).toEqual({ commands: [{ name: "compact", description: "compact the transcript", argumentHint: "" }] });
    expect(ev.engineId).toBe("local"); // federation default still applies
  });

  it("round-trips a commands_changed event whose SlashCommand entries carry aliases", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "a1", kind: "commands_changed",
      data: { commands: [{ name: "cost", description: "usage", argumentHint: "", aliases: ["price"] }] },
    });
    expect(ev.data["commands"]).toEqual([{ name: "cost", description: "usage", argumentHint: "", aliases: ["price"] }]);
  });

  it("round-trips a commands_changed event with an empty commands array (REPLACE semantics, empty list is valid)", () => {
    const ev = NormalizedEventSchema.parse({
      ts: 1, seq: 2, agentId: "a1", kind: "commands_changed", data: { commands: [] },
    });
    expect(ev.data["commands"]).toEqual([]);
  });

  it("rejects an EventKind string not in the enum (regression: unrelated to commands_changed itself)", () => {
    expect.assertions(1);
    expect(() => EventKindSchema.parse("commands_changed_typo")).toThrow();
  });

  it("still accepts every pre-existing EventKind after the addition (additive, no regression)", () => {
    for (const k of [
      "agent_started", "message_delta", "message_complete", "tool_call", "tool_result",
      "permission_request", "agent_question", "turn_complete", "result", "error", "failover", "status",
      "agent_task", "agent_dialog",
    ]) {
      expect(EventKindSchema.parse(k)).toBe(k);
    }
  });
});
