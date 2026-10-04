import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

// F26: the daemon's setup-hook run has no client-specific rendering — tui and app both
// consume the same transcript lines folded by the shared reducer.
describe("reducer: worktree_setup event folding (F26)", () => {
  it("start renders a running notice", () => {
    const st = feed(initialState, [ev("a1", "worktree_setup", { phase: "start" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: "worktree setup: running project bootstrap hook…" },
    ]);
  });

  it("chunk renders the hook's own stdout/stderr text, trimmed of trailing whitespace", () => {
    const st = feed(initialState, [ev("a1", "worktree_setup", { phase: "chunk", text: "installing deps...\n" })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "system", text: "installing deps..." }]);
  });

  it("a blank chunk is dropped, not rendered as an empty line", () => {
    const st = feed(initialState, [ev("a1", "worktree_setup", { phase: "chunk", text: "   \n" })]);
    expect(st.agents["a1"]!.transcript).toEqual([]);
  });

  it("ok renders success with the run duration", () => {
    const st = feed(initialState, [ev("a1", "worktree_setup", { phase: "ok", durationMs: 842 })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([{ role: "system", text: "worktree setup: ok (842ms)" }]);
  });

  it("fail renders the refused-spawn notice with the exit code", () => {
    const st = feed(initialState, [ev("a1", "worktree_setup", { phase: "fail", exitCode: 1 })]);
    expect(st.agents["a1"]!.transcript).toMatchObject([
      { role: "system", text: "worktree setup FAILED (exit 1) — spawn refused" },
    ]);
  });

  it("all four phases fold in order onto the same agent's transcript", () => {
    const st = feed(initialState, [
      ev("a1", "worktree_setup", { phase: "start" }),
      ev("a1", "worktree_setup", { phase: "chunk", text: "step 1" }),
      ev("a1", "worktree_setup", { phase: "ok", durationMs: 100 }),
    ]);
    expect(st.agents["a1"]!.transcript.map((t) => t.text)).toEqual([
      "worktree setup: running project bootstrap hook…",
      "step 1",
      "worktree setup: ok (100ms)",
    ]);
  });
});

// F26.UI (QA gap 1): exitCode is null on BOTH the timeout ladder and the ENOENT path — the two
// failures an operator is most likely to hit rendered as a literal "exit null".
describe("reducer: worktree_setup fail reasons (F26.UI)", () => {
  it("a timeout names the deadline, never 'exit null'", () => {
    const st = feed(initialState, [
      ev("t1", "worktree_setup", { phase: "fail", exitCode: null, timedOut: true, durationMs: 300_000, command: "pnpm install" }),
    ]);
    const text = st.agents["t1"]!.transcript[0]!.text;
    expect(text).toBe("worktree setup FAILED (timed out after 300s) — spawn refused");
    expect(text).not.toContain("null");
  });

  it("a child that never started names the command instead of a null exit code", () => {
    const st = feed(initialState, [
      ev("t2", "worktree_setup", { phase: "fail", exitCode: null, timedOut: false, durationMs: 12, command: "bootstrap.sh" }),
    ]);
    const text = st.agents["t2"]!.transcript[0]!.text;
    expect(text).toBe("worktree setup FAILED (could not start bootstrap.sh) — spawn refused");
    expect(text).not.toContain("null");
  });

  it("the truncated flag is surfaced instead of silently dropped", () => {
    const st = feed(initialState, [ev("t3", "worktree_setup", { phase: "fail", exitCode: 2, truncated: true })]);
    expect(st.agents["t3"]!.transcript[0]!.text).toBe(
      "worktree setup FAILED (exit 2) — spawn refused · earlier output truncated",
    );
  });

  it("renders a captured output tail when the daemon sends one (forward-compatible)", () => {
    const st = feed(initialState, [ev("t4", "worktree_setup", { phase: "fail", exitCode: 1, stderrTail: "ENOSPC: no space left\n" })]);
    expect(st.agents["t4"]!.transcript[0]!.text).toBe(
      "worktree setup FAILED (exit 1) — spawn refused\nENOSPC: no space left",
    );
  });

  // QA gap 2: the supervisor deletes the agent record when the hook refuses the spawn, so no
  // status event ever follows — the row must still read as a failed agent carrying the reason.
  it("a refused spawn is visible as a failed agent even with no other event for that id", () => {
    const st = feed(initialState, [ev("ghost", "worktree_setup", { phase: "fail", exitCode: 1 })]);
    expect(st.agents["ghost"]!.state).toBe("failed");
    expect(st.agentOrder).toContain("ghost");
  });

  it("an agent.list snapshot that omits the refused agent keeps its row and transcript", () => {
    const st = feed(initialState, [ev("ghost", "worktree_setup", { phase: "fail", exitCode: 1 })]);
    const after = reduce(st, { type: "agentRecords", records: [] });
    expect(after.agentOrder).toContain("ghost");
    expect(after.agents["ghost"]!.transcript[0]!.text).toContain("spawn refused");
  });
});
