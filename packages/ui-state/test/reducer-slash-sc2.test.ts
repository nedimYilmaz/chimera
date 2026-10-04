import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// Native-CLI-parity Phase 3 (Task SC2): reducer coverage for the two
// slash-command projections -- agent_started's name-only init and
// commands_changed's rich REPLACE. Mirrors reducer-events.test.ts's own
// ev()/feed() harness exactly.
let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("reducer: slash commands (SC2)", () => {
  it("advertises native Codex commands from registration before the first model turn", () => {
    const st = feed(initialState, [ev("a1", "status", { registered: true, provider: "codex", state: "running" })]);
    expect(st.agents.a1!.slashCommands.map(c => c.name)).toEqual(["goal", "compact"]);
  });
  it.each([false, true])("command completion preserves actual turn activity (%s)", active => {
    let st = feed(initialState, [ev("a1", "message_delta", { text: "working" })]);
    st = feed(st, [ev("a1", "status", { commandComplete: true, turnActive: active })]);
    expect(st.agents.a1!.busy).toBe(active);
  });
  it("agent_started with slashCommands:[string,...] projects name-only SlashCommandView entries", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { model: "m1", slashCommands: ["compact", "cost"] })]);
    expect(st.agents["a1"]!.slashCommands).toEqual([{ name: "compact" }, { name: "cost" }]);
  });

  it("agent_started with no slashCommands field leaves slashCommands as [] (emptyAgent default)", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { model: "m1" })]);
    expect(st.agents["a1"]!.slashCommands).toEqual([]);
  });

  it("agent_started with a non-array slashCommands is ignored (never throws)", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { model: "m1", slashCommands: "compact" })]);
    expect(st.agents["a1"]!.slashCommands).toEqual([]);
  });

  it("agent_started filters out non-string entries from slashCommands", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { slashCommands: ["compact", 42, null, { name: "x" }, "cost"] })]);
    expect(st.agents["a1"]!.slashCommands).toEqual([{ name: "compact" }, { name: "cost" }]);
  });

  it("commands_changed REPLACES a prior agent_started name-only list with the rich list (descriptions/argumentHint)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { slashCommands: ["compact", "cost"] }),
      ev("a1", "commands_changed", {
        commands: [
          { name: "compact", description: "Compact the context", argumentHint: "[level]" },
          { name: "clear", description: "Clear the transcript" },
        ],
      }),
    ]);
    expect(st.agents["a1"]!.slashCommands).toEqual([
      { name: "compact", description: "Compact the context", argumentHint: "[level]" },
      { name: "clear", description: "Clear the transcript" },
    ]);
  });

  it("commands_changed with a missing/non-array commands field REPLACES with [] (clears the prior list)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { slashCommands: ["compact"] }),
      ev("a1", "commands_changed", {}),
    ]);
    expect(st.agents["a1"]!.slashCommands).toEqual([]);
  });

  it("commands_changed drops entries with no usable name, and non-string description/argumentHint are omitted rather than crashing", () => {
    const st = feed(initialState, [
      ev("a1", "commands_changed", {
        commands: [
          { name: "cost", description: 42, argumentHint: null },
          { description: "no name here" },
          null,
          "not-an-object",
          { name: "", description: "empty name dropped" },
        ],
      }),
    ]);
    expect(st.agents["a1"]!.slashCommands).toEqual([{ name: "cost" }]);
  });

  it("a second commands_changed REPLACES the first wholesale (not merged)", () => {
    const st = feed(initialState, [
      ev("a1", "commands_changed", { commands: [{ name: "a" }, { name: "b" }] }),
      ev("a1", "commands_changed", { commands: [{ name: "c" }] }),
    ]);
    expect(st.agents["a1"]!.slashCommands).toEqual([{ name: "c" }]);
  });
});
