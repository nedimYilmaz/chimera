import { describe, expect, it } from "vitest";
import { emptyAgent, initialState, reduce, type AgentView, type TranscriptItem, type UiState } from "@chimera/ui-state";
import type { NormalizedEvent } from "@chimera/protocol";
import { contextWindowFor } from "@chimera/protocol";
import {
  accountToneVar,
  agentDetailView,
  agentMatchesQuery,
  agentMentions,
  agentName,
  autosizeInput,
  buildAgentRows,
  ctxPct,
  derivedState,
  displayName,
  conductorLabel,
  effectiveContextLimitForAgent,
  fleetSummary,
  flattenFlow,
  flowIcon,
  flowMeta,
  flowStatusVisual,
  fmtClock,
  fmtCost,
  fmtDurationSec,
  fmtTokens,
  fullContextTokens,
  groupTranscriptBlocks,
  hiddenTerminalAgentCount,
  isNearBottom,
  NEAR_BOTTOM_PX,
  ownerLabel,
  pushRing,
  remoteEngine,
  rowIndentDepth,
  scrollHintCounts,
  secondaryLabel,
  shadowParent,
  spawnedChildren,
  spawnLineageMap,
  mcpStatusGlyph,
  shortId,
  skillMcpSummary,
  sparkline,
  spendMeter,
  pauseSummary,
  stateVisual,
  summarizeToolRun,
  toneVar,
  totalSpendUsd,
  transcriptTimestamps,
  truncateExcerpt,
  visibleAgentIds,
  windowRange,
  windowRangeMeasured,
} from "../src/state/selectors";
import {
  hookFilterKeys, hookFilterKeysFor, hookDraftFilterIssue, hookFilterWarning,
  reconcileFilterKey, topicLabel,
} from "../src/state/selectors.hooks";

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

describe("fmtTokens", () => {
  it("renders the mock's k form with one decimal under 100k", () => {
    expect(fmtTokens(400)).toBe("0.4k");
    expect(fmtTokens(900)).toBe("0.9k");
    expect(fmtTokens(5000)).toBe("5.0k");
    expect(fmtTokens(18_200)).toBe("18.2k");
    expect(fmtTokens(99_949)).toBe("99.9k");
  });
  it("drops the decimal from 100k and switches to M at a million", () => {
    expect(fmtTokens(100_000)).toBe("100k");
    expect(fmtTokens(250_500)).toBe("251k");
    expect(fmtTokens(2_300_000)).toBe("2.3M");
    expect(fmtTokens(12_000_000)).toBe("12M");
  });
  it("placeholders null/undefined usage and clamps garbage", () => {
    expect(fmtTokens(null)).toBe("—");
    expect(fmtTokens(undefined)).toBe("—");
    expect(fmtTokens(-5)).toBe("0.0k");
    expect(fmtTokens(Number.NaN)).toBe("0.0k");
  });
});

describe("fmtCost / fmtClock / fmtDurationSec / shortId", () => {
  it("formats cost as $X.XX", () => {
    expect(fmtCost(0)).toBe("$0.00");
    expect(fmtCost(1.125)).toBe("$1.13");
  });
  it("guards non-finite cost instead of rendering $NaN/$Infinity", () => {
    expect(fmtCost(Number.NaN)).toBe("—");
    expect(fmtCost(Number.POSITIVE_INFINITY)).toBe("—");
    expect(fmtCost(Number.NEGATIVE_INFINITY)).toBe("—");
  });
  it("formats a local wall clock HH:MM:SS", () => {
    const d = new Date();
    d.setHours(14, 1, 12, 0);
    expect(fmtClock(d.getTime())).toBe("14:01:12");
  });
  it("formats whole-second durations", () => {
    expect(fmtDurationSec(41_000)).toBe("41s");
    expect(fmtDurationSec(1499)).toBe("1s");
    expect(fmtDurationSec(-5)).toBe("0s");
  });
  it("shortens ids to 8 chars", () => {
    expect(shortId("8570a3d3-ebeb-4829")).toBe("8570a3d3");
  });
});

// ---------------------------------------------------------------------------
// naming / identity
// ---------------------------------------------------------------------------

describe("agentName / displayName / secondaryLabel / remoteEngine", () => {
  it("derives deterministic FNV names (parity with the TUI)", () => {
    // ids brute-forced against the TUI's own FNV tables for the visual gate
    expect(agentName("8570a3d3-ebeb-4829-ada0-0004b1aa0001")).toBe("eager-weasel");
    expect(agentName("studio/f7a21c30-9d4e-4b6a-a1b2-000383aa0001")).toBe("brisk-otter");
  });
  it("names the conductor 'main' and a shadow by its label", () => {
    const conductor: AgentView = { ...emptyAgent("c0ffee00-1"), conductor: true };
    expect(displayName(conductor)).toBe("main");
    expect(secondaryLabel(conductor)).toBe("conductor");
    // a per-project conductor reads its PROJECT NAME, not a second "main"
    const projectConductor: AgentView = { ...emptyAgent("c0ffee00-9"), conductor: true, projectId: "chimera" };
    expect(displayName(projectConductor)).toBe("chimera");
    expect(secondaryLabel(projectConductor)).toBe("conductor");
  });
  it("prefers a custom display label over generated, conductor, and shadow naming rules", () => {
    const worker: AgentView = { ...emptyAgent("worker-1"), displayLabel: "release captain" };
    const conductor: AgentView = {
      ...emptyAgent("conductor-1"), conductor: true, projectId: "chimera",
      displayLabel: "project lead", state: "running",
    };
    const shadow: AgentView = {
      ...emptyAgent("shadow:parent:1"), shadow: true, label: "code-review",
      displayLabel: "named reviewer",
    };

    expect(displayName(worker)).toBe("release captain");
    expect(displayName(conductor)).toBe("project lead");
    expect(conductorLabel({ [conductor.agentId]: conductor }, conductor.agentId)).toBe("project lead");
    expect(displayName(shadow)).toBe("named reviewer");
  });
  it("conductorLabel disambiguates same-project conductors with a numeric suffix", () => {
    const main: AgentView = { ...emptyAgent("aaaa-main"), conductor: true, state: "running" };
    const c1: AgentView = { ...emptyAgent("aaaa-c1"), conductor: true, projectId: "chimera", state: "running" };
    const c2: AgentView = { ...emptyAgent("bbbb-c2"), conductor: true, projectId: "chimera", state: "running" };
    const worker: AgentView = { ...emptyAgent("cccc-w"), membership: { team: "t", role: "r" } };
    const agents = { [main.agentId]: main, [c1.agentId]: c1, [c2.agentId]: c2, [worker.agentId]: worker };
    expect(conductorLabel(agents, main.agentId)).toBe("main");          // lone top-level session
    expect(conductorLabel(agents, c1.agentId)).toBe("chimera");         // first (sorted by id)
    expect(conductorLabel(agents, c2.agentId)).toBe("chimera-2");       // duplicate gets a suffix
    expect(conductorLabel(agents, worker.agentId)).toBe(displayName(worker)); // non-conductor unchanged
    const shadow: AgentView = { ...emptyAgent("dead0001-2"), shadow: true, label: "code-review" };
    expect(displayName(shadow)).toBe("code-review");
    expect(secondaryLabel(shadow)).toBe("");
  });
  it("conductorLabel falls back to a caller-supplied project name (not a bare short id) when the row is still absent from the agents map — reconnect-race belt-and-braces", () => {
    const agents: Record<string, AgentView> = {};
    expect(conductorLabel(agents, "b0d0a8fd-live-conductor-id", "PROJ-12344")).toBe("PROJ-12344");
    // omitted fallback stays byte-identical to before (bare short id)
    expect(conductorLabel(agents, "b0d0a8fd-live-conductor-id")).toBe(shortId("b0d0a8fd-live-conductor-id"));
  });
  it("conductorLabel counts only LIVE conductors as siblings, not terminal or membership-carrying rows", () => {
    // (a) a running conductor plus a FAILED conductor for the same project: the
    // failed one must not push the live one to "-2" (the bug this guards against).
    const live: AgentView = { ...emptyAgent("aaaa-live"), conductor: true, projectId: "infra", state: "running" };
    const dead: AgentView = { ...emptyAgent("bbbb-dead"), conductor: true, projectId: "infra", state: "failed" };
    const agentsA = { [live.agentId]: live, [dead.agentId]: dead };
    expect(conductorLabel(agentsA, live.agentId)).toBe("infra");
    expect(conductorLabel(agentsA, dead.agentId)).toBe("infra"); // the dead one isn't numbered either

    // (b) a running conductor plus a workflow-step row that scheduler.ts forces
    // conductor:true on but which carries team membership — never a real conductor.
    const step: AgentView = {
      ...emptyAgent("cccc-step"),
      conductor: true,
      projectId: "infra",
      state: "running",
      membership: { team: "t", role: "r" },
    };
    const agentsB = { [live.agentId]: live, [step.agentId]: step };
    expect(conductorLabel(agentsB, live.agentId)).toBe("infra");

    // (c) two genuinely live (running/paused) conductors for the same project
    // still get disambiguated, ordered by agentId.
    const liveB: AgentView = { ...emptyAgent("dddd-live2"), conductor: true, projectId: "infra", state: "paused" };
    const agentsC = { [live.agentId]: live, [liveB.agentId]: liveB };
    expect(conductorLabel(agentsC, live.agentId)).toBe("infra");
    expect(conductorLabel(agentsC, liveB.agentId)).toBe("infra-2");

    // (d) a non-conductor is unaffected by any of this.
    const worker: AgentView = { ...emptyAgent("eeee-w"), projectId: "infra" };
    const agentsD = { [live.agentId]: live, [worker.agentId]: worker };
    expect(conductorLabel(agentsD, worker.agentId)).toBe(displayName(worker));
  });
  it("marks remote agents by their engine prefix", () => {
    expect(remoteEngine("studio/abc")).toBe("studio");
    expect(remoteEngine("abc")).toBeNull();
    const remote: AgentView = emptyAgent("studio/f7a21c30-9d4e-4b6a-a1b2-000383aa0001");
    expect(secondaryLabel(remote)).toBe("@studio");
  });
});

describe("derivedState / stateVisual", () => {
  it("derives waiting from a pending question", () => {
    const a: AgentView = {
      ...emptyAgent("x"),
      state: "running",
      pendingQuestion: { questionId: "q", prompt: "?", multiSelect: false, freeform: false },
    };
    expect(derivedState(a)).toBe("waiting");
    expect(stateVisual("waiting")).toEqual({ glyph: "◌", tone: "warn" });
  });
  it("derives waiting from a pending native dialog (AskUserQuestion/elicitation — DLG3)", () => {
    const a: AgentView = {
      ...emptyAgent("x"),
      state: "running",
      pendingDialog: { dialogId: "d1", dialogKind: "permission_ask_user_question", payload: {} },
    };
    expect(derivedState(a)).toBe("waiting");
  });
  it("maps every mock state glyph", () => {
    expect(stateVisual("running")).toEqual({ glyph: "◐", tone: "success" });
    expect(stateVisual("done")).toEqual({ glyph: "●", tone: "info" });
    expect(stateVisual("killed")).toEqual({ glyph: "⊘", tone: "warn" });
    expect(stateVisual("failed")).toEqual({ glyph: "✗", tone: "danger" });
    expect(stateVisual("unknown")).toEqual({ glyph: "·", tone: "muted" });
  });
  // PAUSED-AGENTS-VISIBLE: "paused" used to fall through to the SAME muted "·" as "unknown" —
  // indistinguishable from a stale/never-projected row in a fleet of hundreds.
  it("gives 'paused' its own glyph, distinct from 'unknown'", () => {
    expect(stateVisual("paused")).toEqual({ glyph: "⏸", tone: "warn" });
    expect(stateVisual("paused")).not.toEqual(stateVisual("unknown"));
  });
});

describe("pauseSummary (PAUSED-AGENTS-VISIBLE)", () => {
  it("labels each real pauseReason distinctly", () => {
    expect(pauseSummary({ pauseReason: "session-limit", resumeAt: undefined })).toBe("session limit");
    expect(pauseSummary({ pauseReason: "crash-loop-backoff", resumeAt: undefined })).toBe("crash loop");
    expect(pauseSummary({ pauseReason: "reattach-recovery", resumeAt: undefined })).toBe("reattach recovery");
  });
  it("appends the resume clock time when known", () => {
    const noon = new Date(2000, 0, 1, 12, 0, 0).getTime();
    expect(pauseSummary({ pauseReason: "session-limit", resumeAt: noon })).toBe("session limit · resumes 12:00:00");
  });
  it("degrades gracefully with no reason at all (older daemon)", () => {
    expect(pauseSummary({ pauseReason: undefined, resumeAt: undefined })).toBe("unknown reason");
  });
});

// ---------------------------------------------------------------------------
// agent rows: tree / team-group / fold
// ---------------------------------------------------------------------------

function fleetState(): UiState {
  const mk = (id: string, extra: Partial<AgentView>): AgentView => ({ ...emptyAgent(id), state: "running", ...extra });
  const agents: Record<string, AgentView> = {
    main: mk("main", { conductor: true }),
    w1: mk("w1", { membership: { team: "tui-crew", role: "dev" }, treeId: "w1", depth: 0 }),
    w2: mk("w2", { membership: { team: "tui-crew", role: "dev" }, treeId: "w2", depth: 0, state: "done" }),
    sh: mk("sh", { treeId: "w2", depth: 1, shadow: true, label: "code-review", pendingQuestion: { questionId: "q", prompt: "?", multiSelect: false, freeform: false } }),
    solo: mk("solo", { state: "killed" }),
    remote: mk("studio/r1", { }),
  };
  // key fix: the remote agent's map key is its qualified id
  delete agents["remote"];
  agents["studio/r1"] = mk("studio/r1", {});
  return {
    ...initialState,
    agents,
    agentOrder: ["main", "w1", "w2", "sh", "solo", "studio/r1"],
    teams: { available: true, items: [{ name: "tui-crew", createdBy: "main" }] },
  };
}

describe("buildAgentRows (P3-T3: no team header — every row is a plain agent row)", () => {
  it("clusters the team's tree contiguously with no header row", () => {
    const rows = buildAgentRows(fleetState());
    expect(rows.map((r) => r.agentId)).toEqual(["main", "w1", "w2", "sh", "solo", "studio/r1"]);
    expect(rows.every((r) => r.kind === "agent")).toBe(true);
  });
  it("computes display depth: PURE spawn-tree depth (no team bump), and marks collapsible parents", () => {
    const rows = buildAgentRows(fleetState());
    const w2 = rows.find((r) => r.agentId === "w2");
    const sh = rows.find((r) => r.agentId === "sh");
    expect(w2 ? { depth: w2.depth, collapsible: w2.collapsible } : null).toEqual({ depth: 0, collapsible: true });
    expect(sh?.depth).toBe(1);
  });
  it("folds a collapsed subtree (children hidden, parent kept)", () => {
    const s = fleetState();
    const folded: UiState = { ...s, collapsed: new Set(["w2"]) };
    const ids = buildAgentRows(folded).map((r) => r.agentId);
    expect(ids).toEqual(["main", "w1", "w2", "solo", "studio/r1"]);
    const row = buildAgentRows(folded).find((r) => r.agentId === "w2");
    expect(row?.collapsed).toBe(true);
    // AGENTLIST-CARET-REMOVAL: the folded parent reports how many descendant rows
    // it hid, for the render's dim "+N" indicator (w2 hid its one child `sh`).
    expect(row?.hiddenCount).toBe(1);
    // an OPEN parent hides nothing -> hiddenCount 0
    expect(buildAgentRows(s).find((r) => r.agentId === "w2")?.hiddenCount).toBe(0);
  });
  it("skips stale order entries defensively", () => {
    const s = fleetState();
    const withStale: UiState = { ...s, agentOrder: [...s.agentOrder, "ghost"] };
    expect(buildAgentRows(withStale)).toHaveLength(6);
  });
  it("groups a newly-spawned teammate into its team's cluster even though the reducer appended it to the END of agentOrder", () => {
    const s = fleetState();
    const w3: AgentView = { ...emptyAgent("w3"), state: "running", membership: { team: "tui-crew", role: "dev" }, treeId: "w3", depth: 0 };
    // reducer always pushes new agents to the tail of agentOrder — not contiguous with the rest of tui-crew.
    const withNewTeammate: UiState = { ...s, agents: { ...s.agents, w3 }, agentOrder: [...s.agentOrder, "w3"] };
    const rows = buildAgentRows(withNewTeammate);
    expect(rows.map((r) => r.agentId)).toEqual(["main", "w1", "w2", "sh", "w3", "solo", "studio/r1"]);
    // w3 renders spliced into the crew cluster (not detached at the bottom), badge-carrying via its own membership.
    expect(withNewTeammate.agents["w3"]?.membership?.team).toBe("tui-crew");
  });

  // LINEAGE (shadow-live-state's remainder): a native Agent/Task-tool sub-agent shadow born
  // PURELY from the live event stream (no agent.list snapshot for it — the app never re-fetches
  // that snapshot after connect, see createStore.ts) must still nest under its spawner instead
  // of rendering as a detached top-level row. supervisor.ts's shadow-directed agent_task re-emit
  // now carries parentId/treeId/depth (reducer.ts folds them); this drives that end-to-end
  // through the real `reduce` dispatcher, not a hand-built AgentView fixture.
  it("nests an event-born shadow (no snapshot ever dispatched for it) directly under its live parent", () => {
    // The parent itself IS known (a prior agent.list snapshot, or its own agent_started) —
    // only the sub-agent shadow is event-only, matching the real repro (a running worker
    // spawning native sub-agents mid-session).
    const withParent = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "keen-raven", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "keen-raven", depth: 0 }],
    });
    const withShadow = reduce(withParent, {
      type: "event",
      event: {
        ts: 2, seq: 1, agentId: "shadow:keen-raven:T1", kind: "agent_task",
        data: { taskId: "T1", subagentType: "general-purpose", status: "running", parentId: "keen-raven", treeId: "keen-raven", depth: 1 },
      },
    });
    const rows = buildAgentRows(withShadow);
    const ids = rows.map((r) => r.agentId);
    expect(ids).toEqual(["keen-raven", "shadow:keen-raven:T1"]); // spliced right after its parent, not detached at the end
    const shadowRow = rows.find((r) => r.agentId === "shadow:keen-raven:T1")!;
    expect(shadowRow.depth).toBe(1);       // nested one indent under keen-raven, not depth 0
    expect(shadowRow.collapsible).toBe(false);
    const parentRow = rows.find((r) => r.agentId === "keen-raven")!;
    expect(parentRow.collapsible).toBe(true); // has a child -> collapsible, proving real nesting (not just adjacency)
  });

  // SHADOW-NESTING-UI: the reported bug — a QUEUE-SPAWNED team worker carries originConductorId
  // (so its own indent is bumped +1 to sit under the conductor), and an event-born shadow it
  // spawns must be bumped the SAME way, else the shadow rendered at the worker's OWN indent — a
  // sibling of the worker directly under the conductor, not nested one level deeper under it.
  it("nests an event-born shadow UNDER a queue-spawned (conductor-owned) worker, not beside it under the conductor", () => {
    // conductor + its queue worker arrive via the connect snapshot; the 3 sub-agent shadows
    // are event-only (spawned mid-session), matching the sunny-narwhal repro.
    const snap = reduce(initialState, {
      type: "agentRecords",
      records: [
        { agentId: "cond-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, treeId: "cond-1", depth: 0, originConductorId: null, spec: { conductor: true } },
        { agentId: "worker-1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2, treeId: "worker-1", depth: 0, parentId: null, originConductorId: "cond-1", membership: { team: "crew", role: "worker" } },
      ],
    });
    let st = snap;
    for (const t of ["T1", "T2", "T3"]) {
      st = reduce(st, {
        type: "event",
        event: {
          ts: 3, seq: Number(t.slice(1)), agentId: `shadow:worker-1:${t}`, kind: "agent_task",
          data: { taskId: t, subagentType: "Explore", status: "running", parentId: "worker-1", treeId: "worker-1", depth: 1, projectId: null, originConductorId: "cond-1", membership: { team: "crew", role: "worker" } },
        },
      });
    }
    const rows = buildAgentRows(st);
    const byId = new Map(rows.map((r) => [r.agentId, r]));
    // conductor at indent 0, worker bumped to indent 1 (under it), shadows at indent 2 (under the worker).
    expect(byId.get("cond-1")!.depth).toBe(0);
    expect(byId.get("worker-1")!.depth).toBe(1);
    for (const t of ["T1", "T2", "T3"]) {
      expect(byId.get(`shadow:worker-1:${t}`)!.depth).toBe(2); // one deeper than the worker, NOT its sibling
    }
    // Ordering: every shadow renders AFTER (below) the worker, never above it.
    const ids = rows.map((r) => r.agentId);
    const wIdx = ids.indexOf("worker-1");
    for (const t of ["T1", "T2", "T3"]) expect(ids.indexOf(`shadow:worker-1:${t}`)).toBeGreaterThan(wIdx);
    expect(byId.get("worker-1")!.collapsible).toBe(true); // real nesting: worker owns the shadows
  });
});

// ---------------------------------------------------------------------------
// SEARCH-AGENTS: agentMatchesQuery / buildAgentRows+query / visibleAgentIds
// ---------------------------------------------------------------------------

describe("agentMatchesQuery", () => {
  it("matches name/label, short id, state, and team — case-insensitive", () => {
    const s = fleetState();
    expect(agentMatchesQuery(s.agents["w1"]!, "TUI-CREW")).toBe(true); // team
    expect(agentMatchesQuery(s.agents["w2"]!, "done")).toBe(true); // derived state
    expect(agentMatchesQuery(s.agents["sh"]!, "code-review")).toBe(true); // shadow label (its displayName)
    expect(agentMatchesQuery(s.agents["solo"]!, shortId("solo"))).toBe(true); // short id
    expect(agentMatchesQuery(s.agents["w1"]!, "nope")).toBe(false);
  });
  it("an empty/blank query matches everything", () => {
    const s = fleetState();
    expect(agentMatchesQuery(s.agents["w1"]!, "")).toBe(true);
    expect(agentMatchesQuery(s.agents["w1"]!, "   ")).toBe(true);
  });
});

describe("buildAgentRows with a query (SEARCH-AGENTS)", () => {
  it("keeps only matches plus their ancestors, dropping the rest", () => {
    const rows = buildAgentRows(fleetState(), "code-review");
    // sh (the shadow labeled code-review) plus its ancestor w2 — main/w1/solo/remote drop out.
    expect(rows.map((r) => r.agentId)).toEqual(["w2", "sh"]);
  });
  it("a match with no matched descendants keeps its own row only (no orphaned unrelated rows)", () => {
    const rows = buildAgentRows(fleetState(), "tui-crew");
    expect(rows.map((r) => r.agentId)).toEqual(["w1", "w2"]); // sh doesn't match "tui-crew" and isn't anyone's ancestor
  });
  it("matches the derived state across the whole fleet", () => {
    const rows = buildAgentRows(fleetState(), "killed");
    expect(rows.map((r) => r.agentId)).toEqual(["solo"]);
  });
  it("no matches → empty row list", () => {
    expect(buildAgentRows(fleetState(), "no-such-agent-xyz")).toEqual([]);
  });
  it("is case-insensitive and trims whitespace", () => {
    expect(buildAgentRows(fleetState(), "  KILLED  ").map((r) => r.agentId)).toEqual(["solo"]);
  });
  it("an active query overrides a manual fold so a matched descendant stays visible", () => {
    const s = fleetState();
    const folded: UiState = { ...s, collapsed: new Set(["w2"]) };
    // Without a query, folding w2 hides sh (existing behavior, asserted above).
    expect(buildAgentRows(folded).map((r) => r.agentId)).not.toContain("sh");
    // With a query matching sh, it must reappear even though w2 is still folded.
    const rows = buildAgentRows(folded, "code-review");
    expect(rows.map((r) => r.agentId)).toEqual(["w2", "sh"]);
    expect(rows.find((r) => r.agentId === "w2")?.collapsed).toBe(true); // fold state itself is untouched
  });
  it("clearing the query (empty string) restores the full unfiltered tree", () => {
    const s = fleetState();
    expect(buildAgentRows(s, "").map((r) => r.agentId)).toEqual(buildAgentRows(s).map((r) => r.agentId));
  });
});

describe("visibleAgentIds with a query", () => {
  it("mirrors buildAgentRows' filtered agent ids", () => {
    expect(visibleAgentIds(fleetState(), "code-review")).toEqual(["w2", "sh"]);
    expect(visibleAgentIds(fleetState())).toEqual(visibleAgentIds(fleetState(), ""));
  });
});

// ---------------------------------------------------------------------------
// AGENTS-HIDE-DONE: buildAgentRows(state, query, showDone) / hiddenTerminalAgentCount
// fleetState() recap: main(running,conductor) w1(running,tui-crew) w2(done,
// tui-crew, parent of sh) sh(shadow, pendingQuestion -> derived "waiting",
// child of w2) solo(killed, standalone) studio/r1(running, remote).
// ---------------------------------------------------------------------------

describe("buildAgentRows with showDone (AGENTS-HIDE-DONE)", () => {
  it("showDone omitted/true keeps today's full unfiltered behavior (backward compatible default)", () => {
    const s = fleetState();
    expect(buildAgentRows(s, "", true).map((r) => r.agentId)).toEqual(buildAgentRows(s).map((r) => r.agentId));
  });
  it("showDone=false drops standalone terminal agents but keeps a terminal ancestor of a visible active descendant", () => {
    const rows = buildAgentRows(fleetState(), "", false);
    // solo (killed, no active descendants) is gone; w2 (done) survives ONLY
    // because its child sh is active ("waiting") — the tree-path exception.
    expect(rows.map((r) => r.agentId)).toEqual(["main", "w1", "w2", "sh", "studio/r1"]);
  });
  it("a terminal agent with no active descendants disappears entirely when showDone=false", () => {
    const s = fleetState();
    // strip sh's pendingQuestion so w2's whole subtree is terminal/inactive.
    const noQuestion: UiState = { ...s, agents: { ...s.agents, sh: { ...s.agents["sh"]!, pendingQuestion: null, state: "done" } } };
    const rows = buildAgentRows(noQuestion, "", false);
    expect(rows.map((r) => r.agentId)).toEqual(["main", "w1", "studio/r1"]);
  });
  it("a non-empty query always overrides showDone — search reaches terminal agents regardless of the toggle", () => {
    // "killed" only matches solo, a terminal agent that showDone=false would otherwise hide.
    expect(buildAgentRows(fleetState(), "killed", false).map((r) => r.agentId)).toEqual(["solo"]);
    expect(buildAgentRows(fleetState(), "killed", false)).toEqual(buildAgentRows(fleetState(), "killed", true));
  });
  it("visibleAgentIds forwards showDone the same way", () => {
    expect(visibleAgentIds(fleetState(), "", false)).toEqual(["main", "w1", "w2", "sh", "studio/r1"]);
  });
});

describe("hiddenTerminalAgentCount (AGENTS-HIDE-DONE)", () => {
  it("counts terminal agents the default filter actually hides, excluding a terminal ancestor kept for an active descendant", () => {
    // w2 is terminal (done) but stays visible as sh's ancestor, so it must
    // NOT count toward the hidden total — only solo is truly hidden.
    expect(hiddenTerminalAgentCount(fleetState())).toBe(1);
  });
  it("counts every terminal agent once its active descendants are gone too", () => {
    const s = fleetState();
    const noQuestion: UiState = { ...s, agents: { ...s.agents, sh: { ...s.agents["sh"]!, pendingQuestion: null, state: "done" } } };
    expect(hiddenTerminalAgentCount(noQuestion)).toBe(3); // w2, sh, solo
  });
  it("is zero when nothing is terminal", () => {
    const s = fleetState();
    const allActive: UiState = { ...s, agents: { ...s.agents, w2: { ...s.agents["w2"]!, state: "running" }, solo: { ...s.agents["solo"]!, state: "running" } } };
    expect(hiddenTerminalAgentCount(allActive)).toBe(0);
  });
  it("is independent of any in-progress search text", () => {
    expect(hiddenTerminalAgentCount(fleetState())).toBe(1);
  });
});

describe("fleetSummary", () => {
  it("counts ALL records with waiting derived from pendingQuestion", () => {
    const s = fleetState();
    expect(fleetSummary(s)).toEqual({ total: 6, running: 3, paused: 0, done: 1, waiting: 1, killed: 1, failed: 0, unseen: 0, needsOperator: 0, costUsd: 0 });
  });
  // F47: the attention count the app's title chip renders. Counted like every other state
  // above — over agentOrder, so it is fold- and filter-insensitive.
  it("counts the agents whose attention is newer than the last review", () => {
    const s = fleetState();
    s.agents["w1"] = { ...s.agents["w1"]!, attentionAt: 300 };                    // never reviewed
    s.agents["w2"] = { ...s.agents["w2"]!, attentionAt: 300, reviewedAt: 100 };   // reviewed BEFORE
    s.agents["solo"] = { ...s.agents["solo"]!, attentionAt: 300, reviewedAt: 900 }; // already read
    expect(fleetSummary(s).unseen).toBe(2);
  });
  it("is fold-INSENSITIVE: a subtree fold hides rows, never shrinks the fleet totals/cost", () => {
    const s = fleetState();
    s.agents["w1"] = { ...s.agents["w1"]!, costUsd: 0.64 };
    const folded: UiState = { ...s, collapsed: new Set(["w2"]) }; // hides sh, w2's only child
    const sum = fleetSummary(folded);
    expect(sum.total).toBe(6);                 // review finding 8: was 3 (visible-only)
    expect(sum.costUsd).toBeCloseTo(0.64);     // folded w1's cost still counted
    expect(sum).toEqual(fleetSummary(s));      // identical to the unfolded fleet
  });
});

describe("ownerLabel / shadowParent / rowIndentDepth", () => {
  it("labels a conductor-created team 'owned by main'", () => {
    expect(ownerLabel(fleetState(), "tui-crew")).toBe("main");
  });
  it("labels a team created by a PROJECT conductor with its project name, not 'main'", () => {
    const s = fleetState();
    const projectConductor: AgentView = { ...emptyAgent("proj-cond"), state: "running", conductor: true, projectId: "chimera" };
    const withProjectTeam: UiState = {
      ...s,
      agents: { ...s.agents, "proj-cond": projectConductor },
      teams: { available: true, items: [{ name: "chimera-dev", createdBy: "proj-cond" }] },
    };
    expect(ownerLabel(withProjectTeam, "chimera-dev")).toBe("chimera");
  });
  it("resolves a shadow's parent through the tree", () => {
    const s = fleetState();
    expect(shadowParent(s, "sh")?.agentId).toBe("w2");
    expect(shadowParent(s, "w1")).toBeNull();
  });
  it("clamps indent depth to 4 (P3-T3: pure spawn depth, no team bump)", () => {
    const deep: AgentView = { ...emptyAgent("d"), depth: 9 };
    expect(rowIndentDepth(deep)).toBe(4);
    expect(rowIndentDepth({ ...emptyAgent("d"), depth: -3 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F22 (W24) — agent references: @mention resolution + spawn lineage
// ---------------------------------------------------------------------------

describe("agentMentions / spawnedChildren / spawnLineageMap / truncateExcerpt / toneVar", () => {
  it("indexes every agent's display name, tone/dimmed following derivedState", () => {
    const idx = agentMentions(fleetState());
    expect(idx.get("main")).toEqual({ agentId: "main", tone: "success", dimmed: false }); // running
    expect(idx.get(agentName("w2"))).toEqual({ agentId: "w2", tone: "info", dimmed: true }); // done
    expect(idx.get("code-review")).toEqual({ agentId: "sh", tone: "warn", dimmed: false }); // pendingQuestion -> waiting, not dimmed
    expect(idx.get(agentName("solo"))).toEqual({ agentId: "solo", tone: "warn", dimmed: true }); // killed
  });

  it("also indexes a remote agent under its engine-qualified form", () => {
    const idx = agentMentions(fleetState());
    const bare = agentName("studio/r1");
    expect(idx.get(bare)?.agentId).toBe("studio/r1");
    expect(idx.get(`studio/${bare}`)?.agentId).toBe("studio/r1");
  });

  it("spawnedChildren finds w2's shadow as its one direct (depth+1, same-tree) child", () => {
    expect(spawnedChildren(fleetState(), "w2").map((a) => a.agentId)).toEqual(["sh"]);
  });

  it("spawnedChildren returns [] for a childless agent or an unknown id", () => {
    expect(spawnedChildren(fleetState(), "w1")).toEqual([]);
    expect(spawnedChildren(fleetState(), "ghost")).toEqual([]);
  });

  it("truncateExcerpt collapses whitespace and leaves short text untouched", () => {
    expect(truncateExcerpt("  a   b  c  ", 20)).toBe("a b c");
  });

  it("truncateExcerpt ellipsizes past the max", () => {
    expect(truncateExcerpt("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("toneVar maps a Tone straight onto its CSS custom property", () => {
    expect(toneVar("success")).toBe("var(--success)");
    expect(toneVar("danger")).toBe("var(--danger)");
  });

  it("spawnLineageMap correlates the Nth agent_spawn call to the Nth spawned child", () => {
    const state = fleetState();
    state.agents.sh = { ...state.agents.sh!, shadow: false, displayLabel: "code-review" };
    const transcript: TranscriptItem[] = [
      { role: "assistant", text: "spawning...", streaming: false },
      { role: "tool", toolName: "mcp__chimera__agent_spawn", status: "done", input: { spec: { prompt: "  review the rowscroll patch, please  " } } },
    ];
    const map = spawnLineageMap(transcript, state, "w2");
    expect(map.get(1)).toEqual({ childId: "sh", childName: "code-review", excerpt: "review the rowscroll patch, please" });
    expect(map.size).toBe(1);
  });

  it("spawnLineageMap has no entries for a parent with no resolvable children", () => {
    const state = fleetState();
    const transcript: TranscriptItem[] = [{ role: "tool", toolName: "mcp__chimera__agent_spawn", status: "done", input: { spec: { prompt: "x" } } }];
    expect(spawnLineageMap(transcript, state, "w1").size).toBe(0);
  });

  it("spawnLineageMap ignores non-spawn tool calls", () => {
    const state = fleetState();
    const transcript: TranscriptItem[] = [{ role: "tool", toolName: "Bash", status: "done", input: { command: "ls" } }];
    expect(spawnLineageMap(transcript, state, "w2").size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// flow pane
// ---------------------------------------------------------------------------

describe("flattenFlow / flowIcon / flowStatusVisual / flowMeta", () => {
  const tree = [
    {
      id: "root", kind: "workflow" as const, label: "fix flaky rowscroll test", status: "running", subLabel: "plan · 4 steps",
      children: [
        { id: "a", kind: "tool" as const, label: "vitest run rowscroll", status: "done", subLabel: "2.1s", children: [] },
        { id: "b", kind: "tool" as const, label: "transcriptWindow.ts", status: "done", subLabel: "+14 −3", children: [] },
        { id: "c", kind: "tool" as const, label: "summary", status: "pending", subLabel: "pending", children: [] },
      ],
    },
  ];
  it("flattens depth-first with isLast flags for └/├", () => {
    const rows = flattenFlow(tree, new Set());
    expect(rows.map((r) => [r.node.id, r.depth, r.isLast])).toEqual([
      ["root", 0, true], ["a", 1, false], ["b", 1, false], ["c", 1, true],
    ]);
  });
  it("hides a collapsed node's children but keeps the node", () => {
    const rows = flattenFlow(tree, new Set(["root"]));
    expect(rows.map((r) => r.node.id)).toEqual(["root"]);
    expect(rows[0]!.collapsed).toBe(true);
  });
  it("picks the mock icons: root ◆, pending ▸, file-ish ✎, else ⚙", () => {
    const rows = flattenFlow(tree, new Set());
    expect(flowIcon(rows[0]!.node, 0)).toBe("◆");
    expect(flowIcon(rows[1]!.node, 1)).toBe("⚙");
    expect(flowIcon(rows[2]!.node, 1)).toBe("✎");
    expect(flowIcon(rows[3]!.node, 1)).toBe("▸");
  });
  it("maps status glyphs (✓ / ✗ / pulsing ◐ / none)", () => {
    expect(flowStatusVisual("done")).toEqual({ glyph: "✓", tone: "success", pulse: false });
    expect(flowStatusVisual("completed")).toEqual({ glyph: "✓", tone: "success", pulse: false });
    expect(flowStatusVisual("failed")).toEqual({ glyph: "✗", tone: "danger", pulse: false });
    expect(flowStatusVisual("running")).toEqual({ glyph: "◐", tone: "warn", pulse: true });
    expect(flowStatusVisual("pending")).toBeNull();
  });
  it("prefers subLabel meta, falling back to compact usage", () => {
    expect(flowMeta(tree[0]!.children[0]!)).toBe("2.1s");
    expect(flowMeta({ id: "u", kind: "tool", label: "x", status: "done", usage: { durationMs: 2100, totalTokens: 900 }, children: [] })).toBe("2s · 0.9k tok");
    expect(flowMeta({ id: "v", kind: "tool", label: "x", status: "done", children: [] })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// ctx meter + sparkline ring
// ---------------------------------------------------------------------------

describe("ctxPct / pushRing / sparkline", () => {
  it("floors the context percentage against the 200k default budget (no limit arg)", () => {
    expect(ctxPct(5000)).toBe(2);   // mock: 5.0k → 2%
    expect(ctxPct(0)).toBe(0);
    expect(ctxPct(400_000)).toBe(100);
  });

  // R2 (ctx meter effective-limit): ctxPct's second arg is now a resolved NUMERIC limit, not a
  // model string — the caller (effectiveContextLimitForAgent, or contextWindowFor directly) owns
  // model->window resolution, ctxPct stays a pure percentage. A known model's real window
  // (P0-3: codex's gpt-5.6-sol is 1.05M, 5.25x claude's 200k default) still changes the
  // denominator once resolved through contextWindowFor first.
  it("divides by the caller-resolved limit", () => {
    expect(ctxPct(200_000, contextWindowFor("gpt-5.6-sol"))).toBe(19);     // 200k / 1.05M
    expect(ctxPct(200_000, contextWindowFor("claude-opus-4-8"))).toBe(100);   // 200k / 200k
    expect(ctxPct(200_000)).toBe(100);                       // no limit -> the 200k default, same as claude
    expect(ctxPct(200_000, contextWindowFor("some-unknown-model"))).toBe(100); // unrecognized model -> falls back to the 200k default
  });

  // R2 (ctx meter effective-limit): a configured compactionThreshold — smaller than the model's
  // native window — must drive the percentage once resolved, proving the CALLER's resolved limit
  // (not the model) is what ctxPct actually divides by.
  it("a configured limit below the model's native window wins", () => {
    expect(ctxPct(90_000, 90_000)).toBe(100);   // gpt-5.6-sol's real window is 1.05M, but 90k is configured
  });

  it("fullContextTokens: input+cacheRead+cacheCreation, excluding output", () => {
    expect(fullContextTokens({ input: 60, output: 999, cacheRead: 40, cacheCreation: 0 })).toBe(100);
    // codex-normalized and claude-normalized usage for the SAME conceptual turn (see
    // ui-state's extractUsage tests) land on the SAME full-context total here too.
    const codexNormalized = { input: 60, output: 20, cacheRead: 40, cacheCreation: 0 };
    const claudeNormalized = { input: 60, output: 20, cacheRead: 40, cacheCreation: 0 };
    expect(fullContextTokens(codexNormalized)).toBe(fullContextTokens(claudeNormalized));
  });

  // R2 (ctx meter effective-limit): resolves TranscriptHeader/AgentDetailPanel's shared `limit`
  // prop — the agent's already-resolved effectiveContextLimit (daemon-computed) when present,
  // else the model's native window.
  describe("effectiveContextLimitForAgent", () => {
    it("uses the agent's already-resolved effectiveContextLimit when present, even below the model's native window", () => {
      expect(effectiveContextLimitForAgent({ model: "gpt-5.6-sol", effectiveContextLimit: 90_000 })).toBe(90_000);
    });
    it("falls back to the model's native window when effectiveContextLimit is absent (older daemon / not-yet-arrived snapshot)", () => {
      expect(effectiveContextLimitForAgent({ model: "gpt-5.6-sol" })).toBe(1_050_000);
      expect(effectiveContextLimitForAgent({ model: "claude-opus-4-8" })).toBe(200_000);
    });
    it("falls back to DEFAULT_CONTEXT_WINDOW when both are absent", () => {
      expect(effectiveContextLimitForAgent({})).toBe(200_000);
    });
  });
  it("keeps the ring at 8 slots, newest last", () => {
    let ring: number[] = [];
    for (let i = 1; i <= 10; i++) ring = pushRing(ring, i);
    expect(ring).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("maps samples onto ▁—▇ normalized to the max", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([10])).toBe("▇");
    expect(sparkline([0, 5, 10])).toBe("▁▄▇");
  });
});

// ---------------------------------------------------------------------------
// transcript blocks + windowing math
// ---------------------------------------------------------------------------

describe("groupTranscriptBlocks / summarizeToolRun", () => {
  it("omits empty assistant cards without renumbering tools or real messages", () => {
    const transcript: TranscriptItem[] = [
      { role: "assistant", text: "", streaming: false },
      { role: "tool", toolName: "command_execution", status: "done" },
      { role: "assistant", text: " \n\t", streaming: true },
      { role: "assistant", text: "Visible answer", streaming: false },
      { role: "user", text: "", images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }] },
    ];
    expect(groupTranscriptBlocks(transcript)).toEqual([
      { kind: "tools", startIndex: 1, items: [transcript[1]] },
      { kind: "single", index: 3, item: transcript[3] },
      { kind: "single", index: 4, item: transcript[4] },
    ]);
  });
  it("joins tools across invisible turns while preserving indices and visible boundaries", () => {
    const tool = { role: "tool", toolName: "command_execution", status: "done" } as const;
    const blank = { role: "assistant", text: " ", streaming: false } as const;
    const answer = { role: "assistant", text: "Working", streaming: true } as const;
    const user = { role: "user", text: "" } as const;
    expect(groupTranscriptBlocks([tool, blank, tool, blank, tool, answer, tool, user, tool])).toEqual([
      { kind: "tools", startIndex: 0, items: [tool, tool, tool], itemIndices: [0, 2, 4] },
      { kind: "single", index: 5, item: answer },
      { kind: "tools", startIndex: 6, items: [tool] },
      { kind: "single", index: 7, item: user },
      { kind: "tools", startIndex: 8, items: [tool] },
    ]);
  });
  const t: TranscriptItem[] = [
    { role: "tool", toolName: "Write", status: "done" },
    { role: "tool", toolName: "Read", status: "done" },
    { role: "assistant", text: "hi", streaming: false },
    { role: "tool", toolName: "ToolSearch", status: "done" },
    { role: "tool", toolName: "ToolSearch", status: "done" },
    { role: "user", text: "yo" },
  ];
  it("collapses consecutive tool items into one block", () => {
    const blocks = groupTranscriptBlocks(t);
    expect(blocks.map((b) => b.kind)).toEqual(["tools", "single", "tools", "single"]);
    expect(blocks[0]!.kind === "tools" ? blocks[0]!.items.length : 0).toBe(2);
    expect(blocks[2]!.kind === "tools" ? blocks[2]!.startIndex : -1).toBe(3);
  });
  it("folds same-name repeats into ×N segments with worst status", () => {
    expect(summarizeToolRun([
      { role: "tool", toolName: "ToolSearch", status: "done" },
      { role: "tool", toolName: "ToolSearch", status: "denied" },
      { role: "tool", toolName: "Bash", status: "done" },
    ])).toEqual([
      { name: "ToolSearch", count: 2, status: "denied" },
      { name: "Bash", count: 1, status: "done" },
    ]);
  });
});

describe("windowRange", () => {
  it("windows the visible slice plus overscan with stable pads", () => {
    const r = windowRange(5000, 48_000, 940, 48, 12);
    expect(r.start).toBe(988);            // floor(48000/48)=1000 − 12
    expect(r.end).toBe(1032);             // ceil((48000+940)/48)=1020 + 12
    expect(r.padTop).toBe(988 * 48);
    expect(r.padBottom).toBe((5000 - 1032) * 48);
    expect(r.end - r.start).toBeLessThan(200); // perf gate: bounded DOM rows
  });
  it("clamps at both ends and handles empty lists", () => {
    expect(windowRange(0, 0, 940, 48, 12)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    const top = windowRange(100, 0, 940, 48, 12);
    expect(top.start).toBe(0);
    const bottom = windowRange(100, 1e9, 940, 48, 12);
    expect(bottom.end).toBe(100);
  });
});

describe("windowRangeMeasured", () => {
  // 10 variable-height blocks; a "tall" block (100/200) breaks the uniform
  // estimate. offsets: [0,100,120,140,160,360,380,400,420,440,460], totalH=460.
  const heights = [100, 20, 20, 20, 200, 20, 20, 20, 20, 20];

  it("windows the straddling block through the last partially-visible one with TRUE-offset pads", () => {
    const r = windowRangeMeasured(heights, 130, 100, 0);
    // top=130 sits inside block 2 (120..140); bottom=230 → first block whose
    // top offset ≥230 is block 5 (offset 360) → end=5 (exclusive).
    expect(r.start).toBe(2);
    expect(r.end).toBe(5);
    expect(r.padTop).toBe(120);          // offsets[2] — real offset, NOT 2*est
    expect(r.padBottom).toBe(100);       // 460 − offsets[5]=360
    expect(r.totalH).toBe(460);
    // geometry closes exactly: padTop + Σ mounted heights + padBottom === totalH
    const mounted = heights.slice(r.start, r.end).reduce((a, b) => a + b, 0);
    expect(r.padTop + mounted + r.padBottom).toBe(r.totalH);
  });

  it("expands the mounted slice by overscan on both edges, pads following the real offsets", () => {
    const r = windowRangeMeasured(heights, 130, 100, 1);
    expect(r.start).toBe(1);
    expect(r.end).toBe(6);
    expect(r.padTop).toBe(100);          // offsets[1]
    expect(r.padBottom).toBe(80);        // 460 − offsets[6]=380
    const mounted = heights.slice(r.start, r.end).reduce((a, b) => a + b, 0);
    expect(r.padTop + mounted + r.padBottom).toBe(r.totalH);
  });

  it("keeps the tail STABLE: at the bottom padBottom is exactly 0 and totalH is the real content height", () => {
    // tail scrollTop = totalH − viewport = 460 − 100 = 360 (top of block 5)
    const r = windowRangeMeasured(heights, 360, 100, 0);
    expect(r.end).toBe(heights.length);
    expect(r.padBottom).toBe(0);
    expect(r.totalH).toBe(460);
    // scrolling a few px past the estimate-implied tail must NOT reshape geometry
    const past = windowRangeMeasured(heights, 100_000, 100, 0);
    expect(past.padBottom).toBe(0);
    expect(past.totalH).toBe(460);
    expect(past.end).toBe(heights.length);
  });

  it("falls back to estimates for unmeasured blocks and still closes the geometry", () => {
    const est = new Array<number>(10).fill(48); // nothing measured yet → uniform
    const r = windowRangeMeasured(est, 200, 96, 2);
    expect(r.totalH).toBe(480);
    const mounted = est.slice(r.start, r.end).reduce((a, b) => a + b, 0);
    expect(r.padTop + mounted + r.padBottom).toBe(480);
  });

  it("always mounts the block under the viewport top even for a zero-height viewport", () => {
    const r = windowRangeMeasured(heights, 130, 0, 0);
    expect(r.start).toBe(2);
    expect(r.end).toBe(3); // start+1 — never an empty slice over real content
  });

  it("handles an empty transcript and clamps garbage heights to zero", () => {
    expect(windowRangeMeasured([], 0, 940, 12)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, totalH: 0 });
    const r = windowRangeMeasured([50, Number.NaN, -10, 50], 0, 60, 0);
    expect(r.totalH).toBe(100); // NaN and negative contribute 0
  });
});

describe("scrollHintCounts", () => {
  // 100 rows × 48px = 4800 content, 940 viewport → tail scrollTop = 3860
  it("counts rows hidden ABOVE even at the tail (mock's '↑ 59 more' while following live)", () => {
    const h = scrollHintCounts(3860, 940, 4800, 48);
    expect(h.above).toBe(80);   // floor(3860/48)
    expect(h.below).toBe(0);    // at the tail: nothing hidden below
  });
  it("pairs ↑ and ↓ while scrolled up (TUI AgentDetail semantics)", () => {
    const h = scrollHintCounts(960, 940, 4800, 48);
    expect(h.above).toBe(20);                    // floor(960/48)
    expect(h.below).toBe(Math.ceil(2900 / 48));  // 4800−960−940 hidden below
  });
  it("shows nothing at the top of a short transcript", () => {
    expect(scrollHintCounts(0, 940, 500, 48)).toEqual({ above: 0, below: 0 });
  });
  it("treats the ≤8px follow epsilon as bottom and clamps garbage", () => {
    expect(scrollHintCounts(3854, 940, 4800, 48).below).toBe(0); // 6px off the tail
    expect(scrollHintCounts(-5, 940, 4800, 48).above).toBe(0);
  });
  it("grows ↓ as streamed appends stretch the content below a held position", () => {
    const before = scrollHintCounts(960, 940, 4800, 48);
    const after = scrollHintCounts(960, 940, 4800 + 20 * 48, 48); // 20 appended rows
    expect(after.below - before.below).toBe(20);
    expect(after.above).toBe(before.above);
  });
});

// TranscriptPanel autoscroll/flicker fix (TUI-UX P0) — extracted as a pure
// helper (jsdom never lays out real scrollHeight, so the DOM-touching parts of
// the fix live in the component; this is the one bit of arithmetic under it).
describe("isNearBottom", () => {
  it("is true exactly at the tail and false one pixel past the threshold", () => {
    expect(isNearBottom(4800 - 940, 940, 4800)).toBe(true); // scrollTop+clientHeight === scrollHeight
    expect(isNearBottom(4800 - 940 - NEAR_BOTTOM_PX, 940, 4800)).toBe(true);        // right at the eşik
    expect(isNearBottom(4800 - 940 - NEAR_BOTTOM_PX - 1, 940, 4800)).toBe(false);   // one px past it
  });
  it("defaults to NEAR_BOTTOM_PX when no threshold is passed (onScroll and the measure-settle effect must agree)", () => {
    expect(isNearBottom(4800 - 940 - NEAR_BOTTOM_PX, 940, 4800)).toBe(isNearBottom(4800 - 940 - NEAR_BOTTOM_PX, 940, 4800, NEAR_BOTTOM_PX));
  });
  it("a deliberate scroll well past the threshold reads as NOT at bottom (esc-follow-tail release)", () => {
    expect(isNearBottom(3000, 940, 4800)).toBe(false);
  });
});

// Composer autosize fix (TUI-UX P0) — wrapped-line growth via scrollHeight
// instead of composeText.split("\n").length (which only counted explicit
// newlines and never grew for a long soft-wrapped single line).
describe("autosizeInput", () => {
  it("grows with content up to maxRows*lineHeight, un-quantized", () => {
    const r = autosizeInput(3 * 20, 20, 8); // 3 wrapped/typed lines, no explicit "\n"
    expect(r).toEqual({ heightPx: 60, scroll: false, rows: 3 });
  });
  it("clamps at maxRows and switches on inner scroll past it", () => {
    const r = autosizeInput(12 * 20, 20, 8); // far more content than 8 rows fit
    expect(r.heightPx).toBe(8 * 20);
    expect(r.scroll).toBe(true);
    expect(r.rows).toBe(8);
  });
  it("never grows below one line even for empty content", () => {
    expect(autosizeInput(0, 20, 8)).toEqual({ heightPx: 20, scroll: false, rows: 1 });
  });
  it("falls back to a 20px line height when the measured value is invalid (0/NaN)", () => {
    expect(autosizeInput(40, 0, 8).heightPx).toBe(40);
    expect(autosizeInput(40, Number.NaN, 8).heightPx).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// timestamps from the event ring
// ---------------------------------------------------------------------------

function ev(seq: number, kind: NormalizedEvent["kind"], agentId: string, ts: number, data: Record<string, unknown> = {}): NormalizedEvent {
  return { seq, ts, engineId: "local", agentId, kind, data };
}

describe("transcriptTimestamps", () => {
  it("never overwrites persisted timestamps with a partial same-agent ring", () => {
    const transcript: TranscriptItem[] = [
      { role: "assistant", text: "old", streaming: false, ts: 100 },
      { role: "assistant", text: "new", streaming: false, ts: 300 },
    ];
    expect(transcriptTimestamps([ev(3, "message_complete", "a1", 300, { text: "new" })], transcript, "a1")).toEqual([100, 300]);
  });
  it("correlates mixed legacy rows by content without consuming an unrelated old row", () => {
    const transcript: TranscriptItem[] = [
      { role: "assistant", text: "legacy old", streaming: false },
      { role: "assistant", text: "epoch", streaming: false, ts: 0 },
      { role: "assistant", text: "legacy new", streaming: false },
      { role: "assistant", text: "persisted", streaming: false, ts: 300 },
    ];
    const events = [ev(2, "message_complete", "a1", 200, { text: "legacy new" }), ev(3, "message_complete", "a1", 350, { text: "persisted" })];
    expect(transcriptTimestamps(events, transcript, "a1")).toEqual([undefined, 0, 200, 300]);
  });
  it("leaves ambiguous legacy messages unstamped in a partial ring", () => {
    const transcript: TranscriptItem[] = [
      { role: "assistant", text: "same", streaming: false },
      { role: "assistant", text: "same", streaming: false },
    ];
    expect(transcriptTimestamps([ev(3, "message_complete", "a1", 300, { text: "same" })], transcript, "a1")).toEqual([undefined, undefined]);
  });

  it("stamps item-creating events and extends streams without re-stamping", () => {
    const key = "a1";
    const transcript: TranscriptItem[] = [
      { role: "tool", toolName: "Bash", status: "done" },
      { role: "assistant", text: "hello world", streaming: false },
      { role: "user", text: "hi", from: "other" },
    ];
    const events: NormalizedEvent[] = [
      ev(1, "tool_call", key, 1000, { toolName: "Bash" }),
      ev(2, "tool_result", key, 1500, {}),
      ev(3, "message_delta", key, 2000, { text: "hello " }),
      ev(4, "message_delta", key, 2500, { text: "world" }),
      ev(5, "message_complete", key, 3000, { text: "hello world" }),
      ev(6, "status", key, 4000, { delivered: true, from: "other", text: "hi" }),
    ];
    expect(transcriptTimestamps(events, transcript, key)).toEqual([1000, 2000, 4000]);
  });
  it("leaves locally-echoed user turns un-stamped without shifting later items", () => {
    const key = "a1";
    const transcript: TranscriptItem[] = [
      { role: "assistant", text: "one", streaming: false },
      { role: "user", text: "local echo" },       // userSent — no event
      { role: "assistant", text: "two", streaming: false },
    ];
    const events: NormalizedEvent[] = [
      ev(1, "message_complete", key, 1000, { text: "one" }),
      ev(2, "message_complete", key, 5000, { text: "two" }),
    ];
    expect(transcriptTimestamps(events, transcript, key)).toEqual([1000, undefined, 5000]);
  });
  it("retains projected timestamps, including zero, after their correlation events are evicted", () => {
    const transcript: TranscriptItem[] = [
      { role: "assistant", text: "epoch", streaming: false, ts: 0 },
      { role: "tool", toolName: "Read", status: "done", ts: 2000 },
      { role: "user", text: "local echo" },
    ];
    // The live ring still contains newer traffic, but neither original
    // correlation event. A legitimate epoch timestamp must not collapse into
    // the same state as the genuinely missing local-echo timestamp.
    const remainingRing = [ev(99, "message_complete", "other-agent", 9000, { text: "newer" })];
    expect(transcriptTimestamps(remainingRing, transcript, "a1")).toEqual([0, 2000, undefined]);
  });
});

// ---------------------------------------------------------------------------
// top-bar chips
// ---------------------------------------------------------------------------

describe("totalSpendUsd / spendMeter / accountToneVar", () => {
  it("sums fleet cost and fills the ▓ meter against the cap", () => {
    const s = fleetState();
    s.agents["main"] = { ...s.agents["main"]!, costUsd: 1.12 };
    s.agents["w1"] = { ...s.agents["w1"]!, costUsd: 0.64 };
    expect(totalSpendUsd(s)).toBeCloseTo(1.76);
    expect(spendMeter(2.27)).toEqual({ fill: "▓▓", empty: "░░░░░░" });
    expect(spendMeter(99)).toEqual({ fill: "▓▓▓▓▓▓▓▓", empty: "" });
    expect(spendMeter(0)).toEqual({ fill: "", empty: "░░░░░░░░" });
  });
  it("colors main success and hash-slots other accounts", () => {
    expect(accountToneVar("main")).toBe("--success");
    const slot = accountToneVar("codex");
    expect(slot).toMatch(/^--acct-[1-6]$/);
    expect(accountToneVar("codex")).toBe(slot); // deterministic
  });
});

// B3 (coverage §B3): the transcript-header "skills 12 · mcp ● chimera" summary.
describe("skillMcpSummary (B3 header)", () => {
  it("maps mcp status → connection glyph (●/◌/○) + tone", () => {
    expect(mcpStatusGlyph("connected")).toEqual({ glyph: "●", tone: "success" });
    expect(mcpStatusGlyph("pending")).toEqual({ glyph: "◌", tone: "warn" });
    expect(mcpStatusGlyph("connecting")).toEqual({ glyph: "◌", tone: "warn" });
    // anything unrecognized reads as down (conservative default)
    expect(mcpStatusGlyph("failed")).toEqual({ glyph: "○", tone: "muted" });
    expect(mcpStatusGlyph("needs-auth")).toEqual({ glyph: "○", tone: "muted" });
    expect(mcpStatusGlyph("whatever")).toEqual({ glyph: "○", tone: "muted" });
  });
  it("summarizes skills as a COUNT and each mcp server with its health glyph", () => {
    const agent: AgentView = {
      ...emptyAgent("a"),
      skills: ["deep-research", "dataviz", "verify"],
      mcpServers: [{ name: "chimera", status: "connected" }, { name: "atlas", status: "failed" }],
    };
    expect(skillMcpSummary(agent)).toEqual({
      skillCount: 3,
      servers: [
        { glyph: "●", tone: "success", name: "chimera" },
        { glyph: "○", tone: "muted", name: "atlas" },
      ],
    });
  });
  it("flips a dropped server ●→○ (coverage verifier scenario)", () => {
    const base: AgentView = { ...emptyAgent("a"), mcpServers: [{ name: "chimera", status: "connected" }] };
    expect(skillMcpSummary(base)!.servers[0]!.glyph).toBe("●");
    const dropped: AgentView = { ...base, mcpServers: [{ name: "chimera", status: "failed" }] };
    expect(skillMcpSummary(dropped)!.servers[0]!.glyph).toBe("○");
  });
  it("returns null for a plain agent that advertised neither (header unchanged)", () => {
    expect(skillMcpSummary(emptyAgent("a"))).toBeNull();
    expect(skillMcpSummary({ ...emptyAgent("a"), skills: [], mcpServers: [] })).toBeNull();
  });
  it("renders skills even when there are no mcp servers", () => {
    const agent: AgentView = { ...emptyAgent("a"), skills: ["one", "two"] };
    expect(skillMcpSummary(agent)).toEqual({ skillCount: 2, servers: [] });
  });
});

// ---------------------------------------------------------------------------
// agentDetailView (AGENT-INFO-PANEL) — the TranscriptPanel header-click
// inspector's view-model. AgentView fields (skills/mcp/membership/depth/
// treeId/state) must render immediately; the raw agent.status record (cwd/
// permissionProfile/isolation/instructions/on.permissionRequest) is optional
// and read defensively so a null/loading status never crashes the panel.
// ---------------------------------------------------------------------------
describe("agentDetailView (AGENT-INFO-PANEL)", () => {
  it("with no status fetched yet, status-only fields are null and AgentView fields still populate", () => {
    const agent: AgentView = {
      ...emptyAgent("a1"),
      state: "running",
      busy: true,
      model: "claude-sonnet-5",
      skills: ["deep-research"],
      mcpServers: [{ name: "chimera", status: "connected" }],
      membership: { team: "team-chimera", role: "staff-engineer" },
      depth: 1,
      treeId: "tree-9",
    };
    const view = agentDetailView(agent, null);
    expect(view.state).toBe("running");
    expect(view.activity).toBe("thinking…");
    expect(view.model).toBe("claude-sonnet-5"); // falls back to AgentView.model
    expect(view.permissionProfile).toBeNull();
    expect(view.isolation).toBeNull();
    expect(view.permissionRequestMode).toBeNull();
    expect(view.cwd).toBeNull();
    expect(view.rolePrompt).toBeNull();
    expect(view.taskPrompt).toBeNull();
    expect(view.skills).toEqual(["deep-research"]);
    expect(view.mcpServers).toEqual(["chimera"]);
    expect(view.membership).toBe("team-chimera · staff-engineer");
    expect(view.depth).toBe(1);
    expect(view.treeId).toBe("tree-9");
  });

  it("folds the fetched agent.status spec — cwd/permissionProfile/isolation/on.permissionRequest/prompts", () => {
    const agent: AgentView = { ...emptyAgent("a1"), state: "running" };
    const status = {
      spec: {
        model: "claude-opus-4-8",
        permissionProfile: "readOnly",
        isolation: "worktree",
        cwd: "/repo/worker",
        instructions: "You are a careful reviewer.",
        prompt: "fix the flaky test",
        on: { permissionRequest: "poke:caller" },
      },
    };
    const view = agentDetailView(agent, status);
    expect(view.model).toBe("claude-opus-4-8"); // status spec wins over AgentView.model
    expect(view.permissionProfile).toBe("readOnly");
    expect(view.isolation).toBe("worktree");
    expect(view.permissionRequestMode).toBe("poke:caller");
    expect(view.cwd).toBe("/repo/worker");
    expect(view.rolePrompt).toBe("You are a careful reviewer.");
    expect(view.taskPrompt).toBe("fix the flaky test");
  });

  it("activity: busy agent shows the last tool call, or 'thinking…' before the first one lands", () => {
    const busyNoTools: AgentView = { ...emptyAgent("a"), busy: true, tools: [] };
    expect(agentDetailView(busyNoTools, null).activity).toBe("thinking…");

    const busyWithTool: AgentView = {
      ...emptyAgent("a"),
      busy: true,
      tools: [{ ts: 1, toolName: "Bash", status: "called" }],
    };
    expect(agentDetailView(busyWithTool, null).activity).toBe("Bash (called)");
  });

  it("activity: idle agent shows its last tool as history, or '—' with no tool history", () => {
    const idleNoTools: AgentView = { ...emptyAgent("a"), busy: false, tools: [] };
    expect(agentDetailView(idleNoTools, null).activity).toBe("—");

    const idleWithTool: AgentView = {
      ...emptyAgent("a"),
      busy: false,
      tools: [{ ts: 1, toolName: "Read", status: "done" }],
    };
    expect(agentDetailView(idleWithTool, null).activity).toBe("last: Read (done)");
  });

  it("depth/treeId fall back to the status record when AgentView carries neither", () => {
    const agent: AgentView = { ...emptyAgent("a") };
    const view = agentDetailView(agent, { depth: 2, treeId: "tree-status" });
    expect(view.depth).toBe(2);
    expect(view.treeId).toBe("tree-status");
  });

  it("membership is null for an unteamed agent (main conductor / plain spawn)", () => {
    expect(agentDetailView(emptyAgent("a"), null).membership).toBeNull();
  });

  it("empty-string instructions/prompt read as null, not a blank row", () => {
    const view = agentDetailView(emptyAgent("a"), { spec: { instructions: "", prompt: "" } });
    expect(view.rolePrompt).toBeNull();
    expect(view.taskPrompt).toBeNull();
  });
});

// PAUSE-BADGE-NOISE: a 36-character reason on every paused row wrapped the badge to a second
// line and pushed the agent-NAME column off the row entirely — 21 rows all reading "daemon
// restarted — resume to continue" while showing no names at all. The benign holds are glyph-only.
describe("pauseSummary — row badge noise", () => {
  it("says nothing for the restart hold — identical on every row, so it is pure width", () => {
    expect(pauseSummary({ pauseReason: "daemon-restart", resumeAt: undefined })).toBe("");
  });

  it("says nothing for the idle hold either", () => {
    expect(pauseSummary({ pauseReason: "idle-timeout", resumeAt: undefined })).toBe("");
  });

  it("still explains the EXCEPTIONAL holds — 'resolving itself or stuck retrying?' is a real question there", () => {
    expect(pauseSummary({ pauseReason: "session-limit", resumeAt: undefined })).toMatch(/session limit/);
    expect(pauseSummary({ pauseReason: "crash-loop-backoff", resumeAt: undefined })).toMatch(/crash loop/);
  });

  it("keeps the resume time on a hold that actually has a clock", () => {
    expect(pauseSummary({ pauseReason: "session-limit", resumeAt: Date.now() + 60_000 })).toMatch(/resumes/);
    // ...and never invents one for a glyph-only hold, which has no clock by construction
    expect(pauseSummary({ pauseReason: "daemon-restart", resumeAt: Date.now() + 60_000 })).toBe("");
  });
});

// F46.2 — the hooks form must be able to offer and label the new content topic, and its
// needle filter key, or the form silently can't express "wake on this substring".
describe("hooks form surfaces agent.output", () => {
  it("labels agent.output as an output-contains topic", () => {
    expect(topicLabel("agent.output")).toBe("agent output contains");
  });

  it("exposes contains as a form filter key", () => {
    expect(hookFilterKeys("agent.output")).toContain("contains");
  });
});

// F46.UI (QA finding E) — the offered filter keys are a function of the topic, because the
// daemon enforces both directions of the contract and the form used to signal neither.
describe("hooks form: topic-aware filter keys", () => {
  it("offers ONLY contains on a content topic, and never offers it elsewhere", () => {
    expect(hookFilterKeys("agent.output")).toEqual(["contains"]);
    expect(hookFilterKeys("task.state")).not.toContain("contains");
  });

  it("never proposes treeId/team — accepted by the schema, populated by no projector", () => {
    for (const topic of ["task.state", "gate.verdict", "agent.output"] as const) {
      expect(hookFilterKeys(topic)).not.toContain("treeId");
      expect(hookFilterKeys(topic)).not.toContain("team");
    }
  });

  it("still renders a key an existing rule already carries, so editing it can't blank the select", () => {
    expect(hookFilterKeysFor("task.state", "treeId")).toContain("treeId");
    expect(hookFilterKeysFor("task.state", "queue")).toEqual(hookFilterKeys("task.state"));
  });

  it("reconciles the key in both directions when the topic changes", () => {
    expect(reconcileFilterKey("agent.output", "queue")).toBe("contains");
    expect(reconcileFilterKey("agent.output", "")).toBe("contains");
    expect(reconcileFilterKey("task.state", "contains")).toBe("");
    expect(reconcileFilterKey("task.state", "queue")).toBe("queue");
  });

  it("shows the server's own refusal inline, before submit", () => {
    expect(hookDraftFilterIssue("agent.output", "", "")).toMatch(/requires filter\.contains/);
    expect(hookDraftFilterIssue("task.state", "contains", "boom")).toMatch(/only supported on content topics/);
    expect(hookDraftFilterIssue("agent.output", "contains", "ab")).toBe("filter.contains must be 3-64 characters");
    expect(hookDraftFilterIssue("agent.output", "contains", "panic:")).toBeNull();
    expect(hookDraftFilterIssue("task.state", "state", "failed")).toBeNull();
  });

  it("warns — but does not block — on a filter key nothing populates", () => {
    expect(hookFilterWarning("treeId")).toMatch(/never fire/);
    expect(hookFilterWarning("queue")).toBeNull();
    expect(hookDraftFilterIssue("task.state", "treeId", "t1")).toBeNull();
  });
});


it("Codex context uses only the reported session window, independently of model max and compaction", () => {
  expect(effectiveContextLimitForAgent({ provider: "codex", model: "gpt-6-astra", effectiveContextLimit: 500000 })).toBe(0);
  expect(effectiveContextLimitForAgent({ provider: "codex", model: "future-model", effectiveContextLimit: 120000,
    contextLimits: { source: "codex", sessionWindow: 654321, maxWindow: 1456789, compactAt: 120000 } })).toBe(654321);
});
