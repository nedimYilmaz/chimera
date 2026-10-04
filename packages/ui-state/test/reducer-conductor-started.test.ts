import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState } from "@chimera/ui-state";

// Final-acceptance MAJOR 3 (in-session ◆ marker): the supervisor folds
// spec.conductor onto the agent_started event, and the reducer projects it
// onto AgentView.conductor — so a lazy-spawned conductor wears its row marker
// and "conductor" tag from the live stream, without an agent.list refetch.
// Additive + defensive: only an explicit `true` sets the flag.
describe("reducer: agent_started captures conductor (MAJOR 3)", () => {
  it("projects a custom display label from the live agent_started event", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a", kind: "agent_started",
        data: { conductor: true, displayLabel: "release captain" },
      },
    });
    expect(st.agents["a"]!.displayLabel).toBe("release captain");
  });

  it("sets AgentView.conductor from data.conductor:true on agent_started", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { sessionId: "s1", conductor: true } },
    });
    expect(st.agents["a"]!.conductor).toBe(true);
    expect(st.agents["a"]!.sessionId).toBe("s1"); // pre-existing capture untouched
  });

  it("leaves conductor false when agent_started carries no field (older daemon / plain spawn)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: {} },
    });
    expect(st.agents["a"]!.conductor).toBe(false);
  });

  it("ignores non-true values (defensive: malformed/loosely-typed event data)", () => {
    for (const bad of [false, "true", 1, null]) {
      const st = reduce(initialState, {
        type: "event",
        event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { conductor: bad } },
      });
      expect(st.agents["a"]!.conductor).toBe(false);
    }
  });

  it("a later agent_started WITHOUT the field never clears a set flag (resume re-emit)", () => {
    const marked = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { conductor: true } },
    });
    const st = reduce(marked, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a", kind: "agent_started", data: {} },
    });
    expect(st.agents["a"]!.conductor).toBe(true);
  });

  // WORKFLOW-TASK-VIEW-2 (bug B): scheduler.ts forces spec.conductor:true on
  // EVERY workflow-bound task spawn too (D12 — keeps that session's input
  // stream open across steps), a session-liveness signal with no relation to
  // conductor DISPLAY identity — the live symptom was a workflow step agent
  // (a plain team-queue role, e.g. "xp-glm") rendering as "◆ main-2
  // conductor". A real conductor never carries team membership; a workflow
  // step (or any other team-queue) agent always does — the reducer must treat
  // `conductor:true` alongside a `membership` in the SAME event as the D12
  // hack, not real conductor identity.
  it("conductor:true is IGNORED when the same agent_started also carries team membership (D12 session-liveness hack, not real conductor identity)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a", kind: "agent_started",
        data: { conductor: true, membership: { team: "team-chimera", role: "xp-glm" } },
      },
    });
    expect(st.agents["a"]!.conductor).toBe(false);
    expect(st.agents["a"]!.membership).toEqual({ team: "team-chimera", role: "xp-glm" });
  });

  it("conductor:true still sets the flag when no membership rides the SAME event (a real conductor never carries one)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { conductor: true } },
    });
    expect(st.agents["a"]!.conductor).toBe(true);
    expect(st.agents["a"]!.membership).toBeUndefined();
  });
});

// TEAMGROUP-LIVE: the supervisor folds the scheduler-stamped team/role
// membership onto agent_started, and the reducer projects it onto
// AgentView.membership — so a team worker spawned AFTER the initial agent.list
// snapshot groups under its team from the live stream, instead of rendering
// teamless & detached at the bottom of AgentList until the next refetch.
// Defensive projection mirrors the agent.list snapshot merge exactly.
describe("reducer: agent_started captures membership (TEAMGROUP-LIVE)", () => {
  it("sets AgentView.membership from data.membership on agent_started", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a", kind: "agent_started",
        data: { sessionId: "s1", membership: { team: "team-chimera", role: "staff-pm-2" } },
      },
    });
    expect(st.agents["a"]!.membership).toEqual({ team: "team-chimera", role: "staff-pm-2" });
    expect(st.agents["a"]!.sessionId).toBe("s1"); // pre-existing capture untouched
  });

  it("leaves membership undefined when agent_started carries no field (plain/teamless spawn)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: {} },
    });
    expect(st.agents["a"]!.membership).toBeUndefined();
  });

  it("ignores malformed membership (defensive: object without a string team)", () => {
    for (const bad of [null, "team-x", 1, {}, { role: "r" }, { team: 5 }]) {
      const st = reduce(initialState, {
        type: "event",
        event: { ts: 1, seq: 1, agentId: "a", kind: "agent_started", data: { membership: bad } },
      });
      expect(st.agents["a"]!.membership).toBeUndefined();
    }
  });

  it("a later agent_started WITHOUT membership never clears a set membership (resume re-emit)", () => {
    const stamped = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a", kind: "agent_started",
        data: { membership: { team: "team-chimera", role: "staff-pm-2" } },
      },
    });
    const st = reduce(stamped, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a", kind: "agent_started", data: {} },
    });
    expect(st.agents["a"]!.membership).toEqual({ team: "team-chimera", role: "staff-pm-2" });
  });
});

// PROJECT-CONDUCTOR-VISIBILITY: supervisor.spawn now appends a status/registered:true marker
// for EVERY record at registration time, BEFORE the backend has emitted anything of its own — a
// resumeOnly project conductor pushes no first turn, so agent_started may never arrive at all,
// and the app (connectAndLoad fetches agent.list exactly once at bootstrap) would otherwise
// never materialize this row until the next reconnect. Mirrors agent_started's own
// conductor/membership projection above, plus stamps projectId (which agent_started itself
// never carries — that only ever arrived via the agent.list snapshot merge).
describe("reducer: status{registered:true} materializes a fresh conductor row (PROJECT-CONDUCTOR-VISIBILITY)", () => {
  it("projects a custom display label on the registration event before backend output begins", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a", kind: "status",
        data: { state: "running", registered: true, conductor: true, displayLabel: "release captain" },
      },
    });
    expect(st.agents["a"]!.displayLabel).toBe("release captain");
  });

  it("sets state:running, conductor:true, and projectId from a single registration event", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a", kind: "status",
        data: { state: "running", registered: true, conductor: true, projectId: "my-project" },
      },
    });
    expect(st.agents["a"]!.state).toBe("running");
    expect(st.agents["a"]!.conductor).toBe(true);
    expect(st.agents["a"]!.projectId).toBe("my-project");
    expect(st.agentOrder).toContain("a");   // AgentList materializes the row immediately
  });

  it("a plain (non-conductor) registration event sets state:running without conductor/projectId", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "status", data: { state: "running", registered: true } },
    });
    expect(st.agents["a"]!.state).toBe("running");
    expect(st.agents["a"]!.conductor).toBe(false);
    expect(st.agents["a"]!.projectId).toBeUndefined();
  });

  it("conductor:true is IGNORED when the same registration event also carries team membership (D12 session-liveness parity)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: {
        ts: 1, seq: 1, agentId: "a", kind: "status",
        data: { state: "running", registered: true, conductor: true, membership: { team: "team-chimera", role: "xp-glm" } },
      },
    });
    expect(st.agents["a"]!.conductor).toBe(false);
    expect(st.agents["a"]!.membership).toEqual({ team: "team-chimera", role: "xp-glm" });
  });

  it("a later real agent_started (conductor:true) is unaffected by the earlier registration event", () => {
    const registered = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "status", data: { state: "running", registered: true, conductor: true, projectId: "my-project" } },
    });
    const st = reduce(registered, {
      type: "event",
      event: { ts: 2, seq: 2, agentId: "a", kind: "agent_started", data: { sessionId: "s1", conductor: true } },
    });
    expect(st.agents["a"]!.conductor).toBe(true);
    expect(st.agents["a"]!.projectId).toBe("my-project");   // untouched by agent_started, which never carries it
    expect(st.agents["a"]!.sessionId).toBe("s1");
  });

  it("an ordinary status event with no `registered` field never sets state/conductor/projectId (additive, doesn't leak into unrelated status folds)", () => {
    const st = reduce(initialState, {
      type: "event",
      event: { ts: 1, seq: 1, agentId: "a", kind: "status", data: { denied: true, toolName: "Bash" } },
    });
    expect(st.agents["a"]!.state).toBe("unknown");
    expect(st.agents["a"]!.conductor).toBe(false);
  });
});

describe("live rename status", () => {
  it("updates a registered name without a snapshot and preserves messages and activity", () => {
    let st = reduce(initialState, { type: "event", event: { seq: 1, ts: 1, agentId: "rename-agent", engineId: "local", kind: "agent_started", data: { displayLabel: "wily-lemur" } } });
    st = reduce(st, { type: "event", event: { seq: 2, ts: 2, agentId: "rename-agent", engineId: "local", kind: "text", data: { text: "Existing message" } } });
    const before = st.agents["rename-agent"]!;
    const next = reduce(st, { type: "event", event: { seq: 3, ts: 3, agentId: "rename-agent", engineId: "local", kind: "status", data: { state: "running", displayLabel: "  Grafana audit  " } } });
    expect(next.agents["rename-agent"]!.displayLabel).toBe("Grafana audit");
    expect(next.agents["rename-agent"]!.transcript).toEqual(before.transcript);
    expect(next.agents["rename-agent"]!.busy).toBe(before.busy);
    expect(before.displayLabel).toBe("wily-lemur");
    for (const label of ["", "  ", null, 42]) {
      const malformed = reduce(next, { type: "event", event: { seq: 4, ts: 4, agentId: "rename-agent", engineId: "local", kind: "status", data: { displayLabel: label } } });
      expect(malformed.agents["rename-agent"]!.displayLabel).toBe("Grafana audit");
    }
  });
});
