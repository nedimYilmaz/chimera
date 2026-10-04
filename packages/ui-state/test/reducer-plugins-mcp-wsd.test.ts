import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// WS-D (parity: surface plugins/skills/mcp read-only): reducer coverage for the
// agent_started fold of the SDK init's plugins/skills/mcpServers, mirroring the
// SC2 slash-command harness exactly. The contract: fold defensively, drop malformed
// entries, and leave a plain agent's empty defaults untouched.
let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("reducer: plugins/skills/mcp surfacing (WS-D)", () => {
  it("folds skills (bare strings) and plugins ({name,path} objects) into name-string arrays", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {
      model: "m1",
      skills: ["review", "plan"],
      plugins: [{ name: "acme", path: "/p/acme" }, { name: "beta", path: "/p/beta" }],
    })]);
    expect(st.agents["a1"]!.skills).toEqual(["review", "plan"]);
    expect(st.agents["a1"]!.plugins).toEqual(["acme", "beta"]);
  });

  it("accepts plugins that are already bare strings too (defensive, either SDK shape)", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { plugins: ["p1", "p2"] })]);
    expect(st.agents["a1"]!.plugins).toEqual(["p1", "p2"]);
  });

  it("folds mcpServers into {name,status} views", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {
      mcpServers: [{ name: "chimera", status: "connected" }, { name: "linear", status: "needs-auth" }],
    })]);
    expect(st.agents["a1"]!.mcpServers).toEqual([
      { name: "chimera", status: "connected" },
      { name: "linear", status: "needs-auth" },
    ]);
  });

  it("an mcpServers entry with a missing/non-string status defaults to 'unknown'", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {
      mcpServers: [{ name: "x" }, { name: "y", status: 42 }],
    })]);
    expect(st.agents["a1"]!.mcpServers).toEqual([
      { name: "x", status: "unknown" },
      { name: "y", status: "unknown" },
    ]);
  });

  it("drops malformed entries: nameless plugins/skills and nameless/non-object mcp servers", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {
      plugins: ["ok", 42, null, {}, { name: "" }, { name: "good" }],
      skills: ["s1", 7, { name: "not-a-string-skill-shape" }, ""],
      mcpServers: [{ name: "srv", status: "connected" }, { status: "connected" }, null, "nope", { name: "" }],
    })]);
    expect(st.agents["a1"]!.plugins).toEqual(["ok", "good"]);
    // skills accepts either a bare string OR an object's name (same helper), so the
    // object entry contributes its name; the empty string and the number are dropped.
    expect(st.agents["a1"]!.skills).toEqual(["s1", "not-a-string-skill-shape"]);
    expect(st.agents["a1"]!.mcpServers).toEqual([{ name: "srv", status: "connected" }]);
  });

  it("agent_started WITHOUT plugins/skills/mcpServers leaves the emptyAgent [] defaults untouched", () => {
    const st = feed(initialState, [ev("a1", "agent_started", { model: "m1", slashCommands: ["compact"] })]);
    expect(st.agents["a1"]!.plugins).toEqual([]);
    expect(st.agents["a1"]!.skills).toEqual([]);
    expect(st.agents["a1"]!.mcpServers).toEqual([]);
    // the sibling slash-command fold is unaffected -- both live in the same case.
    expect(st.agents["a1"]!.slashCommands).toEqual([{ name: "compact" }]);
  });

  it("a SECOND agent_started WITHOUT the fields leaves an already-populated list UNTOUCHED (the real 'prior value preserved' invariant)", () => {
    // The reducer comment promises "a missing/non-array field leaves the prior
    // value untouched" -- prove it against a NON-empty prior (not just the
    // emptyAgent seed): populate first, then feed a bare agent_started.
    const st = feed(initialState, [
      ev("a1", "agent_started", {
        plugins: [{ name: "acme" }], skills: ["review"],
        mcpServers: [{ name: "chimera", status: "connected" }],
      }),
      ev("a1", "agent_started", { model: "m2" }), // no plugins/skills/mcp fields
    ]);
    expect(st.agents["a1"]!.plugins).toEqual(["acme"]);
    expect(st.agents["a1"]!.skills).toEqual(["review"]);
    expect(st.agents["a1"]!.mcpServers).toEqual([{ name: "chimera", status: "connected" }]);
    // the sibling update in the second event still applied (proves the case ran).
    expect(st.agents["a1"]!.model).toBe("m2");
  });

  it("a second agent_started WITH new lists REPLACES the prior (fold reassigns, not merges)", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { plugins: ["old"], mcpServers: [{ name: "a", status: "connected" }] }),
      ev("a1", "agent_started", { plugins: ["new1", "new2"], mcpServers: [{ name: "b", status: "failed" }] }),
    ]);
    expect(st.agents["a1"]!.plugins).toEqual(["new1", "new2"]);
    expect(st.agents["a1"]!.mcpServers).toEqual([{ name: "b", status: "failed" }]);
  });

  it("non-array plugins/skills/mcpServers are ignored (never throw, defaults kept)", () => {
    const st = feed(initialState, [ev("a1", "agent_started", {
      plugins: "acme", skills: { a: 1 }, mcpServers: 5,
    })]);
    expect(st.agents["a1"]!.plugins).toEqual([]);
    expect(st.agents["a1"]!.skills).toEqual([]);
    expect(st.agents["a1"]!.mcpServers).toEqual([]);
  });
});
