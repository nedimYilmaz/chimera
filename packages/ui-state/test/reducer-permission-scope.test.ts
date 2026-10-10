import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { initialState, reduce, type AgentRecordLite } from "@chimera/ui-state";

// CONDUCTOR-FULL-ACCESS Part B: AgentView.permissionProfile / permissionRequest — the agent's
// live permission scope, surfaced so the TUI/app can SHOW it and let the user CHANGE it. Two
// sources, authoritative-when-present (mirroring gitBranch/effectiveContextLimit): the agent.list
// snapshot (from spec.permissionProfile / spec.on.permissionRequest) AND the live
// `permissionChanged` status event AgentSupervisor.setPermission emits.

const rec = (over: Partial<AgentRecordLite> & { agentId: string }): AgentRecordLite =>
  ({ state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, ...over });

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });

describe("AgentView permission scope — agent.list snapshot fold", () => {
  it("projects a record's spec.permissionProfile + spec.on.permissionRequest onto the view", () => {
    const st = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", spec: { conductor: true, permissionProfile: "full", on: { permissionRequest: "auto" } } })],
    });
    expect(st.agents["a1"]!.permissionProfile).toBe("full");
    expect(st.agents["a1"]!.permissionRequest).toBe("auto");
  });

  it("a later snapshot WITHOUT the spec (older daemon summary path) keeps the prior value", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", spec: { permissionProfile: "full", on: { permissionRequest: "auto" } } })],
    });
    const st = reduce(first, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.permissionProfile).toBe("full");
    expect(st.agents["a1"]!.permissionRequest).toBe("auto");
  });

  it("a snapshot carrying a DIFFERENT profile overwrites (authoritative-when-present)", () => {
    const first = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", spec: { permissionProfile: "full", on: { permissionRequest: "auto" } } })],
    });
    const st = reduce(first, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", spec: { permissionProfile: "readOnly", on: { permissionRequest: "tui" } } })],
    });
    expect(st.agents["a1"]!.permissionProfile).toBe("readOnly");
    expect(st.agents["a1"]!.permissionRequest).toBe("tui");
  });

  it("absent on a fresh agent when no snapshot has ever carried a spec", () => {
    const st = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1" })] });
    expect(st.agents["a1"]!.permissionProfile).toBeUndefined();
    expect(st.agents["a1"]!.permissionRequest).toBeUndefined();
  });
});

describe("AgentView permission scope — live permissionChanged event fold", () => {
  it("folds a live agent.setPermission (both fields patched) with no snapshot wait", () => {
    const seeded = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", spec: { permissionProfile: "acceptEdits", on: { permissionRequest: "tui" } } })],
    });
    const st = reduce(seeded, {
      type: "event",
      event: ev("a1", "status", { permissionChanged: true, permissionProfile: "full", permissionRequest: "auto" }),
    });
    expect(st.agents["a1"]!.permissionProfile).toBe("full");
    expect(st.agents["a1"]!.permissionRequest).toBe("auto");
  });

  it("a partial patch (profile only) leaves the other field untouched", () => {
    const seeded = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", spec: { permissionProfile: "acceptEdits", on: { permissionRequest: "tui" } } })],
    });
    const st = reduce(seeded, {
      type: "event",
      event: ev("a1", "status", { permissionChanged: true, permissionProfile: "readOnly" }),
    });
    expect(st.agents["a1"]!.permissionProfile).toBe("readOnly");
    expect(st.agents["a1"]!.permissionRequest).toBe("tui");
  });

  it("a status event WITHOUT permissionChanged never touches the scope fields", () => {
    const seeded = reduce(initialState, {
      type: "agentRecords",
      records: [rec({ agentId: "a1", spec: { permissionProfile: "full", on: { permissionRequest: "auto" } } })],
    });
    const st = reduce(seeded, { type: "event", event: ev("a1", "status", { remoteControl: { enabled: true } }) });
    expect(st.agents["a1"]!.permissionProfile).toBe("full");
    expect(st.agents["a1"]!.permissionRequest).toBe("auto");
  });
});


describe("acknowledged permission application replay", () => {
  const application = { version: 2, requestedProfile: "readOnly", effectiveProfile: "full", profileStatus: "pending", requestedRouting: "tui", routingStatus: "bypassed", transport: "app-server", nativeApprovals: true } as const;
  it("keeps desired/effective distinct and rejects old acknowledgments and snapshots", () => {
    let st = reduce(initialState, { type: "event", event: ev("a1", "status", { permissionChanged: true, permissionProfile: "readOnly", permissionRequest: "tui", permissionApplication: application, appliedToRunningProcess: false }) });
    st = reduce(st, { type: "event", event: ev("a1", "status", { permissionChanged: true, permissionProfile: "full", permissionRequest: "auto", permissionApplication: { ...application, version: 1, requestedProfile: "full", requestedRouting: "auto", effectiveProfile: "full", profileStatus: "applied" }, appliedToRunningProcess: true }) });
    st = reduce(st, { type: "agentRecords", records: [rec({ agentId: "a1", spec: { permissionProfile: "full", on: { permissionRequest: "auto" } }, permissionApplication: { ...application, version: 1, requestedProfile: "full", requestedRouting: "auto", effectiveProfile: "full", profileStatus: "applied" } })] });
    expect(st.agents.a1.permissionApplication).toEqual(application);
    expect(st.agents.a1.permissionProfile).toBe("readOnly");
    expect(st.agents.a1.permissionRequest).toBe("tui");
    expect(st.agents.a1.permissionAppliedToRunningProcess).toBe(false);
    st = reduce(st, { type: "event", event: ev("a1", "status", { permissionApplication: { ...application, effectiveProfile: "readOnly", profileStatus: "applied", routingStatus: "applied" }, appliedToRunningProcess: true }) });
    expect(st.agents.a1.permissionAppliedToRunningProcess).toBe(true);
    expect(st.agents.a1.permissionApplication?.effectiveProfile).toBe("readOnly");
  });
  it("agent_started alone cannot erase failure; a validated new-launch acknowledgment can", () => {
    let st = reduce(initialState, { type: "event", event: ev("a1", "status", { permissionApplication: { ...application, profileStatus: "failed", error: "rejected" }, appliedToRunningProcess: false }) });
    st = reduce(st, { type: "event", event: ev("a1", "agent_started", { permissionProfile: "readOnly" }) });
    expect(st.agents.a1.permissionApplication?.profileStatus).toBe("failed");
    st = reduce(st, { type: "event", event: ev("a1", "status", { permissionApplication: { ...application, version: 3, effectiveProfile: "readOnly", profileStatus: "applied", routingStatus: "applied" }, appliedToRunningProcess: true }) });
    expect(st.agents.a1.permissionAppliedToRunningProcess).toBe(true);
  });
});

it("stopped and new-launch generations clear prior effective and submitted state", () => {
  const old = { version: 1, requestedProfile: "full", effectiveProfile: "full", profileStatus: "applied", requestedRouting: "auto", routingStatus: "bypassed", transport: "exec", nativeApprovals: false } as const;
  const pending = { version: 2, requestedProfile: "readOnly", profileStatus: "pending", requestedRouting: "tui", routingStatus: "unsupported", transport: "exec", nativeApprovals: false } as const;
  let st = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", state: "done", spec: { permissionProfile: "full", on: { permissionRequest: "auto" } }, permissionApplication: old })] });
  st = reduce(st, { type: "event", event: ev("a1", "status", { permissionChanged: true, permissionProfile: "readOnly", permissionRequest: "tui", permissionApplication: pending, appliedToRunningProcess: false }) });
  expect(st.agents.a1.permissionApplication).toEqual(pending);
  st = reduce(st, { type: "event", event: ev("a1", "status", { permissionApplication: { ...pending, profileStatus: "unverified", submittedProfile: "readOnly", submittedVersion: 2 } }) });
  st = reduce(st, { type: "event", event: ev("a1", "status", { permissionApplication: { ...pending, version: 3 } }) });
  expect(st.agents.a1.permissionApplication).toEqual({ ...pending, version: 3 });
  expect(st.agents.a1.permissionAppliedToRunningProcess).toBe(false);
});

it("projects observed planning mode from events and snapshots without changing permissions", () => {
  let st = reduce(initialState, { type: "agentRecords", records: [rec({ agentId: "a1", executionMode: "plan", spec: { permissionProfile: "full" } })] });
  expect(st.agents.a1.executionMode).toBe("plan");
  st = reduce(st, { type: "event", event: ev("a1", "status", { executionMode: "execute" }) });
  expect(st.agents.a1.executionMode).toBe("execute"); expect(st.agents.a1.permissionProfile).toBe("full");
  st = reduce(st, { type: "event", event: ev("a1", "status", { executionMode: "auto" }) });
  expect(st.agents.a1.executionMode).toBe("auto"); expect(st.agents.a1.permissionProfile).toBe("full");
  st = reduce(st, { type: "event", event: ev("a1", "status", { executionMode: null, requestedExecutionMode: "plan" }) });
  expect(st.agents.a1.executionMode).toBeUndefined();
});
