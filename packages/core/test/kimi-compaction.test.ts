import { describe, it, expect } from "vitest";
import { normalizeKimiEvent, type KimiMapCtx } from "@chimera/core/backends/kimi";

// COMPACTION-OBSERVABILITY (ACP 1.4.0): kimi can finally report that it compacted. Mapped onto
// the SAME normalized event the other two backends emit, so every existing surface — the
// transcript banner, the ⇥ counter, the ctx reset, the live "compacting…" indicator — works for
// kimi with no UI change.

const ctx = (): KimiMapCtx => ({ toolTitles: new Map(), toolClosed: new Set(), commands: new Set() });
const one = (u: unknown, c = ctx()) => normalizeKimiEvent(u as never, c) as { kind: string; data: Record<string, unknown> };

describe("kimi compaction events", () => {
  it("in_progress opens the live indicator", () => {
    const e = one({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" });
    expect(e.kind).toBe("compaction");
    expect(e.data).toMatchObject({ phase: "start", owner: "sdk", compactionId: "c1" });
  });

  it("completed is a completion — no phase, so it counts and banners like any other backend's", () => {
    const e = one({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
    expect(e.data["phase"]).toBeUndefined();
    expect(e.data["owner"]).toBe("sdk");
  });

  it("failed aborts and carries the reason instead of counting a compaction that did not happen", () => {
    const e = one({ sessionUpdate: "compaction_update", compactionId: "c1", status: "failed", error: "context too small" });
    expect(e.data).toMatchObject({ phase: "aborted", error: "context too small" });
  });

  it("an unknown status is treated as terminal-not-successful, never asserted as a success", () => {
    const e = one({ sessionUpdate: "compaction_update", compactionId: "c1", status: "something_new" });
    expect(e.data).toMatchObject({ phase: "aborted", status: "something_new" });
  });

  it("claims NO trigger and NO sizes — ACP reports neither, and a guess would read as a measurement", () => {
    const e = one({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" });
    expect(e.data["trigger"]).toBeUndefined();
    expect(e.data["before"]).toBeUndefined();
    expect(e.data["after"]).toBeUndefined();
  });

  it("a summary chunk is surfaced, not silently dropped", () => {
    const e = one({ sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: { type: "text", text: "…" } });
    expect(e.kind).toBe("status");
    expect(e.data["kimiEvent"]).toBe("compaction_summary_chunk");
  });
});

describe("kimi's advertised commands", () => {
  it("emits the SAME commands_changed event claude does, so the app's / autocomplete sees them", () => {
    const c = ctx();
    const e = one({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "compact", description: "compact the context" }, { name: "init", description: "…" }],
    }, c);
    // Not a kimi-shaped blob: the normalized kind every provider's commands ride, which ui-state
    // folds into agent.slashCommands. It used to be a generic `status` nothing consumes — so kimi
    // advertised its commands and the operator never saw one.
    expect(e.kind).toBe("commands_changed");
    expect(e.data["commands"]).toEqual([
      { name: "compact", description: "compact the context" },
      { name: "init", description: "…" },
    ]);
    expect([...c.commands!]).toEqual(["compact", "init"]);
  });

  it("carries a command with no description rather than dropping it", () => {
    const c = ctx();
    const e = one({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "solo" }] }, c);
    expect(e.data["commands"]).toEqual([{ name: "solo" }]);
  });

  it("REPLACES the previous list — the update is a full advertisement, not an append", () => {
    const c = ctx();
    one({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] }, c);
    one({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "init" }] }, c);
    expect([...c.commands!]).toEqual(["init"]);
  });

  it("survives a malformed entry rather than losing the whole list", () => {
    const c = ctx();
    one({ sessionUpdate: "available_commands_update", availableCommands: [{ name: 42 }, { name: "compact" }] }, c);
    expect([...c.commands!]).toEqual(["compact"]);
  });
});
