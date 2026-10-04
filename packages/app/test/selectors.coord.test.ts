import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { RoleBindingSchema, TeamSpecSchema } from "@chimera/protocol";
import {
  clockJumpSummary,
  eventSummaryOverride,
  eventKindTone,
  backlogPct,
  backlogRatio,
  buildAddMemberPatch,
  buildMemoryAddParams,
  buildMemoryUpdateParams,
  buildPushParams,
  buildEditPatch,
  buildQueueSpec,
  buildQueueUpdatePatch,
  buildTeamSpec,
  buildTeamUpdatePatch,
  countTone,
  ellipsize,
  eventRowTone,
  fmtMemDate,
  isDiscoveredRole,
  isGatedAutoAllow,
  isRemoteEvent,
  isTaskEditable,
  latestCoordSeq,
  matchesQueueQuery,
  matchesTaskQuery,
  matchesTeamQuery,
  memoryFormValuesFromRecord,
  memoryLabel,
  memoryRowView,
  buildFolderTree,
  unfiledCount,
  buildMemorySearchParams,
  mergeTeamAgents,
  newestFirst,
  newestFirstTasks,
  nextKindFilter,
  parseTags,
  policyLine,
  queueFormValuesFromSpec,
  resolvedRoleBindingSpec,
  roleConfig,
  specLine,
  summarizeEventData,
  taskForAgent,
  taskRowView,
  taskTiming,
  taskVersionRows,
  editFormValuesFromTask,
  validateEditForm,
  teamFormValuesFromSpec,
  teamListRow,
  teamMemberIds,
  validateAddMemberForm,
  validateMemoryForm,
  validatePushForm,
  validateQueueForm,
  validateTeamForm,
} from "../src/state/selectors.coord";

// W5 gate (a): backlog math, counts/kind color mapping, event summary
// truncation, form spec builders — the pure layer under the four screens.

const ev = (kind: string, seq: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  ({ ts: 1000 + seq, seq, engineId: "local", agentId: "a1", kind, data: {}, ...extra }) as NormalizedEvent;

describe("backlog math (coverage B9: (pending+blocked)/Σ)", () => {
  it("computes the mock's 18% example exactly", () => {
    const counts = { pending: 2, blocked: 0, in_progress: 1, done: 7, failed: 1 };
    expect(backlogRatio(counts)).toBeCloseTo(2 / 11);
    expect(backlogPct(counts)).toBe(18);
  });
  it("is 0 for empty/absent counts", () => {
    expect(backlogRatio(undefined)).toBe(0);
    expect(backlogRatio(null)).toBe(0);
    expect(backlogRatio({})).toBe(0);
    expect(backlogRatio({ pending: 0, done: 0 })).toBe(0);
  });
  it("counts blocked into the backlog", () => {
    expect(backlogRatio({ pending: 1, blocked: 1, done: 2 })).toBeCloseTo(0.5);
  });
  it("ignores non-finite garbage defensively", () => {
    expect(backlogRatio({ pending: Number.NaN as unknown as number, done: 1 })).toBe(0);
  });
});

describe("counts color mapping (coverage B9: renk sözleşmesi sabit)", () => {
  it("maps every task state to its contracted tone", () => {
    expect(countTone("pending")).toBe("warn");
    expect(countTone("blocked")).toBe("muted");
    expect(countTone("in_progress")).toBe("accent");
    expect(countTone("done")).toBe("success");
    expect(countTone("failed")).toBe("danger");
    expect(countTone("bogus")).toBe("muted");
  });
});

describe("event kind colors + summary (coverage B10)", () => {
  it("colors exactly permission_request/error/result; others plain", () => {
    expect(eventKindTone("permission_request")).toBe("human");
    expect(eventKindTone("error")).toBe("danger");
    expect(eventKindTone("result")).toBe("info");
    expect(eventKindTone("policy_denied")).toBe("danger"); // W8 / coverage B14
    expect(eventKindTone("status")).toBeNull();
    expect(eventKindTone("tool_call")).toBeNull();
  });
  // GATED-BUT-ALLOWED-INVISIBLE: capability_decision has no kind-level tone of its own (it's
  // mostly noise — 818 events in one observed 5-minute production window) — only eventRowTone
  // (which layers isGatedAutoAllow on top) should color it, and only the genuinely gated case.
  it("isGatedAutoAllow: true ONLY for capability_decision + decision:allow + explicitPolicy:true", () => {
    expect(isGatedAutoAllow("capability_decision", { decision: "allow", explicitPolicy: true })).toBe(true);
    // the noise case: allow with no explicitPolicy flag at all (argv-parsing junk like "head"/"wc")
    expect(isGatedAutoAllow("capability_decision", { decision: "allow" })).toBe(false);
    expect(isGatedAutoAllow("capability_decision", { decision: "allow", explicitPolicy: false })).toBe(false);
    // a deny/prompt is already visible via policy_denied/permission_request — not this signal's job
    expect(isGatedAutoAllow("capability_decision", { decision: "deny", explicitPolicy: true })).toBe(false);
    // wrong kind entirely
    expect(isGatedAutoAllow("policy_denied", { decision: "allow", explicitPolicy: true })).toBe(false);
    expect(isGatedAutoAllow("capability_decision", undefined)).toBe(false);
    expect(isGatedAutoAllow("capability_decision", null)).toBe(false);
  });
  it("eventRowTone: warn for a gated-auto-allow capability_decision, else falls through to eventKindTone", () => {
    expect(eventRowTone("capability_decision", { decision: "allow", explicitPolicy: true })).toBe("warn");
    expect(eventRowTone("capability_decision", { decision: "allow" })).toBeNull();   // noise, untoned
    expect(eventRowTone("error", {})).toBe("danger");                                // unaffected passthrough
    expect(eventRowTone("policy_denied", { decision: "allow", explicitPolicy: true })).toBe("danger");   // kind wins, not gated-allow logic
  });
  it("eventRowTone: F26 upgrades a failed worktree_setup run to danger, other phases stay info", () => {
    expect(eventRowTone("worktree_setup", { phase: "fail" })).toBe("danger");
    expect(eventRowTone("worktree_setup", { phase: "start" })).toBe("info");
    expect(eventRowTone("worktree_setup", { phase: "ok" })).toBe("info");
    expect(eventRowTone("worktree_setup", undefined)).toBe("info");
  });
  it("summarizes top-level primitives as k=v · k=v", () => {
    expect(summarizeEventData({ tool: "Edit", ok: true, n: 3 })).toBe("tool=Edit · ok=true · n=3");
  });
  it("elides nested values and never exceeds 60 chars", () => {
    expect(summarizeEventData({ a: { deep: 1 }, b: [1, 2], c: null })).toBe("a={…} · b=[…] · c=null");
    const long = summarizeEventData({ text: "x".repeat(200) });
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });
  it("handles absent data", () => {
    expect(summarizeEventData(undefined)).toBe("");
    expect(summarizeEventData(null)).toBe("");
  });
  it("marks remote events (engineId ≠ local)", () => {
    expect(isRemoteEvent({ engineId: "local" })).toBe(false);
    expect(isRemoteEvent({ engineId: "studio" })).toBe(true);
  });
});

describe("kind filter cycle (f)", () => {
  const events = [ev("status", 1), ev("result", 2), ev("error", 3)];
  it("cycles all → kinds present (sorted) → all", () => {
    expect(nextKindFilter(null, events)).toBe("error");
    expect(nextKindFilter("error", events)).toBe("result");
    expect(nextKindFilter("result", events)).toBe("status");
    expect(nextKindFilter("status", events)).toBeNull();
  });
  it("resets a stale filter whose kind left the buffer", () => {
    expect(nextKindFilter("permission_request", events)).toBeNull();
    expect(nextKindFilter(null, [])).toBeNull();
  });
});

describe("latestCoordSeq (refresh-on-relevant-events trigger)", () => {
  it("returns the newest status/result seq, skipping other kinds", () => {
    expect(latestCoordSeq([ev("status", 1), ev("message_delta", 5), ev("result", 3)])).toBe(3);
    expect(latestCoordSeq([ev("message_delta", 5)])).toBe(0);
    expect(latestCoordSeq([])).toBe(0);
  });
  // W18 (F16 task workflows): a step gate pass/fail must refetch the queue
  // drill just as promptly as status/result — this is the reconcile half of
  // the task row's optimistic step meter.
  it("also triggers on task_step_advanced/_failed", () => {
    expect(latestCoordSeq([ev("status", 1), ev("task_step_advanced", 4)])).toBe(4);
    expect(latestCoordSeq([ev("task_step_failed", 2), ev("message_delta", 5)])).toBe(2);
  });
});

describe("team list row + spec/policy lines (coverage B8/B9)", () => {
  // FLAT-SHAPE-SWEEP: `roles[key]` is a ROLES-UNIFY `{role, overrides}` BINDING —
  // the fixture used to assert the old flat `{cwd, permissionProfile}` shape,
  // which never parses against TeamSpecSchema (same bug class as buildTeamSpec's,
  // fixed in ROLES-BINDING-CORRECTNESS) and which policyLine could not have
  // actually read post-ROLES-UNIFY (a binding's own fields live under `overrides`).
  const team = {
    name: "tui-crew", createdBy: "main-id", maxConcurrent: 2, queue: "bugfix", purpose: "TUI bug triage",
    roles: { dev: { role: "dev", overrides: {} }, reviewer: { role: "reviewer", overrides: {} } },
    running: 2,
  };
  const library = [
    { name: "dev", cwd: "~/code/chimera", permissionProfile: "acceptEdits" },
    { name: "reviewer", cwd: "~" },
  ];
  it("projects team.list items", () => {
    const row = teamListRow(team);
    expect(row).toMatchObject({ name: "tui-crew", roleCount: 2, running: 2, maxConcurrent: 2, queue: "bugfix" });
    expect(row.roles).toEqual(["dev", "reviewer"]);
  });
  // TEAM-STATS: totalRuns must read as a real 0 (not undefined/omitted) for a
  // team.list item predating the field, and pass through verbatim otherwise.
  it("projects totalRuns, defaulting to 0 for a response predating the field", () => {
    expect(teamListRow({ ...team, totalRuns: 12 }).totalRuns).toBe(12);
    expect(teamListRow(team).totalRuns).toBe(0);
  });
  it("derives the policy line from the bound team's role binding, resolved against the library", () => {
    const line = policyLine({ attempts: 0, role: "dev" }, 2, team, library);
    expect(line).toBe("retry 0/2 · drained by team tui-crew (max 2) · role template applies on assignment: cwd ~/code/chimera · acceptEdits");
  });
  it("degrades the policy line's role-template bit without a library (binding unresolved)", () => {
    const line = policyLine({ attempts: 0, role: "dev" }, 2, team);
    expect(line).toBe("retry 0/2 · drained by team tui-crew (max 2)");
  });
  it("degrades the policy line without a team", () => {
    expect(policyLine({ attempts: 1, role: "dev" }, 2, null)).toBe("retry 1/2");
  });
  it("builds the inspector spec line from present fields only", () => {
    expect(specLine({ model: "claude-haiku-4-5", permissionProfile: "acceptEdits", maxBudgetUsd: 2, deliverTo: "main" }))
      .toBe("claude-haiku-4-5 · acceptEdits · engine local · tree budget $2.00 · deliverTo main");
    expect(specLine(undefined)).toBe("—");
    expect(specLine({})).toBe("engine local");
  });
  it("reads a role's config badges + instructions for the Teams detail expand section", () => {
    expect(roleConfig({
      model: "claude-fable-5",
      permissionProfile: "acceptEdits",
      isolation: "worktree",
      maxTurns: 40,
      turnLimitPolicy: "fail",
      instructions: "you are the dev role — fix bugs, land on main.",
    })).toEqual({
      model: "claude-fable-5",
      permissionProfile: "acceptEdits",
      isolation: "worktree",
      maxTurns: 40,
      turnLimitPolicy: "fail",
      instructions: "you are the dev role — fix bugs, land on main.",
    });
  });
  it("degrades role config to nulls for missing/malformed fields", () => {
    expect(roleConfig(undefined)).toEqual({
      model: null, permissionProfile: null, isolation: null, maxTurns: null, turnLimitPolicy: null, instructions: null,
    });
    expect(roleConfig({ maxTurns: "40", instructions: "" })).toEqual({
      model: null, permissionProfile: null, isolation: null, maxTurns: null, turnLimitPolicy: null, instructions: null,
    });
  });
});

describe("PROJTEAM-T7: discovered vs chimera-added role provenance + add-member patch", () => {
  // FLAT-SHAPE-SWEEP: roles[key] is a ROLES-UNIFY {role, overrides} BINDING — this
  // fixture used to assert the old flat {cwd} shape, which never parses against
  // TeamSpecSchema (buildAddMemberPatch was building exactly this unparseable shape,
  // meaning the project-native "add member" flow failed RPC validation on every
  // attempt; same bug class as buildTeamSpec's, fixed in ROLES-BINDING-CORRECTNESS).
  const projectTeam = {
    name: "chimera-native", projectNative: "chimera", discoveredRoles: ["backend", "frontend"],
    roles: {
      backend: { role: "chimera-native.backend", overrides: {} },
      frontend: { role: "chimera-native.frontend", overrides: {} },
      "custom-qa": { role: "custom-qa", overrides: { cwd: "/repo/chimera" } },   // a chimera-added role that survived a prior re-sync
    },
  };
  const library = [
    { name: "chimera-native.backend", cwd: "/repo/chimera" },
    { name: "chimera-native.frontend", cwd: "/repo/chimera" },
    { name: "custom-qa", cwd: "/repo/chimera" },
  ];

  it("isDiscoveredRole reads discoveredRoles, defaulting a malformed/absent field to false", () => {
    expect(isDiscoveredRole(projectTeam, "backend")).toBe(true);
    expect(isDiscoveredRole(projectTeam, "custom-qa")).toBe(false);
    expect(isDiscoveredRole({ roles: {} }, "backend")).toBe(false);
  });

  it("validateAddMemberForm rejects a blank/invalid/colliding role or missing cwd", () => {
    expect(validateAddMemberForm(projectTeam, { role: "", cwd: "/repo/chimera" })).toMatch(/role is required/);
    expect(validateAddMemberForm(projectTeam, { role: "bad name", cwd: "/repo/chimera" })).toMatch(/letters, digits/);
    expect(validateAddMemberForm(projectTeam, { role: "backend", cwd: "/repo/chimera" })).toMatch(/already exists/);
    expect(validateAddMemberForm(projectTeam, { role: "custom-qa", cwd: "/repo/chimera" })).toMatch(/already exists/);
    expect(validateAddMemberForm(projectTeam, { role: "reviewer", cwd: "" })).toMatch(/cwd is required/);
    expect(validateAddMemberForm(projectTeam, { role: "reviewer", cwd: "/repo/chimera" })).toBeNull();
  });

  it("buildAddMemberPatch preserves every existing role binding verbatim (discovered AND chimera-added), adds the new one as a {role,overrides} binding, and never touches discoveredRoles", () => {
    const patch = buildAddMemberPatch(projectTeam, { role: "reviewer", cwd: "/repo/chimera" });
    expect(patch).toEqual({
      roles: {
        backend: { role: "chimera-native.backend", overrides: {} },
        frontend: { role: "chimera-native.frontend", overrides: {} },
        "custom-qa": { role: "custom-qa", overrides: { cwd: "/repo/chimera" } },
        reviewer: { role: "reviewer", overrides: { cwd: "/repo/chimera" } },
      },
    });
    expect(patch).not.toHaveProperty("discoveredRoles");
  });

  // FLAT-SHAPE-SWEEP acceptance: the "add member" path must actually round-trip
  // through TeamSpecSchema's strict parse — a plain typecheck would not catch this
  // (the pre-fix shape was built as a loose Record<string, unknown>).
  it("buildAddMemberPatch's roles satisfy TeamSpecSchema when merged onto the full team spec", () => {
    const patch = buildAddMemberPatch(projectTeam, { role: "reviewer", cwd: "/repo/chimera" });
    const fullSpec = { name: projectTeam.name, ...patch };
    expect(() => TeamSpecSchema.parse(fullSpec)).not.toThrow();
  });

  it("buildAddMemberPatch's new binding alone satisfies RoleBindingSchema", () => {
    const patch = buildAddMemberPatch(projectTeam, { role: "reviewer", cwd: "/repo/chimera" }) as { roles: Record<string, unknown> };
    expect(() => RoleBindingSchema.parse(patch.roles["reviewer"])).not.toThrow();
  });

  it("submitAddMember's cwd derivation resolves the first role BINDING against the library (read-side fix)", () => {
    const firstBinding = Object.values(projectTeam.roles)[0];
    const resolved = resolvedRoleBindingSpec(firstBinding, library);
    expect(resolved["cwd"]).toBe("/repo/chimera");
  });
});

describe("SEARCH-TEAMS: team member ids + free-text query match", () => {
  const row = teamListRow({
    name: "tui-crew", purpose: "TUI bug triage",
    roles: { dev: {}, reviewer: {} },
  });

  it("collects member agent ids from the app agents map by membership.team", () => {
    const appAgents = [
      { agentId: "a1", membership: { team: "tui-crew", role: "dev" } },
      { agentId: "a2", membership: { team: "other-team", role: "dev" } },
      { agentId: "a3" }, // no membership (plain agent)
    ];
    expect(teamMemberIds(appAgents, "tui-crew")).toEqual(["a1"]);
    expect(teamMemberIds(appAgents, "other-team")).toEqual(["a2"]);
    expect(teamMemberIds(appAgents, "no-such-team")).toEqual([]);
  });

  it("matches on name, purpose, role names, and member ids — case-insensitive", () => {
    expect(matchesTeamQuery(row, [], "tui-crew")).toBe(true);
    expect(matchesTeamQuery(row, [], "BUG TRIAGE")).toBe(true);
    expect(matchesTeamQuery(row, [], "reviewer")).toBe(true);
    expect(matchesTeamQuery(row, ["a1b2"], "a1b2")).toBe(true);
    expect(matchesTeamQuery(row, [], "nope")).toBe(false);
  });

  it("empty/whitespace query always matches", () => {
    expect(matchesTeamQuery(row, [], "")).toBe(true);
    expect(matchesTeamQuery(row, [], "   ")).toBe(true);
  });
});

describe("newestFirst (P2 UX: Teams/Queues master lists show newest on top)", () => {
  it("reverses the (oldest→newest) insertion order team.list/queue.list hand back", () => {
    const items = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
    expect(newestFirst(items)).toEqual([{ name: "gamma" }, { name: "beta" }, { name: "alpha" }]);
  });
  it("does not mutate the input array (drain/priority scheduling reads the ORIGINAL order)", () => {
    const items = [{ name: "alpha" }, { name: "beta" }];
    const before = [...items];
    newestFirst(items);
    expect(items).toEqual(before);
  });
  it("degrades to an empty list for an empty input", () => {
    expect(newestFirst([])).toEqual([]);
  });
});

describe("newestFirstTasks (P2 UX: a queue drill's task list shows newest push on top)", () => {
  it("sorts by pushedAt descending", () => {
    const tasks = [
      { taskId: "t1", pushedAt: 100 },
      { taskId: "t2", pushedAt: 300 },
      { taskId: "t3", pushedAt: 200 },
    ];
    expect(newestFirstTasks(tasks).map((t) => t["taskId"])).toEqual(["t2", "t3", "t1"]);
  });
  it("falls back to createdAt when pushedAt is absent (older persisted tasks)", () => {
    const tasks = [
      { taskId: "old", createdAt: 100 },
      { taskId: "new", pushedAt: 200 },
    ];
    expect(newestFirstTasks(tasks).map((t) => t["taskId"])).toEqual(["new", "old"]);
  });
  it("breaks ties by original insertion order (later push wins, matching FIFO-within-priority intuition)", () => {
    const tasks = [
      { taskId: "first", pushedAt: 100 },
      { taskId: "second", pushedAt: 100 },
    ];
    expect(newestFirstTasks(tasks).map((t) => t["taskId"])).toEqual(["second", "first"]);
  });
  it("does not mutate the input array", () => {
    const tasks = [{ taskId: "t1", pushedAt: 1 }, { taskId: "t2", pushedAt: 2 }];
    const before = [...tasks];
    newestFirstTasks(tasks);
    expect(tasks).toEqual(before);
  });
});

describe("taskTiming (SURFACE-QUEUE-LATENCY: derive wait/run durations from raw stamps)", () => {
  it("computes waitMs and runMs when pushedAt/startedAt/endedAt are all present", () => {
    const t = taskTiming({ pushedAt: 1000, startedAt: 4000, endedAt: 9000 });
    expect(t.startedAt).toBe(4000);
    expect(t.endedAt).toBe(9000);
    expect(t.waitMs).toBe(3000);
    expect(t.runMs).toBe(5000);
  });
  it("a still-queued task (no startedAt) has no waitMs/runMs — never a fabricated 0", () => {
    const t = taskTiming({ pushedAt: 1000 });
    expect(t.startedAt).toBeNull();
    expect(t.endedAt).toBeNull();
    expect(t.waitMs).toBeNull();
    expect(t.runMs).toBeNull();
  });
  it("a record predating TASK-STAMPS (no startedAt/endedAt at all) reads as fully absent", () => {
    const t = taskTiming({ taskId: "old", pushedAt: 1000, state: "done" });
    expect(t.startedAt).toBeNull();
    expect(t.endedAt).toBeNull();
    expect(t.waitMs).toBeNull();
    expect(t.runMs).toBeNull();
  });
  it("a running task (startedAt but no endedAt) has runMs null", () => {
    const t = taskTiming({ pushedAt: 1000, startedAt: 4000 });
    expect(t.runMs).toBeNull();
    expect(t.waitMs).toBe(3000);
  });
});

describe("matchesQueueQuery (SEARCH-QUEUES: queue master list filter)", () => {
  it("matches the queue name case-insensitively", () => {
    expect(matchesQueueQuery({ name: "tui-crew" }, "TUI")).toBe(true);
    expect(matchesQueueQuery({ name: "tui-crew" }, "crew")).toBe(true);
    expect(matchesQueueQuery({ name: "tui-crew" }, "other")).toBe(false);
  });
  it("a blank/whitespace-only query always matches", () => {
    expect(matchesQueueQuery({ name: "tui-crew" }, "")).toBe(true);
    expect(matchesQueueQuery({ name: "tui-crew" }, "   ")).toBe(true);
  });
  it("degrades to no-match on a missing/non-string name", () => {
    expect(matchesQueueQuery({}, "tui")).toBe(false);
  });
});

describe("matchesTaskQuery (SEARCH-QUEUES: queue drill task list filter)", () => {
  const t = taskRowView({ taskId: "t-42", role: "reviewer", agentId: "a-9", prompt: "fix the flaky test" });
  it("matches taskId, role, agent, or prompt case-insensitively", () => {
    expect(matchesTaskQuery(t, "T-42")).toBe(true);
    expect(matchesTaskQuery(t, "reviewer")).toBe(true);
    expect(matchesTaskQuery(t, "a-9")).toBe(true);
    expect(matchesTaskQuery(t, "flaky")).toBe(true);
    expect(matchesTaskQuery(t, "nope")).toBe(false);
  });
  it("a blank query always matches, including a task with no bound agent", () => {
    const unbound = taskRowView({ taskId: "t-1", role: "dev", prompt: "p" });
    expect(matchesTaskQuery(unbound, "")).toBe(true);
    expect(matchesTaskQuery(unbound, "dev")).toBe(true);
  });
});

describe("mergeTeamAgents (coverage B8: drained members keep showing)", () => {
  const live = [
    { agentId: "a-run", state: "running", membership: { team: "tui-crew", role: "dev" }, accountName: "acct-1", costUsd: 0.5 },
  ];
  const appAgents = [
    // still-running member, also present live — the live row must win (no dup)
    { agentId: "a-run", state: "running", membership: { team: "tui-crew", role: "dev" }, account: "acct-1", costUsd: 9.9 },
    // drained member of THIS team — absent from live, must be merged in
    { agentId: "a-done", state: "done", membership: { team: "tui-crew", role: "reviewer" }, account: "acct-2", costUsd: 1.2, resultDetail: { result: { state: "done", text: "shipped the fix\nmore" } } },
    // member of ANOTHER team — never merged
    { agentId: "a-other", state: "done", membership: { team: "other", role: "dev" }, account: "acct-3", costUsd: 0 },
    // plain agent (no membership) — never merged
    { agentId: "a-plain", state: "running", account: "acct-4", costUsd: 0 },
  ];

  it("keeps live rows authoritative and appends drained same-team members", () => {
    const rows = mergeTeamAgents(live, appAgents, "tui-crew");
    expect(rows.map((r) => r["agentId"])).toEqual(["a-run", "a-done"]);
    // live row untouched (costUsd 0.5, not the stale app copy's 9.9)
    expect(rows[0]).toMatchObject({ agentId: "a-run", state: "running", costUsd: 0.5 });
    // drained row mapped into the loose team-row shape (account → accountName, result text → resultText)
    expect(rows[1]).toMatchObject({ agentId: "a-done", state: "done", accountName: "acct-2", costUsd: 1.2, resultText: "shipped the fix\nmore" });
    expect((rows[1]!["membership"] as Record<string, unknown>)["role"]).toBe("reviewer");
  });

  it("returns only live rows when no app agent belongs to the team", () => {
    expect(mergeTeamAgents(live, [appAgents[2]!, appAgents[3]!], "tui-crew").map((r) => r["agentId"])).toEqual(["a-run"]);
  });

  it("never merges by an empty team name", () => {
    expect(mergeTeamAgents([], appAgents, "")).toEqual([]);
  });
});

describe("task rows + agent binding", () => {
  it("projects a task record defensively", () => {
    const t = taskRowView({ taskId: "t-1", state: "failed", role: null, agentId: "a9", attempts: 2, priority: 5, prompt: "p", error: "budget exceeded" });
    expect(t).toMatchObject({ taskId: "t-1", state: "failed", role: "—", agentId: "a9", attempts: 2, priority: 5, error: "budget exceeded" });
  });
  it("prefers the in_progress binding for an agent over a settled one", () => {
    const tasks = [
      { taskId: "t-old", agentId: "a1", state: "done" },
      { taskId: "t-live", agentId: "a1", state: "in_progress" },
      { taskId: "t-other", agentId: "a2", state: "in_progress" },
    ];
    expect(taskForAgent(tasks, "a1")?.["taskId"]).toBe("t-live");
    expect(taskForAgent(tasks, "a3")).toBeNull();
  });
});

describe("form builders (gate a: spec shapes)", () => {
  it("team: validates name per CoordName + requires cwd", () => {
    expect(validateTeamForm({ name: "", role: "", maxConcurrent: "", cwd: "/x", queue: "", purpose: "", model: "", persistent: "", instructions: "" })).toMatch(/name/);
    expect(validateTeamForm({ name: "bad/name", role: "", maxConcurrent: "", cwd: "/x", queue: "", purpose: "", model: "", persistent: "", instructions: "" })).toMatch(/letters/);
    expect(validateTeamForm({ name: "ok-1", role: "", maxConcurrent: "", cwd: "", queue: "", purpose: "", model: "", persistent: "", instructions: "" })).toMatch(/cwd/);
    expect(validateTeamForm({ name: "ok-1", role: "", maxConcurrent: "x", cwd: "/x", queue: "", purpose: "", model: "", persistent: "", instructions: "" })).toMatch(/max concurrent/);
    expect(validateTeamForm({ name: "ok-1", role: "", maxConcurrent: "2", cwd: "/x", queue: "", purpose: "", model: "", persistent: "", instructions: "" })).toBeNull();
  });
  // ROLES-BINDING-CORRECTNESS: roles[key] is a ROLES-UNIFY {role, overrides} BINDING
  // (RoleBindingSchema is .strict() — the old inline {cwd, model, ...} shape these
  // tests asserted before this fix no longer parses against TeamSpecSchema at all).
  it("team: builds the TeamSpecSchema binding shape ({role, overrides}, keyed by role)", () => {
    expect(buildTeamSpec({ name: "gate-crew", role: "dev", maxConcurrent: "1", cwd: "/tmp/w", queue: "gateq", purpose: "gate", model: "", persistent: "", instructions: "" }))
      .toEqual({ name: "gate-crew", roles: { dev: { role: "dev", overrides: { cwd: "/tmp/w" } } }, maxConcurrent: 1, queue: "gateq", purpose: "gate" });
  });
  it("team: omits every optional the user left blank (role defaults to dev)", () => {
    expect(buildTeamSpec({ name: "t", role: " ", maxConcurrent: "", cwd: "/w", queue: "", purpose: "", model: "", persistent: "", instructions: "" }))
      .toEqual({ name: "t", roles: { dev: { role: "dev", overrides: { cwd: "/w" } } } });
  });
  // TEAM-FORM: model/persistent/instructions were only reachable via the raw
  // team.create/team.update RPC — now settable from the form and threaded
  // onto the seeded binding's overrides, same as cwd.
  it("team: threads model/persistent/instructions onto the seeded binding's overrides when supplied", () => {
    expect(buildTeamSpec({ name: "gate-crew", role: "dev", maxConcurrent: "", cwd: "/w", queue: "", purpose: "", model: "claude-sonnet-5", persistent: "true", instructions: "be terse" }))
      .toEqual({ name: "gate-crew", roles: { dev: { role: "dev", overrides: { cwd: "/w", model: "claude-sonnet-5", persistent: true, instructions: "be terse" } } } });
  });
  it("team: an explicit persistent=false is not conflated with an unset field", () => {
    expect(buildTeamSpec({ name: "t", role: "dev", maxConcurrent: "", cwd: "/w", queue: "", purpose: "", model: "", persistent: "false", instructions: "" }))
      .toEqual({ name: "t", roles: { dev: { role: "dev", overrides: { cwd: "/w", persistent: false } } } });
  });
  it("team: the built spec actually satisfies TeamSpecSchema (regression: the pre-fix shape parsed as invalid)", () => {
    const spec = buildTeamSpec({ name: "gate-crew", role: "dev", maxConcurrent: "1", cwd: "/tmp/w", queue: "", purpose: "", model: "", persistent: "", instructions: "" });
    expect(() => TeamSpecSchema.parse(spec)).not.toThrow();
  });
  it("push: validates + builds queue.push params sparsely", () => {
    expect(validatePushForm({ prompt: "", priority: "", role: "", workflow: "", tags: "" })).toMatch(/prompt/);
    expect(validatePushForm({ prompt: "p", priority: "1.5", role: "", workflow: "", tags: "" })).toMatch(/priority/);
    expect(validatePushForm({ prompt: "p", priority: "5", role: "dev", workflow: "", tags: "" })).toBeNull();
    expect(buildPushParams("q", { prompt: "do it", priority: "5", role: "dev", workflow: "", tags: "" }))
      .toEqual({ queue: "q", prompt: "do it", priority: 5, role: "dev" });
    expect(buildPushParams("q", { prompt: "do it", priority: "", role: "", workflow: "", tags: "" }))
      .toEqual({ queue: "q", prompt: "do it" });
    // TASK-TAGS: sparse like every other optional field — present only when actually set.
    expect(buildPushParams("q", { prompt: "do it", priority: "", role: "", workflow: "", tags: "gate:coverage" }))
      .toEqual({ queue: "q", prompt: "do it", tags: ["gate:coverage"] });
  });
  // W18 (F16 task workflows): the per-task workflow override field.
  it("push: workflow override validates the CoordName rule + rides queue.push only when set", () => {
    expect(validatePushForm({ prompt: "p", priority: "", role: "", workflow: "bad name", tags: "" })).toMatch(/workflow/);
    expect(validatePushForm({ prompt: "p", priority: "", role: "", workflow: "release-flow", tags: "" })).toBeNull();
    expect(buildPushParams("q", { prompt: "do it", priority: "", role: "", workflow: "release-flow", tags: "" }))
      .toEqual({ queue: "q", prompt: "do it", workflow: "release-flow" });
  });
  it("memory: validates + builds memory.add params", () => {
    expect(validateMemoryForm({ title: "", text: " ", tags: "", kind: "" , folder: "" })).toMatch(/text/);
    expect(validateMemoryForm({ title: "x".repeat(121), text: "ok", tags: "", kind: "", folder: "" })).toMatch(/120/);
    expect(validateMemoryForm({ title: "x".repeat(120), text: "ok", tags: "", kind: "", folder: "" })).toBeNull();
    expect(buildMemoryAddParams({ title: "", text: " note ", tags: "tui, selection", kind: "finding", folder: "" }, "app"))
      .toEqual({ author: "app", text: "note", tags: ["tui", "selection"], kind: "finding" });
    expect(buildMemoryAddParams({ title: "", text: "n", tags: "", kind: "", folder: "" }, "app")).toEqual({ author: "app", text: "n" });
    // MEM-5: title + folder ride along when set (omitted when blank ⇒ byte-identical add)
    expect(buildMemoryAddParams({ title: "GATE-WAIT-DEATH", text: "n", tags: "", kind: "fact", folder: "ops/failure" }, "app"))
      .toEqual({ author: "app", text: "n", title: "GATE-WAIT-DEATH", folder: "ops/failure", kind: "fact" });
  });
  it("parseTags splits/trims/drops empties", () => {
    expect(parseTags(" a, b ,, c")).toEqual(["a", "b", "c"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("MEM-5 memory list/rail/search selectors", () => {
  const rec = (over: Record<string, unknown>) =>
    ({ record: { id: "m1", author: "a", title: null, text: "x", tags: [], kind: "note" as const, folder: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 5, ...over }, score: 0 });

  it("memoryLabel prefers the title, else the first non-blank line (truncated)", () => {
    expect(memoryLabel("My Title", "body")).toBe("My Title");
    expect(memoryLabel(null, "\n\n  first real line  \nsecond")).toBe("first real line");
    expect(memoryLabel("   ", "fallback line")).toBe("fallback line");
    const long = "x".repeat(80);
    expect(memoryLabel(null, long)).toHaveLength(48); // 47 chars + ellipsis
  });

  it("memoryRowView surfaces title/folder + the computed label", () => {
    const v = memoryRowView(rec({ title: "GATE", folder: "ops/failure", text: "detail", updatedAt: 9 }));
    expect(v).toMatchObject({ title: "GATE", folder: "ops/failure", label: "GATE", kind: "note", ts: 9 });
  });

  it("buildFolderTree synthesizes ancestors + rolls up counts, pre-order", () => {
    const tree = buildFolderTree([
      { folder: null, count: 4 },              // unfiled — ignored by the tree
      { folder: "ops/protocols", count: 3 },
      { folder: "ops/failure", count: 2 },
      { folder: "tasks", count: 5 },
    ]);
    expect(tree.map((n) => [n.path, n.depth, n.count, n.hasChildren])).toEqual([
      ["ops", 0, 5, true],                     // synthesized parent, rolls up 3+2
      ["ops/failure", 1, 2, false],
      ["ops/protocols", 1, 3, false],
      ["tasks", 0, 5, false],
    ]);
  });

  it("unfiledCount reads the null-folder bucket (0 when absent)", () => {
    expect(unfiledCount([{ folder: null, count: 7 }, { folder: "a", count: 1 }])).toBe(7);
    expect(unfiledCount([{ folder: "a", count: 1 }])).toBe(0);
  });

  it("buildMemorySearchParams maps the folder selection + omits default mode", () => {
    const all = { kind: "all" } as const;
    expect(buildMemorySearchParams("  q ", "hybrid", { kind: "all" }))
      .toEqual({ params: { query: "q" }, unfiledOnly: false, scope: all });     // hybrid omitted
    expect(buildMemorySearchParams("", "lexical", { kind: "folder", path: "ops" }))
      .toEqual({ params: { mode: "lexical", folder: "ops" }, unfiledOnly: false, scope: all });
    expect(buildMemorySearchParams(undefined, "hybrid", { kind: "unfiled" }))
      .toEqual({ params: {}, unfiledOnly: true, scope: all });                  // unfiled ⇒ post-filter, no folder param
    expect(buildMemorySearchParams("x", "semantic", { kind: "all" }, all, 100).params)
      .toEqual({ query: "x", mode: "semantic", limit: 100 });
  });

  // F34-SCOPE-FILTER: memory.search gained a real server-side membership filter
  // (`scopeMode`), so a scope selection is now expressed to the RPC, not only
  // post-filtered: a named scope sends scope+scopeMode:"project", @global sends
  // scopeMode:"global" (there is still no scope value to send for it), and "all"
  // stays parameterless. The caller keeps post-filtering with scopeMatches as the
  // safety net for an older daemon that ignores scopeMode.
  it("buildMemorySearchParams expresses the scope selection as scope/scopeMode params", () => {
    expect(buildMemorySearchParams("", "hybrid", { kind: "all" }, { kind: "scope", name: "alpha" }).params)
      .toEqual({ scope: "alpha", scopeMode: "project" });
    expect(buildMemorySearchParams("", "hybrid", { kind: "all" }, { kind: "global" }).params)
      .toEqual({ scopeMode: "global" });
    expect(buildMemorySearchParams("", "hybrid", { kind: "all" }, { kind: "all" }).params)
      .toEqual({});
  });
});

describe("W16 (F15/D11) edit-form builders", () => {
  // ROLES-BINDING-CORRECTNESS: roles[key] is a {role, overrides} BINDING — the prefill
  // must read the binding's OWN overrides (never its top-level fields, which live under
  // `overrides`), same bug class as roleConfig's (ui-state/roles.ts).
  it("team: prefills the edit form from a team.list/status spec (first role only)", () => {
    const spec = {
      name: "tui-crew", maxConcurrent: 3, queue: "bugfix", purpose: "triage",
      roles: { dev: { role: "dev", overrides: { cwd: "/w" } }, reviewer: { role: "reviewer", overrides: { cwd: "/r" } } },
    };
    expect(teamFormValuesFromSpec(spec)).toEqual({ name: "tui-crew", role: "dev", maxConcurrent: "3", cwd: "/w", queue: "bugfix", purpose: "triage", model: "", persistent: "", instructions: "" });
  });
  it("team: degrades to defaults for a bare/malformed spec", () => {
    expect(teamFormValuesFromSpec({})).toEqual({ name: "", role: "dev", maxConcurrent: "1", cwd: "", queue: "", purpose: "", model: "", persistent: "", instructions: "" });
  });
  // TEAM-FORM: prefill must round-trip an existing role's model/persistent/
  // instructions so editing a team doesn't silently blank them on next save.
  it("team: prefills model/persistent/instructions from the first role binding's overrides", () => {
    const spec = { name: "tui-crew", roles: { dev: { role: "dev", overrides: { cwd: "/w", model: "claude-opus-5", persistent: false, instructions: "review carefully" } } } };
    expect(teamFormValuesFromSpec(spec)).toMatchObject({ model: "claude-opus-5", persistent: "false", instructions: "review carefully" });
  });
  it("team: update patch omits roles unless includeRoles, nulls out cleared queue/purpose", () => {
    const v = { name: "t", role: "dev", maxConcurrent: "4", cwd: "/w", queue: "", purpose: "", model: "", persistent: "", instructions: "" };
    expect(buildTeamUpdatePatch(v, false)).toEqual({ maxConcurrent: 4, purpose: null, queue: null });
    expect(buildTeamUpdatePatch(v, true)).toEqual({ maxConcurrent: 4, purpose: null, queue: null, roles: { dev: { role: "dev", overrides: { cwd: "/w" } } } });
  });
  it("team: update patch threads model/persistent/instructions onto the binding's overrides when includeRoles", () => {
    const v = { name: "t", role: "dev", maxConcurrent: "4", cwd: "/w", queue: "", purpose: "", model: "claude-sonnet-5", persistent: "true", instructions: "be terse" };
    expect(buildTeamUpdatePatch(v, true)).toEqual({
      maxConcurrent: 4, purpose: null, queue: null,
      roles: { dev: { role: "dev", overrides: { cwd: "/w", model: "claude-sonnet-5", persistent: true, instructions: "be terse" } } },
    });
  });
  it("team: the update patch's roles binding actually satisfies RoleBindingSchema", () => {
    const v = { name: "t", role: "dev", maxConcurrent: "4", cwd: "/w", queue: "", purpose: "", model: "", persistent: "", instructions: "" };
    const patch = buildTeamUpdatePatch(v, true) as { roles: Record<string, unknown> };
    expect(() => RoleBindingSchema.parse(patch.roles["dev"])).not.toThrow();
  });
  it("queue: validates name + non-negative integer retryLimit", () => {
    expect(validateQueueForm({ name: "", retryLimit: "" })).toMatch(/name/);
    expect(validateQueueForm({ name: "bad name", retryLimit: "" })).toMatch(/letters/);
    expect(validateQueueForm({ name: "q1", retryLimit: "-1" })).toMatch(/retry limit/);
    expect(validateQueueForm({ name: "q1", retryLimit: "3" })).toBeNull();
  });
  it("queue: builds create spec + update patch + prefill round-trip", () => {
    expect(buildQueueSpec({ name: "q1", retryLimit: "3" })).toEqual({ name: "q1", retryLimit: 3 });
    expect(buildQueueSpec({ name: "q1", retryLimit: "" })).toEqual({ name: "q1" });
    expect(buildQueueUpdatePatch({ name: "q1", retryLimit: "5" })).toEqual({ retryLimit: 5 });
    expect(queueFormValuesFromSpec({ name: "q1", retryLimit: 5 })).toEqual({ name: "q1", retryLimit: "5" });
  });
  it("memory: prefills the edit form from a record + re-stamps author on update", () => {
    const record = { id: "m1", author: "agent-a", title: "T", text: "note text", tags: ["a", "b"], kind: "fact" as const, folder: "ops", treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };
    expect(memoryFormValuesFromRecord(record)).toEqual({ title: "T", text: "note text", tags: "a, b", kind: "fact", folder: "ops" });
    // MEM-5: an untitled/unfiled record prefills with empty strings.
    const bare = { id: "m2", author: "a", title: null, text: "t", tags: [], kind: "note" as const, folder: null, treeId: null, taskId: null, createdAt: 1, updatedAt: 2 };
    expect(memoryFormValuesFromRecord(bare)).toEqual({ title: "", text: "t", tags: "", kind: "note", folder: "" });
    // update ALWAYS sends title+folder (explicit null clears a blanked field).
    expect(buildMemoryUpdateParams("m1", { title: " New ", text: " edited ", tags: "x, y", kind: "note", folder: "" }, "app"))
      .toEqual({ id: "m1", author: "app", text: "edited", title: "New", folder: null, tags: ["x", "y"], kind: "note" });
  });
});

describe("TASK-EDIT-VERSIONING: edit form + version history selectors", () => {
  it("edit-gate: only pending/blocked tasks are editable (mirrors the daemon's refusal)", () => {
    expect(isTaskEditable({ taskId: "t1", state: "pending" })).toBe(true);
    expect(isTaskEditable({ taskId: "t1", state: "blocked" })).toBe(true);
    expect(isTaskEditable({ taskId: "t1", state: "in_progress" })).toBe(false);
    expect(isTaskEditable({ taskId: "t1", state: "done" })).toBe(false);
    expect(isTaskEditable({ taskId: "t1", state: "failed" })).toBe(false);
    expect(isTaskEditable({ taskId: "t1", state: "dead_letter" })).toBe(false);
    // missing/unknown state → not editable (safe default), and null-safe
    expect(isTaskEditable({ taskId: "t1" })).toBe(false);
    expect(isTaskEditable(null)).toBe(false);
    expect(isTaskEditable(undefined)).toBe(false);
  });
  it("edit: validates prompt + integer priority", () => {
    expect(validateEditForm({ prompt: "", priority: "5", role: "dev" })).toMatch(/prompt/);
    expect(validateEditForm({ prompt: "p", priority: "1.5", role: "" })).toMatch(/priority/);
    expect(validateEditForm({ prompt: "p", priority: "", role: "" })).toBeNull();
    expect(validateEditForm({ prompt: "p", priority: "3", role: "dev", tags: "" })).toBeNull();
  });
  it("edit: prefills from the task's head fields (— role → empty) and builds a full scalar patch", () => {
    const raw = { taskId: "t1", state: "pending", role: "dev", priority: 7, prompt: "do it", tags: ["gate:coverage"] };
    expect(editFormValuesFromTask(raw)).toEqual({ prompt: "do it", priority: "7", role: "dev", tags: "gate:coverage" });
    // a role-less task prefills an empty role field (taskRowView renders "—"); a pre-tags
    // record prefills an empty tags field, not "undefined"
    expect(editFormValuesFromTask({ taskId: "t2", state: "pending", prompt: "x" }))
      .toEqual({ prompt: "x", priority: "0", role: "", tags: "" });
    // an empty role in the patch clears the per-task override back to null
    expect(buildEditPatch({ prompt: " revised ", priority: "9", role: " ", tags: "" }))
      .toEqual({ prompt: "revised", priority: 9, role: null, tags: [] });
    expect(buildEditPatch({ prompt: "p", priority: "", role: "reviewer", tags: "a, b" }))
      .toEqual({ prompt: "p", priority: 0, role: "reviewer", tags: ["a", "b"] });
  });
  it("versions: reads the append-only history defensively (empty for an un-edited/older record)", () => {
    expect(taskVersionRows({ taskId: "t1" })).toEqual([]);
    const raw = {
      taskId: "t1",
      versions: [
        { version: 1, editedAt: 111, editedBy: null, changedFields: ["prompt"], prior: { prompt: "old" } },
        { version: 2, editedAt: 222, editedBy: null, changedFields: ["priority", "role"], prior: { priority: 5, role: "dev" } },
      ],
    };
    const rows = taskVersionRows(raw);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ version: 2, editedAt: 222, changedFields: ["priority", "role"], prior: { priority: 5, role: "dev" } });
    // a malformed entry degrades to zeros/empties rather than crashing
    expect(taskVersionRows({ versions: [{}] })).toEqual([{ version: 0, editedAt: 0, changedFields: [], prior: {} }]);
  });
});

describe("small formatters", () => {
  it("fmtMemDate renders the mock's 'Jul 14' shape", () => {
    expect(fmtMemDate(new Date(2026, 6, 14, 12).getTime())).toBe("Jul 14");
  });
  it("ellipsize caps with an ellipsis", () => {
    expect(ellipsize("short")).toBe("short");
    expect(ellipsize("x".repeat(70)).length).toBe(60);
  });
});

// F02.UI: the same humanizer the TUI feed uses — the app's Events screen showed the raw
// millisecond payload, capped at 60 chars before `direction`.
describe("clockJumpSummary", () => {
  it("says slept / stepped back with a magnitude, and tones the row informational", () => {
    expect(clockJumpSummary({ driftMs: 33_180_000, direction: "forward" })).toBe("slept 9h 13m — schedules re-armed");
    expect(clockJumpSummary({ driftMs: -780_000, direction: "backward" })).toBe("clock stepped back 13m — schedules re-armed");
    expect(clockJumpSummary(null)).toBeNull();
    expect(eventRowTone("clock_jump", { direction: "forward" })).toBe("info");
  });
});

// F01.UI: the events feed is the TUI's ONLY sleep-wake surface (no schedules view exists), so the
// late-run wording here must match the app's ScheduleDetail sub-row word for word.
describe("eventSummaryOverride", () => {
  it("delegates clock_jump to the existing summary", () => {
    expect(eventSummaryOverride("clock_jump", { driftMs: 33_180_000, direction: "forward" })).toBe("slept 9h 13m \u2014 schedules re-armed");
  });

  it("falls through to the generic k=v line for everything else", () => {
    expect(eventSummaryOverride("hook_fired", { a: 1 })).toBeNull();
    expect(eventSummaryOverride("job_run_started", { job: "nightly", trigger: "scheduled" })).toBeNull();
  });

  it("says a late run was slept through, never missed or hung", () => {
    expect(eventSummaryOverride("job_run_started", { job: "nightly", trigger: "sleep-wake", latenessMs: 33_180_000, coalescedOccurrences: 3 }))
      .toBe("nightly ran late by 9h 13m (machine was asleep) \u00b7 3 occurrences coalesced");
    expect(eventSummaryOverride("job_run_started", { job: "nightly", trigger: "sleep-wake", latenessMs: 120_000, coalescedOccurrences: 1 }))
      .toBe("nightly ran late by 2m (machine was asleep) \u00b7 1 occurrence coalesced");
    expect(eventSummaryOverride("job_run_started", { job: "nightly", trigger: "sleep-wake", latenessMs: 120_000, coalescedOccurrences: 0 }))
      .toBe("nightly ran late by 2m (machine was asleep)");
  });

  it("dates the armed wake instead of printing a raw epoch", () => {
    const atMs = new Date(2026, 0, 1, 7, 58).getTime();
    expect(eventSummaryOverride("job_wake_scheduled", { atMs, forJob: "nightly", leadMs: 60_000 })).toBe("this Mac will be woken at 07:58 for nightly");
  });

  it("spells out the consequence when arming the wake failed", () => {
    const atMs = new Date(2026, 0, 1, 7, 58).getTime();
    expect(eventSummaryOverride("job_wake_failed", { atMs, reason: "wrapper not installed" }))
      .toBe("could not arm a wake for 07:58 \u2014 a run due during sleep will fire late: wrapper not installed");
  });

  it("tones an armed wake as info and a failed arm as a warning", () => {
    expect(eventKindTone("job_wake_scheduled")).toBe("info");
    expect(eventKindTone("job_wake_failed")).toBe("warn");
  });
});

// F04.UI: the daemon refuses duplicate fires, drops too-stale catch-ups and re-adopts claims on
// its own — invisible in the feed without these. The TUI has no schedules view, so the feed is
// its ONLY reading of the catch-up bound; both copies of the function must stay identical.
describe("eventSummaryOverride — job_skipped / re-adopted (F04.UI)", () => {
  it("names a refused duplicate, manual apart from a scheduled fire", () => {
    // The slot is rendered in LOCAL time (wakeClock uses getHours), so the expectation is computed
    // the same way rather than hard-coded to one machine's zone.
    const slotTs = 3_600_000;
    const d = new Date(slotTs);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(eventSummaryOverride("job_skipped", { job: "nightly", reason: "duplicate-occurrence", trigger: "manual", nominalFireTs: slotTs }))
      .toBe(`nightly: manual run refused for the ${hhmm} slot — that slot has already run`);
    expect(eventSummaryOverride("job_skipped", { job: "nightly", reason: "duplicate-occurrence" }))
      .toBe("nightly: duplicate fire refused — that slot has already run");
  });

  it("quotes both how late the slot was and the limit it lost to", () => {
    expect(eventSummaryOverride("job_skipped", { job: "nightly", reason: "stale-beyond-window", lateMs: 11_040_000, maxStalenessMs: 7_200_000 }))
      .toBe("nightly: catch-up skipped — 3h 4m late, past the 2h catch-up limit");
    expect(eventSummaryOverride("job_skipped", { job: "nightly", reason: "stale-beyond-window" }))
      .toBe("nightly: catch-up skipped — too late");
  });

  it("explains a missed-while-down slot and an overlap in operator words", () => {
    expect(eventSummaryOverride("job_skipped", { job: "n", reason: "missed-restart" }))
      .toBe("n: missed while the daemon was down — not caught up");
    expect(eventSummaryOverride("job_skipped", { job: "n", reason: "overlap" }))
      .toBe("n: skipped — the previous run is still going");
    // F05.QA-FIX: this slot used to disappear entirely — no run row, no event, nothing to narrate.
    expect(eventSummaryOverride("job_skipped", { job: "n", reason: "retry-pending", nominalFireTs: 1_700_000_000_000 }))
      .toContain("a retry of an earlier run is still pending");
  });

  it("falls back to the raw event rather than inventing words for an unknown reason", () => {
    expect(eventSummaryOverride("job_skipped", { job: "n", reason: "who-knows" })).toBeNull();
  });

  it("announces a claim re-adopted across a daemon restart", () => {
    expect(eventSummaryOverride("job_run_started", { job: "nightly", readopted: true }))
      .toBe("nightly: re-adopted a run that was still in flight when the daemon restarted");
    expect(eventSummaryOverride("job_run_started", { job: "nightly", trigger: "scheduled" })).toBeNull();
  });
});

// F05.UI: a dead-letter STOPS a schedule for good; without a line here it reaches the feed as a
// bare kind + raw k=v. core's deadLetter() fires job_disabled alongside it, so that kind is folded
// into one short line rather than repeating the sentence.
describe("eventSummaryOverride — job_dead_letter / job_disabled (F05.UI)", () => {
  it("spells out the attempts, the consequence and the last error", () => {
    expect(eventSummaryOverride("job_dead_letter", {
      job: "nightly", attempts: 3, maxAttempts: 3,
      reasons: [{ ts: 1, error: "connection reset" }, { ts: 2, error: "timeout" }],
    })).toBe("nightly: dead-lettered after 3 of 3 failed attempts \u2014 the schedule is stopped until it is requeued: timeout");
  });

  it("keeps the attempt noun singular at 1 and survives a missing maxAttempts", () => {
    expect(eventSummaryOverride("job_dead_letter", { job: "nightly", attempts: 1, reasons: [] }))
      .toBe("nightly: dead-lettered after 1 failed attempt \u2014 the schedule is stopped until it is requeued");
  });

  it("collapses the twin job_disabled into one short line instead of repeating the sentence", () => {
    expect(eventSummaryOverride("job_disabled", { job: "nightly", reason: "dead-letter after 3 attempts: timeout" }))
      .toBe("nightly: schedule stopped (dead-lettered)");
  });

  it("still reads an ordinary disable in full", () => {
    expect(eventSummaryOverride("job_disabled", { job: "nightly", reason: "operator turned it off" }))
      .toBe("nightly: schedule disabled \u2014 operator turned it off");
  });

  it("tones a dead-letter danger and a plain disable warn", () => {
    expect(eventKindTone("job_dead_letter")).toBe("danger");
    expect(eventKindTone("job_disabled")).toBe("warn");
  });
});
