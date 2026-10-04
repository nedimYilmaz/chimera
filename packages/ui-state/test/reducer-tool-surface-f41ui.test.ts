import { describe, it, expect } from "vitest";
import { reduce, initialState } from "@chimera/ui-state";

// F41.UI: the spawn-time tool-surface grant used to be a metadata-only fact — it landed on
// AgentView.toolSurfaceEstimate and showed up in the detail panel's metadata row, so an operator
// reading the transcript never learned that this spawn had just paid for a chimera MCP catalog.
// The reducer now also records ONE system line, on the FIRST estimate only.
const EST = {
  source: "chimera-mcp-grant",
  toolCount: 46,
  approxChars: 34318,
  approxTokens: 8580,
  settingSources: [],
  note: "estimate",
  bySource: [
    { source: "chimera-core", toolCount: 24, approxChars: 16597, approxTokens: 4149 },
    { source: "chimera-conductor", toolCount: 22, approxChars: 17721, approxTokens: 4431 },
  ],
};
const statusEvent = (seq: number, toolSurface: unknown) => ({
  type: "event" as const,
  event: { ts: seq, seq, agentId: "a", kind: "status", data: { toolSurface } },
});

describe("reducer: tool-surface grant leaves a transcript line (F41.UI)", () => {
  const sys = (st: ReturnType<typeof reduce>) =>
    st.agents["a"]!.transcript.filter((r) => r.role === "system" && r.text.includes("tool surface"));

  it("pushes one system line naming the figure, the tool count and the per-server breakdown", () => {
    const st = reduce(initialState, statusEvent(1, EST));
    expect(sys(st)).toHaveLength(1);
    expect(sys(st)[0]!.text).toBe(
      "⚙ tool surface: chimera MCP ~8580 tok · 46 tools (core 24 + conductor 22)"
      + " — estimate, written once at spawn; settings/plugins/store servers not counted",
    );
    expect(st.agents["a"]!.toolSurfaceEstimate).toEqual(EST);
  });

  it("omits the breakdown clause when the daemon sent no bySource (older record shape)", () => {
    const { bySource: _drop, ...noRows } = EST;
    const st = reduce(initialState, statusEvent(1, noRows));
    expect(sys(st)[0]!.text).toContain("~8580 tok · 46 tools —");
  });

  it("never stacks a second line on a status re-emit of the same estimate", () => {
    const once = reduce(initialState, statusEvent(1, EST));
    const twice = reduce(once, statusEvent(2, EST));
    expect(sys(twice)).toHaveLength(1);
  });

  it("stays silent when the estimate arrived via a snapshot first (no live grant to announce)", () => {
    const snap = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "a", state: "running", toolSurfaceEstimate: EST }],
    } as never);
    const st = reduce(snap, statusEvent(2, EST));
    expect(sys(st)).toHaveLength(0);
  });

  it("ignores a malformed payload (no approxTokens) rather than announcing a blank figure", () => {
    const st = reduce(initialState, statusEvent(1, { toolCount: 3 }));
    expect(sys(st)).toHaveLength(0);
  });
});
