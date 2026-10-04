import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, TAB_ORDER, type Action, type UiState } from "@chimera/ui-state";

const feed = (state: UiState, actions: Action[]) => actions.reduce(reduce, state);

describe("reducer: data actions", () => {
  it("daemonStatus updates connection, counts and accounts", () => {
    const st = reduce(initialState, {
      type: "daemonStatus",
      status: {
        protocolVersion: 1,
        agents: { running: 2, done: 1, failed: 0, killed: 0 },
        accounts: [{ name: "main", provider: "claude", authType: "subscription", cooling: true, coolingUntil: 99 }],
      },
    });
    expect(st.connected).toBe(true);
    expect(st.protocolVersion).toBe(1);
    expect(st.agentCounts.running).toBe(2);
    expect(st.accounts[0]!.cooling).toBe(true);
  });

  // Task AUTH-b: daemonStatus is a loose passthrough for `accounts` -- verify the
  // new authExpired field survives the reduce untouched (no stripping/mapping).
  it("daemonStatus passthrough keeps authExpired on accounts", () => {
    const st = reduce(initialState, {
      type: "daemonStatus",
      status: {
        protocolVersion: 1,
        agents: { running: 0, done: 0, failed: 0, killed: 0 },
        accounts: [{ name: "main", provider: "claude", authType: "subscription", cooling: false, coolingUntil: null, authExpired: true }],
      },
    });
    expect(st.accounts[0]!.authExpired).toBe(true);
  });

  it("agentRecords merges authoritative daemon state and orders by createdAt", () => {
    const withEvent = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "b", kind: "message_complete", data: { text: "hi" } },
    });
    const st = reduce(withEvent, {
      type: "agentRecords",
      records: [
        { agentId: "b", state: "killed", accountName: "second", provider: "claude", displayLabel: "release captain", costUsd: 0.5, createdAt: 20, spec: { conductor: true } },
        { agentId: "a", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 10 },
      ],
    });
    expect(st.agentOrder).toEqual(["a", "b"]);
    expect(st.agents["b"]!.state).toBe("killed");                  // daemon wins over event-derived state
    expect(st.agents["b"]!.conductor).toBe(true);
    expect(st.agents["b"]!.displayLabel).toBe("release captain");
    expect(st.agents["b"]!.account).toBe("second");
    expect(st.agents["b"]!.transcript.length).toBe(1);             // event-projected transcript survives the merge
    expect(st.selectedAgentId).toBe("b");                          // selection made by the event is kept
  });

  it("teams/queues availability toggles", () => {
    const st = feed(initialState, [
      { type: "teams", available: true, items: [{ name: "alpha" }] },
      { type: "queues", available: false, items: [] },
    ]);
    expect(st.teams).toEqual({ available: true, items: [{ name: "alpha" }] });
    expect(st.queues.available).toBe(false);
  });

  // TUI-038 (MINOR): `available:false` used to be the INITIAL value too, so the
  // "requires a Phase 2 daemon" notice (ListPane.tsx) rendered not just for a
  // genuine Phase-1 daemon but also before the first successful team.list/
  // queue.list call, and after any transient (non-isUnknownMethod) failure --
  // both misleading. Teams/queues now start OPTIMISTIC (available:true), so
  // pre-load and transient-failure states show the normal empty hint instead;
  // only a positively-confirmed isUnknownMethod (store.ts's tryPhase2) flips
  // it to false. See store.test.ts for the tryPhase2-level coverage of that
  // transition.
  it("initialState.teams/queues start OPTIMISTIC (available:true, no items) instead of false (TUI-038)", () => {
    expect(initialState.teams).toEqual({ available: true, items: [] });
    expect(initialState.queues).toEqual({ available: true, items: [] });
  });
});

// ---------------------------------------------------------------------------
// TUI-007 (MAJOR): reconnection status flag -- surfaced by StatusBar as the
// yellow "reconnecting..." state between a connection drop and recovery.
// ---------------------------------------------------------------------------

describe("reducer: reconnecting flag (TUI-007)", () => {
  it("initialState.reconnecting starts false", () => {
    expect(initialState.reconnecting).toBe(false);
  });

  it("the 'reconnecting' action sets state.reconnecting to the dispatched value, independent of `connected`", () => {
    const st = reduce(initialState, { type: "reconnecting", reconnecting: true });
    expect(st.reconnecting).toBe(true);
    expect(st.connected).toBe(false);              // unaffected -- these are independent fields
    const st2 = reduce(st, { type: "reconnecting", reconnecting: false });
    expect(st2.reconnecting).toBe(false);
  });
});

describe("reducer: UI actions", () => {
  it("tabNext/tabPrev cycle through TAB_ORDER with wraparound", () => {
    // Task TAB1 + MEMORY TAB: TAB_ORDER is now ["agents","teams","queues","events",
    // "memory"] (Agents first, Memory last) -- these wraparound expectations follow
    // the reordered array.
    expect(reduce(initialState, { type: "tabNext" }).activeTab).toBe("teams");         // agents -> teams
    expect(reduce(initialState, { type: "tabPrev" }).activeTab).toBe("memory");        // agents -> memory (wrap backwards)
    const atTeams = reduce(initialState, { type: "selectTab", tab: "teams" });
    expect(reduce(atTeams, { type: "tabPrev" }).activeTab).toBe("agents");             // teams -> agents
    const atMemory = reduce(initialState, { type: "selectTab", tab: "memory" });
    expect(reduce(atMemory, { type: "tabNext" }).activeTab).toBe("agents");            // wrap forwards
  });

  it("selectDelta moves within agentOrder and clamps at the edges", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        { agentId: "a", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
        { agentId: "b", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2 },
      ],
    });
    expect(st.selectedAgentId).toBe("a");
    const down = reduce(st, { type: "selectDelta", delta: 1 });
    expect(down.selectedAgentId).toBe("b");
    expect(reduce(down, { type: "selectDelta", delta: 1 }).selectedAgentId).toBe("b"); // clamp bottom
    expect(reduce(st, { type: "selectDelta", delta: -1 }).selectedAgentId).toBe("a");  // clamp top
  });

  it("setMode, permissionAnswered and userSent", () => {
    const withPerm = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "permission_request", data: { requestId: "r1", toolName: "Bash", input: {}, policy: "tui" } },
    });
    const answered = reduce(withPerm, { type: "permissionAnswered", requestId: "r1" });
    expect(answered.pendingPermissions).toEqual([]);

    expect(reduce(initialState, { type: "setMode", mode: "spawn" }).mode).toBe("spawn");

    const sent = reduce(withPerm, { type: "userSent", agentId: "a", text: "hurry up" });
    expect(sent.agents["a"]!.transcript.at(-1)).toMatchObject({ role: "user", text: "hurry up" });

    // FIX-B3 (TUI-022 follow-up): userSent now tolerantly upserts a placeholder
    // record for an agentId with no existing state.agents entry (e.g. the lazy-spawn
    // echo racing ahead of the daemon's agent.list) instead of silently no-opping.
    // The placeholder is seeded as "running" so downstream "is this conductor still
    // alive?" checks (sendToMain's noLongerRunning, App.tsx's
    // permissionModeStillApplies) keep treating it as presumed-alive, not dead.
    const ghost = reduce(initialState, { type: "userSent", agentId: "ghost", text: "x" });
    expect(ghost.agents["ghost"]!.transcript).toMatchObject([{ role: "user", text: "x" }]);
    expect(ghost.agents["ghost"]!.state).toBe("running");
  });

  it("commandError sets and clears lastError", () => {
    const st = reduce(initialState, { type: "commandError", message: "agent.send failed" });
    expect(st.lastError).toBe("agent.send failed");
    expect(reduce(st, { type: "commandError", message: null }).lastError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Coverage additions beyond the brief's example tests: every remaining branch,
// boundary and precedence rule in the Step-3 reduce() implementation.
// ---------------------------------------------------------------------------

describe("reducer: agentRecords — additional branch/edge coverage", () => {
  it("keeps agents NOT present in the new records (extras) appended after the authoritative order", () => {
    const withEvents = feed(initialState, [
      { type: "event", event: { ts: 1, seq: 1, agentId: "old", kind: "agent_started", data: {} } },
    ]);
    const st = reduce(withEvents, {
      type: "agentRecords",
      records: [{ agentId: "new", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 5 }],
    });
    expect(st.agentOrder).toEqual(["new", "old"]);      // authoritative records first, event-only extras after
    expect(st.agents["old"]!.state).toBe("running");     // untouched, still event-derived
  });

  it("an empty records array leaves agentOrder as pure extras and does not clear an existing selection", () => {
    const withEvents = feed(initialState, [
      { type: "event", event: { ts: 1, seq: 1, agentId: "x", kind: "agent_started", data: {} } },
    ]);
    expect(withEvents.selectedAgentId).toBe("x");
    const st = reduce(withEvents, { type: "agentRecords", records: [] });
    expect(st.agentOrder).toEqual(["x"]);
    expect(st.selectedAgentId).toBe("x");               // state.selectedAgentId ?? order[0] ?? null keeps prior pick
  });

  it("an empty records array on a fully empty state leaves selectedAgentId null (order[0] undefined branch)", () => {
    const st = reduce(initialState, { type: "agentRecords", records: [] });
    expect(st.agentOrder).toEqual([]);
    expect(st.selectedAgentId).toBeNull();
  });

  it("spec.conductor absent or false both project conductor: false (only === true is truthy)", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        { agentId: "a", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
        { agentId: "b", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 2, spec: { conductor: false } },
      ],
    });
    expect(st.agents["a"]!.conductor).toBe(false);
    expect(st.agents["b"]!.conductor).toBe(false);
  });

  it("costUsd uses truthy fallback: a nonzero prior cost survives an authoritative 0 (documents the `||` precedence as given)", () => {
    const withCost = feed(initialState, [
      { type: "event", event: { ts: 1, seq: 1, agentId: "a", kind: "turn_complete", data: { turnCostUsd: 2.5 } } },
    ]);
    expect(withCost.agents["a"]!.costUsd).toBe(2.5);
    const st = reduce(withCost, {
      type: "agentRecords",
      records: [{ agentId: "a", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["a"]!.costUsd).toBe(2.5); // `r.costUsd || prev.costUsd` — 0 is falsy, prior value wins
  });

  it("a genuinely nonzero authoritative costUsd always overrides the prior value", () => {
    const withCost = feed(initialState, [
      { type: "event", event: { ts: 1, seq: 1, agentId: "a", kind: "turn_complete", data: { turnCostUsd: 1 } } },
    ]);
    const st = reduce(withCost, {
      type: "agentRecords",
      records: [{ agentId: "a", state: "done", accountName: "main", provider: "claude", costUsd: 3, createdAt: 1 }],
    });
    expect(st.agents["a"]!.costUsd).toBe(3);
  });

  it("agentRecords for a brand-new agentId (never seen via events) is built via emptyAgent — pendingQuestion seeded null", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "fresh", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
    });
    expect(st.agents["fresh"]!.pendingQuestion).toBeNull();
    expect(st.agents["fresh"]!.transcript).toMatchObject([]);
    expect(st.agents["fresh"]!.tools).toMatchObject([]);
  });

  it("sorts strictly by createdAt regardless of input array order (three records, scrambled)", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [
        { agentId: "c", state: "running", accountName: "m", provider: "claude", costUsd: 0, createdAt: 30 },
        { agentId: "a", state: "running", accountName: "m", provider: "claude", costUsd: 0, createdAt: 10 },
        { agentId: "b", state: "running", accountName: "m", provider: "claude", costUsd: 0, createdAt: 20 },
      ],
    });
    expect(st.agentOrder).toEqual(["a", "b", "c"]);
  });
});

describe("reducer: tab cycling — additional coverage", () => {
  it("tabNext five times from the initial tab returns to the initial tab (full wraparound loop)", () => {
    let st = initialState;
    for (let i = 0; i < TAB_ORDER.length; i++) st = reduce(st, { type: "tabNext" });
    expect(st.activeTab).toBe(initialState.activeTab);
  });

  it("tabPrev five times from the initial tab returns to the initial tab (full wraparound loop, opposite direction)", () => {
    let st = initialState;
    for (let i = 0; i < TAB_ORDER.length; i++) st = reduce(st, { type: "tabPrev" });
    expect(st.activeTab).toBe(initialState.activeTab);
  });

  it("selectTab jumps directly to any TabId without needing to cycle", () => {
    expect(reduce(initialState, { type: "selectTab", tab: "queues" }).activeTab).toBe("queues");
  });
});

describe("reducer: selectDelta — additional branch/edge coverage", () => {
  it("selectDelta on an empty agentOrder is a no-op (same reference)", () => {
    expect(reduce(initialState, { type: "selectDelta", delta: 1 })).toBe(initialState);
    expect(reduce(initialState, { type: "selectDelta", delta: -1 })).toBe(initialState);
  });

  it("selectDelta with a null selectedAgentId (defensive fixture) treats the cursor as index 0", () => {
    const fixture: UiState = { ...initialState, agentOrder: ["a", "b", "c"], selectedAgentId: null };
    const st = reduce(fixture, { type: "selectDelta", delta: 1 });
    expect(st.selectedAgentId).toBe("b"); // cur defaults to 0, then +1
  });

  it("selectDelta with a selectedAgentId that is no longer in agentOrder (stale) clamps to index 0", () => {
    const fixture: UiState = { ...initialState, agentOrder: ["a", "b", "c"], selectedAgentId: "ghost" };
    const st = reduce(fixture, { type: "selectDelta", delta: 1 });
    expect(st.selectedAgentId).toBe("b"); // indexOf === -1 -> Math.max(0, -1) = 0, then +1
  });

  it("a delta larger than the list length clamps to the last element, not out of bounds", () => {
    const fixture: UiState = { ...initialState, agentOrder: ["a", "b"], selectedAgentId: "a" };
    const st = reduce(fixture, { type: "selectDelta", delta: 99 });
    expect(st.selectedAgentId).toBe("b");
  });

  it("a very negative delta clamps to the first element, not out of bounds", () => {
    const fixture: UiState = { ...initialState, agentOrder: ["a", "b"], selectedAgentId: "b" };
    const st = reduce(fixture, { type: "selectDelta", delta: -99 });
    expect(st.selectedAgentId).toBe("a");
  });

  it("selectDelta with delta 0 is idempotent (stays on the same agent)", () => {
    const fixture: UiState = { ...initialState, agentOrder: ["a", "b"], selectedAgentId: "b" };
    expect(reduce(fixture, { type: "selectDelta", delta: 0 }).selectedAgentId).toBe("b");
  });
});

describe("reducer: permissionAnswered / commandError / userSent — additional edge coverage", () => {
  it("permissionAnswered with an unknown requestId leaves other pending permissions untouched", () => {
    const withPerm = feed(initialState, [
      { type: "event", event: { ts: 1, seq: 1, agentId: "a", kind: "permission_request", data: { requestId: "keep", toolName: "Bash", input: {}, policy: "tui" } } },
    ]);
    const st = reduce(withPerm, { type: "permissionAnswered", requestId: "does-not-exist" });
    expect(st.pendingPermissions).toEqual(withPerm.pendingPermissions);
  });

  it("permissionAnswered on an already-empty list is a harmless no-op", () => {
    const st = reduce(initialState, { type: "permissionAnswered", requestId: "r1" });
    expect(st.pendingPermissions).toEqual([]);
  });

  it("commandError can set, then overwrite with a different message, then clear", () => {
    const s1 = reduce(initialState, { type: "commandError", message: "first" });
    const s2 = reduce(s1, { type: "commandError", message: "second" });
    expect(s2.lastError).toBe("second");
    expect(reduce(s2, { type: "commandError", message: null }).lastError).toBeNull();
  });

  it("userSent with an empty-string text still appends a user transcript item (falsy-but-valid)", () => {
    const withAgent = feed(initialState, [
      { type: "event", event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: {} } },
    ]);
    const st = reduce(withAgent, { type: "userSent", agentId: "a", text: "" });
    expect(st.agents["a"]!.transcript.at(-1)).toMatchObject({ role: "user", text: "" });
  });

  it("userSent preserves prior transcript entries rather than replacing them", () => {
    const withMsg = feed(initialState, [
      { type: "event", event: { ts: 1, seq: 1, agentId: "a", kind: "message_complete", data: { text: "hello" } } },
    ]);
    const st = reduce(withMsg, { type: "userSent", agentId: "a", text: "reply" });
    expect(st.agents["a"]!.transcript).toMatchObject([
      { role: "assistant", text: "hello", streaming: false },
      { role: "user", text: "reply" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// TUI-042 (MINOR): a dedicated `notice` channel for informational messages
// (conductor account/respawn notices) that must NOT ride the red `lastError`
// channel. Mirrors commandError's own set/overwrite/clear shape, but is
// entirely independent state -- setting one never touches the other.
// ---------------------------------------------------------------------------

describe("reducer: notice action (TUI-042)", () => {
  it("initialState.notice starts null", () => {
    expect(initialState.notice).toBeNull();
  });

  it("notice sets state.notice without touching lastError", () => {
    const st = reduce(initialState, { type: "notice", message: "a fresh session started" });
    expect(st.notice).toBe("a fresh session started");
    expect(st.lastError).toBeNull();
  });

  it("notice can overwrite a previous notice with a new message", () => {
    const s1 = reduce(initialState, { type: "notice", message: "first" });
    const s2 = reduce(s1, { type: "notice", message: "second" });
    expect(s2.notice).toBe("second");
  });

  it("notice: null clears an existing notice", () => {
    const s1 = reduce(initialState, { type: "notice", message: "will be cleared" });
    const s2 = reduce(s1, { type: "notice", message: null });
    expect(s2.notice).toBeNull();
  });

  it("commandError and notice are independent: setting one never sets or clears the other", () => {
    const withError = reduce(initialState, { type: "commandError", message: "boom" });
    const withBoth = reduce(withError, { type: "notice", message: "fyi" });
    expect(withBoth.lastError).toBe("boom");     // commandError's own state survives
    expect(withBoth.notice).toBe("fyi");
    const clearedError = reduce(withBoth, { type: "commandError", message: null });
    expect(clearedError.notice).toBe("fyi");     // clearing lastError doesn't touch notice
    expect(clearedError.lastError).toBeNull();
  });
});

describe("reducer: daemonStatus — additional edge coverage", () => {
  it("a second daemonStatus without accounts falls back to the previously-known accounts (not cleared)", () => {
    const first = reduce(initialState, {
      type: "daemonStatus",
      status: {
        protocolVersion: 1,
        agents: { running: 1, done: 0, failed: 0, killed: 0 },
        accounts: [{ name: "main", provider: "claude", authType: "subscription", cooling: false, coolingUntil: null }],
      },
    });
    const second = reduce(first, {
      type: "daemonStatus",
      status: { protocolVersion: 2, agents: { running: 0, done: 1, failed: 0, killed: 0 } },
    });
    expect(second.accounts).toEqual(first.accounts);
    expect(second.protocolVersion).toBe(2);
  });

  it("daemonStatus always sets connected true even if it was already true", () => {
    const connected = reduce(initialState, { type: "connected", connected: true });
    const st = reduce(connected, {
      type: "daemonStatus",
      status: { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 } },
    });
    expect(st.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FC-2 (F4-display): daemon.status's federation peers must thread through the
// reducer into UiState.peers so StatusBar can render them.
// ---------------------------------------------------------------------------

describe("reducer: daemonStatus — peers (FC-2 F4-display)", () => {
  it("initialState.peers defaults to an empty array", () => {
    expect(initialState.peers).toEqual([]);
  });

  it("daemonStatus with peers sets state.peers verbatim", () => {
    const st = reduce(initialState, {
      type: "daemonStatus",
      status: {
        protocolVersion: 1,
        agents: { running: 0, done: 0, failed: 0, killed: 0 },
        peers: [{ engineId: "studio", state: "connected", outboxPending: 0 }],
      },
    });
    expect(st.peers).toEqual([{ engineId: "studio", state: "connected", outboxPending: 0 }]);
  });

  it("daemonStatus without peers defaults to [] (not undefined)", () => {
    const st = reduce(initialState, {
      type: "daemonStatus",
      status: { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 } },
    });
    expect(st.peers).toEqual([]);
  });

  it("a second daemonStatus WITHOUT peers RESETS peers to [] -- unlike accounts, peers does NOT fall back to the prior value (spec: `action.status.peers ?? []`)", () => {
    const first = reduce(initialState, {
      type: "daemonStatus",
      status: {
        protocolVersion: 1,
        agents: { running: 0, done: 0, failed: 0, killed: 0 },
        peers: [{ engineId: "studio", state: "connected", outboxPending: 0 }],
      },
    });
    expect(first.peers).toHaveLength(1);
    const second = reduce(first, {
      type: "daemonStatus",
      status: { protocolVersion: 2, agents: { running: 0, done: 0, failed: 0, killed: 0 } },
    });
    expect(second.peers).toEqual([]);
  });

  it("an explicit empty peers array is preserved as empty (not treated as absent)", () => {
    const st = reduce(initialState, {
      type: "daemonStatus",
      status: { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 }, peers: [] },
    });
    expect(st.peers).toEqual([]);
  });

  it("daemonStatus with peers does not disturb accounts (both project independently)", () => {
    const st = reduce(initialState, {
      type: "daemonStatus",
      status: {
        protocolVersion: 1,
        agents: { running: 0, done: 0, failed: 0, killed: 0 },
        accounts: [{ name: "main", provider: "claude", authType: "subscription", cooling: false, coolingUntil: null }],
        peers: [{ engineId: "studio", state: "partitioned", outboxPending: 2 }],
      },
    });
    expect(st.accounts).toEqual([{ name: "main", provider: "claude", authType: "subscription", cooling: false, coolingUntil: null }]);
    expect(st.peers).toEqual([{ engineId: "studio", state: "partitioned", outboxPending: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// Task SHELL.2: lazy main conductor + permission mode — pure reducer actions.
// ---------------------------------------------------------------------------

describe("reducer: mainConductorId / permissionMode / selectAgent actions (SHELL.2)", () => {
  it("initialState defaults mainConductorId to null and permissionMode to 'bypass'", () => {
    expect(initialState.mainConductorId).toBeNull();
    expect(initialState.permissionMode).toBe("bypass");
  });

  it("mainConductorId action sets the field, overwriting any prior value", () => {
    const st = reduce(initialState, { type: "mainConductorId", agentId: "c1" });
    expect(st.mainConductorId).toBe("c1");
    const st2 = reduce(st, { type: "mainConductorId", agentId: "c2" });
    expect(st2.mainConductorId).toBe("c2");
  });

  it("permissionMode action sets the field; toggling both directions round-trips", () => {
    const asked = reduce(initialState, { type: "permissionMode", mode: "ask" });
    expect(asked.permissionMode).toBe("ask");
    const back = reduce(asked, { type: "permissionMode", mode: "bypass" });
    expect(back.permissionMode).toBe("bypass");
  });

  it("selectAgent sets selectedAgentId directly, even to an id not yet present in agentOrder (pre-refresh auto-select)", () => {
    const st = reduce(initialState, { type: "selectAgent", agentId: "not-yet-listed" });
    expect(st.selectedAgentId).toBe("not-yet-listed");
    expect(st.agentOrder).toEqual([]);    // does not fabricate an agentOrder entry
  });

  it("selectAgent overrides a prior selection unconditionally", () => {
    const withSel = reduce(initialState, { type: "selectAgent", agentId: "a" });
    const st = reduce(withSel, { type: "selectAgent", agentId: "b" });
    expect(st.selectedAgentId).toBe("b");
  });
});

describe("reducer: connected action", () => {
  it("connected toggles true and false independently of daemonStatus", () => {
    expect(reduce(initialState, { type: "connected", connected: true }).connected).toBe(true);
    const on = reduce(initialState, { type: "connected", connected: true });
    expect(reduce(on, { type: "connected", connected: false }).connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P3.6: agent_question `default`/`timeoutMs` projection + pendingQuestion
// clearing (questionAnswered action, and error/interrupted terminal events).
// ---------------------------------------------------------------------------

describe("reducer: agent_question default/timeoutMs projection", () => {
  it("projects both `default` and `timeoutMs` onto pendingQuestion when the emitter sends them", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a1", kind: "agent_question",
        data: {
          questionId: "q1", prompt: "deploy?", options: [{ id: "yes", label: "Yes" }],
          default: { optionIds: ["yes"] }, timeoutMs: 30_000,
        },
      },
    });
    expect(st.agents["a1"]!.pendingQuestion?.default).toEqual({ optionIds: ["yes"] });
    expect(st.agents["a1"]!.pendingQuestion?.timeoutMs).toBe(30_000);
  });

  it("a `default` of null is projected as-is (explicit no-default), not omitted", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_question", data: { questionId: "q1", prompt: "ok?", default: null, timeoutMs: null } },
    });
    expect(st.agents["a1"]!.pendingQuestion).toHaveProperty("default", null);
    expect(st.agents["a1"]!.pendingQuestion).toHaveProperty("timeoutMs", null);
  });

  it("omits `default`/`timeoutMs` entirely when the event carries neither (mirrors header/options)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_question", data: { questionId: "q1", prompt: "ok?" } },
    });
    expect(st.agents["a1"]!.pendingQuestion).not.toHaveProperty("default");
    expect(st.agents["a1"]!.pendingQuestion).not.toHaveProperty("timeoutMs");
  });
});

describe("reducer: questionAnswered action", () => {
  const withQuestion = reduce(initialState, {
    type: "event",
    event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_question", data: { questionId: "q1", prompt: "deploy?" } },
  });

  it("clears pendingQuestion when the questionId matches the agent's pending one", () => {
    const st = reduce(withQuestion, { type: "questionAnswered", agentId: "a1", questionId: "q1" });
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
  });

  it("is a no-op when the questionId does not match (stale/duplicate answer) — question stays", () => {
    const st = reduce(withQuestion, { type: "questionAnswered", agentId: "a1", questionId: "q-stale" });
    expect(st.agents["a1"]!.pendingQuestion).toEqual(withQuestion.agents["a1"]!.pendingQuestion);
  });

  it("is a no-op for an unknown agentId", () => {
    const st = reduce(withQuestion, { type: "questionAnswered", agentId: "ghost", questionId: "q1" });
    expect(st).toBe(withQuestion);
  });
});

describe("reducer: pendingQuestion clearing on error/interrupted terminal events", () => {
  it("an 'error' event clears a pending question for that agent", () => {
    const withQuestion = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_question", data: { questionId: "q1", prompt: "deploy?" } },
    });
    const st = reduce(withQuestion, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a1", kind: "error", data: { message: "boom" } },
    });
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
  });

  it("a 'status' event carrying an interrupted state clears a pending question for that agent", () => {
    const withQuestion = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_question", data: { questionId: "q1", prompt: "deploy?" } },
    });
    const st = reduce(withQuestion, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a1", kind: "status", data: { state: "interrupted" } },
    });
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
  });

  it("a 'result' event (terminal 'done') clears a pending question, mirroring error/interrupted (AGENT-DONE-STATE-STALE-UI)", () => {
    // `result` fires once when the agent session terminates and the reducer maps it to
    // state "done". Because derivedState renders "waiting" whenever a banner is set
    // REGARDLESS of state, a question stranded at completion masked "done" as "waiting"
    // forever (the reported bug). A done agent can't answer, so it now clears — the
    // former "scope boundary: only error/interrupted" left this terminal path leaking.
    const withQuestion = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a1", kind: "agent_question", data: { questionId: "q1", prompt: "deploy?" } },
    });
    const st = reduce(withQuestion, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a1", kind: "result", data: { text: "done", costUsd: 0.1 } },
    });
    expect(st.agents["a1"]!.state).toBe("done");
    expect(st.agents["a1"]!.pendingQuestion).toBeNull();
  });
});
