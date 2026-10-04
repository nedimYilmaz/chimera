import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, type NormalizedEvent } from "@chimera/ui-state";

// AGENT-IDENTITY-INVISIBLE-IN-APP: account / provider / permissionProfile / permissionRequest were
// SNAPSHOT-ONLY fields — reachable solely through the agent.list -> `agentRecords` fold, which the
// desktop app never dispatches (it is event-sourced; `agentRecords` appears in packages/app in
// TESTS ONLY). Production symptom: a project conductor showed no `account:` chip — and because that
// chip IS the click-to-switch affordance (TranscriptHeader gates it on `account ? … : null`), no way
// to change accounts either — plus no `full·auto` permission chip, so an agent that WAS in auto mode
// read as if it had lost it. Every test here drives the LIVE EVENT PATH ONLY, with no agentRecords
// seed, because that is exactly the situation the app is always in.
let SEQ = 0;
function ev(over: Partial<NormalizedEvent> & { agentId: string; kind: NormalizedEvent["kind"] }): { type: "event"; event: NormalizedEvent } {
  return { type: "event", event: { ts: SEQ, seq: (SEQ += 1), data: {}, ...over } as NormalizedEvent };
}

describe("agent identity reaches an event-only client", () => {
  it("does not revive a killed agent on a late pause event", () => {
    let s = reduce(initialState, ev({ agentId: "dead", kind: "status", data: { state: "killed" } }));
    s = reduce(s, ev({ agentId: "dead", kind: "status", data: { state: "paused", paused: true, reason: "idle-timeout" } }));
    expect(s.agents.dead?.state).toBe("killed");
  });
  it("shows explicit context-transfer fallback and target identity", () => {
    const s = reduce(initialState, ev({ agentId: "switch", kind: "status", data: { providerSwitch: "completed", provider: "codex", accountName: "cx-main", model: "gpt-6-astra", contextTransfer: { mode: "history-fallback", reason: "source quota exhausted", archive: "/tmp/context.md" } } }));
    expect(s.agents.switch).toMatchObject({ provider: "codex", account: "cx-main" });
    expect(s.agents.switch?.transcript.at(-1)?.text).toContain("History fallback");
    expect(s.agents.switch?.transcript.at(-1)?.text).toContain("source quota exhausted");
  });
  it("an idle project conductor — whose ONLY event is the registration marker — still carries account + permission", () => {
    // The exact production shape: a resumeOnly project conductor pushes no first turn, so the
    // backend never emits agent_started. This one event is all the app will ever see.
    const s = reduce(
      initialState,
      ev({
        agentId: "c1", kind: "status",
        data: {
          state: "running", registered: true, conductor: true, projectId: "onur-buse-wedding",
          accountName: "claude-pers", provider: "claude",
          permissionProfile: "full", permissionRequest: "auto",
          treeId: "c1", depth: 0,
        },
      }),
    );
    expect(s.agents["c1"]).toMatchObject({
      account: "claude-pers", provider: "claude", permissionProfile: "full", permissionRequest: "auto",
    });
  });

  it("an agent that does open a turn learns the same four fields from agent_started", () => {
    const s = reduce(
      initialState,
      ev({
        agentId: "a1", kind: "agent_started",
        data: {
          model: "claude-opus-5", accountName: "codex", provider: "codex",
          permissionProfile: "acceptEdits", permissionRequest: "tui", treeId: "a1", depth: 0,
        },
      }),
    );
    expect(s.agents["a1"]).toMatchObject({
      account: "codex", provider: "codex", permissionProfile: "acceptEdits",
      permissionRequest: "tui", model: "claude-opus-5",
    });
  });

  it("the permission chip SURVIVES an account switch — the respawn's events re-stamp it", () => {
    // agent.setAccount kills and respawns with { ...spec, account }, so the live permission values
    // ride along; the `failover` event only ever patched account/provider, which is why the chip
    // used to vanish on switch and look like auto mode had been lost.
    let s = reduce(initialState, ev({
      agentId: "c1", kind: "status",
      data: { state: "running", registered: true, accountName: "claude-pers", provider: "claude", permissionProfile: "full", permissionRequest: "auto" },
    }));
    s = reduce(s, ev({ agentId: "c1", kind: "failover", data: { from: "claude-pers", to: "claude", provider: "claude", reason: "manual account switch" } }));
    expect(s.agents["c1"]).toMatchObject({ account: "claude", permissionRequest: "auto" });

    s = reduce(s, ev({
      agentId: "c1", kind: "status",
      data: { state: "running", registered: true, accountName: "claude", provider: "claude", permissionProfile: "full", permissionRequest: "auto" },
    }));
    expect(s.agents["c1"]).toMatchObject({ account: "claude", permissionProfile: "full", permissionRequest: "auto" });
  });

  it("a live setPermission still wins over the spawn-time stamp (no ordering regression)", () => {
    let s = reduce(initialState, ev({
      agentId: "a1", kind: "agent_started",
      data: { accountName: "claude", provider: "claude", permissionProfile: "full", permissionRequest: "auto" },
    }));
    s = reduce(s, ev({
      agentId: "a1", kind: "status",
      data: { permissionChanged: true, appliedToRunningProcess: true, permissionProfile: "readOnly", permissionRequest: "tui" },
    }));
    expect(s.agents["a1"]).toMatchObject({ permissionProfile: "readOnly", permissionRequest: "tui" });
  });

  it("an OLDER daemon that omits the fields changes nothing (additive, authoritative-when-present)", () => {
    let s = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "kimi", provider: "kimi", costUsd: 0, createdAt: 1, spec: { permissionProfile: "full" } }],
    });
    expect(s.agents["a1"]).toMatchObject({ account: "kimi", provider: "kimi" });
    // a pre-stamp daemon's registration marker carries none of the four
    s = reduce(s, ev({ agentId: "a1", kind: "status", data: { state: "running", registered: true, treeId: "a1", depth: 0 } }));
    expect(s.agents["a1"]).toMatchObject({ account: "kimi", provider: "kimi" });
  });
});
