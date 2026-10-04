import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce, type UiState } from "@chimera/ui-state";

// LOCAL-COMMAND-OUTPUT: a provider slash command's own output ("/mcp" listing servers, "/plugins
// isn't available in this environment") is not something the model said — the CLI printed it.
// claude.ts marked it role:"system" from the start and nothing read the flag, so it rendered as an
// ordinary assistant turn: the operator saw the agent apparently announcing "25 MCP server(s): 14
// connected" in its own voice.

let seq = 0;
const ev = (kind: string, data: Record<string, unknown>): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId: "a", kind, data } as unknown as NormalizedEvent);
const feed = (events: NormalizedEvent[]): UiState =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), initialState);
const transcript = (s: UiState) => s.agents["a"]?.transcript ?? [];

describe("command output is not the agent talking", () => {
  it("lands as a system line, not an assistant turn", () => {
    const s = feed([ev("message_complete", { text: "25 MCP server(s): 14 connected", role: "system", localCommand: true })]);
    expect(transcript(s)).toHaveLength(1);
    expect(transcript(s)[0]).toMatchObject({ role: "system", text: "25 MCP server(s): 14 connected" });
  });

  it("an ordinary assistant message is untouched", () => {
    const s = feed([ev("message_complete", { text: "here is my answer" })]);
    expect(transcript(s)[0]).toMatchObject({ role: "assistant" });
  });

  it("never swallows a streaming reply — command output is its own message, not that turn's completion", () => {
    const s = feed([
      ev("message_delta", { text: "I am mid-thought" }),
      ev("message_complete", { text: "/plugins isn't available in this environment.", role: "system", localCommand: true }),
    ]);
    const rows = transcript(s);
    // the streaming assistant item survives, and the command output sits beside it
    expect(rows.map((r) => r.role)).toEqual(["assistant", "system"]);
    expect(rows[0]!.text).toBe("I am mid-thought");
  });

  it("the assistant's own reply still finalizes normally afterwards", () => {
    const s = feed([
      ev("message_delta", { text: "partial" }),
      ev("message_complete", { text: "/mcp output", role: "system", localCommand: true }),
      ev("message_complete", { text: "partial answer" }),
    ]);
    const rows = transcript(s);
    expect(rows.map((r) => r.role)).toEqual(["assistant", "system"]);
    expect(rows[0]).toMatchObject({ text: "partial answer", streaming: false });
  });
});
