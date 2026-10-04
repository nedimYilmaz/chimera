import { describe, it, expect } from "vitest";
import { reduce, initialState, worktreeKeyFromWorkdir, worktreeLeaseChips, type NormalizedEvent } from "@chimera/ui-state";

// F22.UI — event-only drive style: the desktop app takes exactly ONE agent.list snapshot at
// bootstrap, so every lease fact an operator sees mid-session has to come from a live fold.
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: 1000, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}
const sysLines = (s: ReturnType<typeof reduce>, id: string) =>
  (s.agents[id]?.transcript ?? []).filter((t) => t.role === "system").map((t) => (t as { text: string }).text);

const DENY = {
  tool: "Bash",
  requestId: "req-1",
  reason: "worktree_lease_foreign_write",
  target: "/repo/.chimera/worktrees/wk-1/src/a.ts",
  workdirKey: "wk-1",
  owner: "agent-owner-1234567",
  ownerState: "active",
};

describe("F22.UI — refused worktree write", () => {
  it("lights the sticky flags LIVE (not only from a snapshot) and prints one system line", () => {
    const s = reduce(initialState, ev({ agentId: "a1", kind: "policy_denied", ts: 5000, data: { ...DENY } }));
    const a = s.agents["a1"]!;
    expect(a.worktreeLeaseDenied).toBe(true);
    expect(a.worktreeLeaseMode).toBe("enforce");
    expect(a.lastWorktreeLeaseDenial).toEqual({ ...DENY, reason: undefined, at: 5000, ownerState: "active" } as never);
  });

  it("names the tool, the target, the key and the holder in the transcript line", () => {
    const s = reduce(initialState, ev({ agentId: "a1", kind: "policy_denied", data: { ...DENY } }));
    const line = sysLines(s, "a1")[0]!;
    expect(line).toContain("worktree write refused");
    expect(line).toContain("Bash → /repo/.chimera/worktrees/wk-1/src/a.ts");
    expect(line).toContain("key wk-1");
    expect(line).toContain("agent-ow");
    expect(line).toContain("worktree_lease_handoff");
  });

  // The SAME event kind carries the unrelated main-checkout guard; an ungated case would
  // mislabel it as a lease refusal.
  it("ignores a policy_denied with a different reason", () => {
    const s = reduce(initialState, ev({ agentId: "a1", kind: "policy_denied", data: { reason: "worktree_main_source_write", tool: "Bash" } }));
    expect(s.agents["a1"]?.worktreeLeaseDenied).toBeUndefined();
    expect(sysLines(s, "a1")).toEqual([]);
  });
});

describe("F22.UI — warn mode", () => {
  it("prints the warn line and records mode=warn on an allowed foreign write", () => {
    const s = reduce(initialState, ev({ agentId: "a1", kind: "capability_decision", data: { action: "worktree_write", decision: "allow", owner: "agent-owner-1234567", workdirKey: "wk-1" } }));
    expect(s.agents["a1"]?.worktreeLeaseMode).toBe("warn");
    expect(sysLines(s, "a1")[0]).toContain("allowed with a warning");
  });

  // On deny the broker AND the supervisor both emit; policy_denied owns the line, so this
  // branch must stay silent or every refusal double-prints.
  it("stays silent on a deny decision (policy_denied owns that line)", () => {
    const s = reduce(initialState, ev({ agentId: "a1", kind: "capability_decision", data: { action: "worktree_write", decision: "deny", owner: "o" } }));
    expect(s.agents["a1"]?.worktreeLeaseMode).toBe("enforce");
    expect(sysLines(s, "a1")).toEqual([]);
  });

  it("ignores capability_decision for other actions", () => {
    const s = reduce(initialState, ev({ agentId: "a1", kind: "capability_decision", data: { action: "spawn", decision: "allow" } }));
    expect(s.agents["a1"]?.worktreeLeaseMode).toBeUndefined();
    expect(sysLines(s, "a1")).toEqual([]);
  });
});

describe("F22.UI — contention (the QA-reported gap)", () => {
  it("projects worktreeLeaseContended from the status string and prints a line", () => {
    const s = reduce(initialState, ev({ agentId: "a1", kind: "status", ts: 7000, data: { state: "running", worktreeLeaseContended: "worktree wk-1 is leased by agent-b" } }));
    expect(s.agents["a1"]?.worktreeLeaseContended).toEqual({ message: "worktree wk-1 is leased by agent-b", at: 7000 });
    expect(sysLines(s, "a1")[0]).toContain("lease contended");
  });

  it("is sticky across later plain status events", () => {
    let s = reduce(initialState, ev({ agentId: "a1", kind: "status", data: { state: "running", worktreeLeaseContended: "x" } }));
    s = reduce(s, ev({ agentId: "a1", kind: "status", data: { state: "idle" } }));
    expect(s.agents["a1"]?.worktreeLeaseContended?.message).toBe("x");
  });
});

describe("F22.UI — shared chip wording", () => {
  it("derives the lease key from the worktree path (core's worktreePath layout)", () => {
    expect(worktreeKeyFromWorkdir("/repo/.chimera/worktrees/wk-1")).toBe("wk-1");
    expect(worktreeKeyFromWorkdir("/repo/.chimera/worktrees/wk-1/")).toBe("wk-1");
    expect(worktreeKeyFromWorkdir("/repo")).toBeNull();
    expect(worktreeKeyFromWorkdir(null)).toBeNull();
  });

  it("labels the held chip with key and observed mode", () => {
    const chips = worktreeLeaseChips({ worktreeLeaseHeld: true, worktreeLeaseMode: "enforce", workdir: "/repo/.chimera/worktrees/wk-1" });
    expect(chips).toHaveLength(1);
    expect(chips[0]!.label).toBe("⌂ sole writer wk-1 · enforce");
  });

  it("omits the mode suffix when no lease decision has been observed", () => {
    const chips = worktreeLeaseChips({ worktreeLeaseHeld: true, workdir: "/repo/.chimera/worktrees/wk-1" });
    expect(chips[0]!.label).toBe("⌂ sole writer wk-1");
    expect(chips[0]!.title).toContain("No lease decision observed yet");
  });

  it("emits denied + contended chips with the holder in the title", () => {
    const chips = worktreeLeaseChips({
      worktreeLeaseDenied: true,
      lastWorktreeLeaseDenial: { tool: "Bash", workdirKey: "wk-1", owner: "agent-owner-1234567", ownerState: "retained", target: "/t", requestId: "r", at: 1 },
      worktreeLeaseContended: { message: "m", at: 2 },
      workdir: null,
    });
    expect(chips.map((c) => c.kind)).toEqual(["denied", "contended"]);
    expect(chips[0]!.label).toBe("⚠ worktree owned by agent-ow");
    expect(chips[0]!.title).toContain("retains the lease");
    expect(chips[1]!.title).toContain("m");
  });

  it("renders nothing for an agent with no lease facts", () => {
    expect(worktreeLeaseChips({ workdir: "/repo" })).toEqual([]);
  });
});
