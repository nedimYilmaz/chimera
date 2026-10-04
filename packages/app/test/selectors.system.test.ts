// W6 unit gates — selectors.system.ts: the help-from-keymap projection
// (coverage B11: generated, no hand lists, unbound rows skipped), the
// budget-pause detector and the result-card meta derivation.
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, type AgentView, type UiState } from "@chimera/ui-state";
import { KEYMAP, type KeymapRow } from "../src/keymap";
import type { PeerStatus } from "@chimera/ui-state";
import {
  accountSpendLabel,
  budgetPauseForSelected,
  fmtDurationLong,
  helpColumns,
  holdPauseForSelected,
  peerChipModel,
  pickToast,
  resultMetaParts,
} from "../src/state/selectors.system";

describe("helpColumns (B11: generated from the keymap, no dead chords)", () => {
  const rows: readonly KeymapRow[] = [
    { chord: "?", action: "help.toggle", scope: "global", label: "help" },
    { chord: "1", action: "tab.agents", scope: "global", label: "agents" },
    { chord: "2", action: "tab.projects", scope: "global", label: "projects", unbound: true },
    { chord: "3", action: "tab.teams", scope: "global", label: "teams" },
    { chord: "up", action: "agents.up", scope: "agents", label: "select" },
    { chord: "down", action: "agents.down", scope: "agents", label: "select" },
    { chord: "left", action: "agents.foldLeft", scope: "agents", label: "fold" },
    { chord: "right", action: "agents.foldRight", scope: "agents", label: "fold" },
    { chord: "ctrl+n", action: "teams.new", scope: "teams", label: "new team" },
    { chord: "ctrl+n", action: "queues.new", scope: "queues", label: "push task" },
    { chord: "enter", action: "memory.expand", scope: "memory", label: "expand" },
  ];

  it("produces the three mock columns", () => {
    const cols = helpColumns(rows);
    expect(cols.map((c) => c.title)).toEqual(["global", "agents", "panes & mouse"]);
  });

  it("skips unbound rows (every chord shown resolves)", () => {
    const cols = helpColumns(rows);
    const all = cols.flatMap((c) => c.entries.map((e) => `${e.chord} ${e.label}`)).join("\n");
    expect(all).not.toContain("projects");
  });

  it("collapses the numeric tab rows into one range entry", () => {
    const globalCol = helpColumns(rows)[0]!;
    expect(globalCol.entries[0]).toEqual({ chord: "1-3", label: "jump to tab" });
    expect(globalCol.entries.some((e) => e.chord === "1")).toBe(false);
  });

  it("merges consecutive same-label rows into arrow pairs", () => {
    const agents = helpColumns(rows)[1]!;
    expect(agents.entries).toEqual([
      { chord: "↑↓", label: "select" },
      { chord: "←→", label: "fold" },
    ]);
  });

  it("folds cross-scope chords in column 3, joining labels", () => {
    const panes = helpColumns(rows)[2]!;
    expect(panes.entries).toContainEqual({ chord: "ctrl+n", label: "new team / push task" });
    expect(panes.entries).toContainEqual({ chord: "enter", label: "expand" });
  });

  it("the REAL keymap projects with no empty column and no unbound chord", () => {
    const cols = helpColumns(KEYMAP);
    for (const c of cols) expect(c.entries.length).toBeGreaterThan(0);
    const unboundChords = KEYMAP.filter((r) => r.unbound).map((r) => r.chord);
    for (const c of cols) {
      for (const e of c.entries) {
        for (const dead of unboundChords) {
          // an unbound chord may only appear if a BOUND row shares it
          if (e.chord === dead) {
            expect(KEYMAP.some((r) => !r.unbound && r.chord === dead)).toBe(true);
          }
        }
      }
    }
  });
});

const ev = (partial: Partial<NormalizedEvent> & { kind: string }): NormalizedEvent =>
  ({ seq: 1, ts: 0, agentId: "a1", data: {}, ...partial }) as NormalizedEvent;

const agent = (partial: Partial<AgentView>): AgentView =>
  ({
    agentId: "a1", state: "running", conductor: false, transcript: [], tools: [],
    costUsd: 0, usage: null, lastEventTs: 0, pendingQuestion: null, pendingDialog: null,
    busy: false, resultDetail: null, historyLoaded: false, flowTree: [], slashCommands: [],
    ...partial,
  }) as AgentView;

describe("budgetPauseForSelected (A6-3 / B7 banner)", () => {
  const base: UiState = {
    ...initialState,
    selectedAgentId: "a1",
    agents: { a1: agent({ treeId: "t1" }) },
    agentOrder: ["a1"],
  };

  it("finds the selected tree's budget pause", () => {
    const state: UiState = {
      ...base,
      events: [ev({ kind: "status", agentId: "t1", data: { paused: true, reason: "budget", treeId: "t1", maxBudgetUsd: 2, totalCostUsd: 2.11 } })],
    };
    expect(budgetPauseForSelected(state)).toEqual({ treeId: "t1", maxBudgetUsd: 2, totalCostUsd: 2.11, estimatedUsd: 0, afterResume: false });
  });

  it("carries estimatedUsd and afterResume from the pause event", () => {
    const state: UiState = {
      ...base,
      events: [ev({ kind: "status", agentId: "t1", data: { paused: true, reason: "budget", treeId: "t1", maxBudgetUsd: 2, totalCostUsd: 2.37, estimatedUsd: 1.9, afterResume: true } })],
    };
    expect(budgetPauseForSelected(state)).toEqual({ treeId: "t1", maxBudgetUsd: 2, totalCostUsd: 2.37, estimatedUsd: 1.9, afterResume: true });
  });

  it("a resumed pause (paused:false, resumed:true) clears the banner", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "t1", data: { paused: true, reason: "budget", treeId: "t1", maxBudgetUsd: 2, totalCostUsd: 2.37 } }),
        ev({ kind: "status", agentId: "t1", data: { paused: false, reason: "budget", treeId: "t1", totalCostUsd: 2.37, maxBudgetUsd: 2, resumed: true } }),
      ],
    };
    expect(budgetPauseForSelected(state)).toBeNull();
  });

  it("ignores other trees' pauses and non-budget statuses", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "OTHER", data: { paused: true, reason: "budget", treeId: "OTHER", maxBudgetUsd: 5 } }),
        ev({ kind: "status", agentId: "t1", data: { paused: true, reason: "something-else" } }),
      ],
    };
    expect(budgetPauseForSelected(state)).toBeNull();
  });

  it("null without a selection", () => {
    expect(budgetPauseForSelected({ ...base, selectedAgentId: null })).toBeNull();
  });

  it("BUDGET-UNPAUSE-INVISIBLE: clears once a later reconciliation event un-pauses the tree", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "t1", data: { paused: true, reason: "budget", treeId: "t1", maxBudgetUsd: 2, totalCostUsd: 2.11, live: true } }),
        ev({ kind: "status", agentId: "t1", data: { paused: false, reason: "budget", treeId: "t1", totalCostUsd: 1.5, maxBudgetUsd: 2 } }),
      ],
    };
    expect(budgetPauseForSelected(state)).toBeNull();
  });
});

describe("holdPauseForSelected (idea-backlog: session-limit/crash-loop/reattach HOLDs)", () => {
  const base: UiState = {
    ...initialState,
    selectedAgentId: "a1",
    agents: { a1: agent({}) },
    agentOrder: ["a1"],
  };

  it("finds a session-limit HOLD on the selected agent", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "a1", data: { state: "paused", paused: true, reason: "session-limit", resumeScheduledAt: 5000, account: "acct1", detail: "hit your account limit" } }),
      ],
    };
    expect(holdPauseForSelected(state)).toEqual({
      agentId: "a1", reason: "session-limit", resumeScheduledAt: 5000, detail: "hit your account limit",
    });
  });

  it("finds a crash-loop-backoff HOLD", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "a1", data: { state: "paused", paused: true, reason: "crash-loop-backoff", resumeScheduledAt: 9000, detail: "backend crashed" } }),
      ],
    };
    expect(holdPauseForSelected(state)?.reason).toBe("crash-loop-backoff");
  });

  it("finds a reattach-recovery HOLD", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "a1", data: { state: "paused", paused: true, reason: "reattach-recovery", resumeScheduledAt: 9000, detail: "reattach failed: boom" } }),
      ],
    };
    expect(holdPauseForSelected(state)?.reason).toBe("reattach-recovery");
  });

  it("clears once a later status event marks the agent running again", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "a1", data: { state: "paused", paused: true, reason: "session-limit", resumeScheduledAt: 5000 } }),
        ev({ kind: "status", agentId: "a1", data: { state: "running", resumed: true, account: "acct1" } }),
      ],
    };
    expect(holdPauseForSelected(state)).toBeNull();
  });

  it("clears once the agent reaches a terminal state after the HOLD", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "a1", data: { state: "paused", paused: true, reason: "crash-loop-backoff", resumeScheduledAt: 5000 } }),
        ev({ kind: "status", agentId: "a1", data: { state: "failed", circuitOpen: true } }),
      ],
    };
    expect(holdPauseForSelected(state)).toBeNull();
  });

  it("ignores a budget pause and other agents' HOLDs", () => {
    const state: UiState = {
      ...base,
      events: [
        ev({ kind: "status", agentId: "a1", data: { paused: true, reason: "budget", treeId: "a1", maxBudgetUsd: 2 } }),
        ev({ kind: "status", agentId: "OTHER", data: { state: "paused", paused: true, reason: "session-limit", resumeScheduledAt: 5000 } }),
      ],
    };
    expect(holdPauseForSelected(state)).toBeNull();
  });

  it("null without a selection", () => {
    expect(holdPauseForSelected({ ...base, selectedAgentId: null })).toBeNull();
  });
});

describe("result meta + spend label", () => {
  it("fmtDurationLong renders the mock's '1m 48s' shape", () => {
    expect(fmtDurationLong(108_000)).toBe("1m 48s");
    expect(fmtDurationLong(9_000)).toBe("9s");
  });

  it("resultMetaParts renders only what the wire carries", () => {
    const detail = { result: { state: "done", text: "x", costUsd: 0.31 }, status: { createdAt: 1000 } };
    const a = agent({ usage: { input: 2000, output: 400, cacheRead: 0, cacheCreation: 0 }, lastEventTs: 109_000 });
    const events = [ev({ kind: "result", agentId: "a1", data: { num_turns: 4 } })];
    expect(resultMetaParts(detail, a, events, "a1")).toEqual(["$0.31", "2.4k tok", "4 turns", "1m 48s"]);
  });

  it("resultMetaParts degrades to cost-only", () => {
    const detail = { result: { state: "done", costUsd: 0.1 }, status: {} };
    expect(resultMetaParts(detail, agent({}), [], "a1")).toEqual(["$0.10"]);
  });

  it("accountSpendLabel: daemon field when present, '—' otherwise", () => {
    expect(accountSpendLabel({ spendTodayUsd: 1.85 })).toBe("$1.85");
    expect(accountSpendLabel({})).toBe("—");
  });
});

describe("peerChipModel (F01/B1: N>1 → one '⇅ N peers' chip)", () => {
  const peer = (over: Partial<PeerStatus>): PeerStatus => ({ engineId: "studio", state: "connected", outboxPending: 0, ...over });

  it("returns null when unfederated (no peers)", () => {
    expect(peerChipModel([])).toBeNull();
  });

  it("a single connected peer keeps the per-peer form", () => {
    expect(peerChipModel([peer({ engineId: "studio", outboxPending: 2 })])).toEqual({
      kind: "single", engineId: "studio", partitioned: false, outboxPending: 2,
    });
  });

  it("a single partitioned peer marks partitioned", () => {
    const m = peerChipModel([peer({ engineId: "studio", state: "partitioned", outboxPending: 3 })]);
    expect(m).toEqual({ kind: "single", engineId: "studio", partitioned: true, outboxPending: 3 });
  });

  it("N>1 collapses into one aggregate chip counting the peers", () => {
    const m = peerChipModel([peer({ engineId: "studio" }), peer({ engineId: "lab" })]);
    expect(m?.kind).toBe("aggregate");
    if (m?.kind !== "aggregate") throw new Error("expected aggregate");
    expect(m.count).toBe(2);
    expect(m.partitioned).toBe(false);
  });

  it("aggregate goes partitioned + sums outbox when ANY peer is partitioned", () => {
    const m = peerChipModel([
      peer({ engineId: "studio", state: "connected", outboxPending: 1 }),
      peer({ engineId: "lab", state: "partitioned", outboxPending: 4 }),
      peer({ engineId: "rig", state: "connected", outboxPending: 2 }),
    ]);
    if (m?.kind !== "aggregate") throw new Error("expected aggregate");
    expect(m.count).toBe(3);
    expect(m.partitioned).toBe(true);
    expect(m.outboxPending).toBe(7);
    // hover title lists every peer
    expect(m.title).toContain("studio");
    expect(m.title).toContain("lab");
    expect(m.title).toContain("rig");
    expect(m.title).toContain("4 out");
  });
});

describe("pickToast (F01: one slot — error outranks notice)", () => {
  it("nothing when both channels are clear", () => {
    expect(pickToast(null, null)).toBeNull();
  });
  it("the notice when only a notice is live", () => {
    expect(pickToast("saved", null)).toEqual({ channel: "note", message: "saved" });
  });
  it("the error when only an error is live", () => {
    expect(pickToast(null, "boom")).toEqual({ channel: "error", message: "boom" });
  });
  it("the error outranks a concurrent notice (never both)", () => {
    expect(pickToast("saved", "boom")).toEqual({ channel: "error", message: "boom" });
  });
});
