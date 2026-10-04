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
