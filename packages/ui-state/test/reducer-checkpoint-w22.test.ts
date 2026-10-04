import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// F20 (W22, D16 checkpoints) — checkpoint_created carries a synthetic
// `checkpoint:<id>` agentId (id rule (a): never a real agent), so by default
// it only rides the global events ring. The REAL bound agent id rides
// directly on data.agentId (CheckpointStore.create always resolves it via
// scheduler.taskFor at create time) — unlike W18's task-step case, no
// queueDetail lookup is needed to find it. When that agent is known, the
// reducer drops a dim ⚑ system banner into ITS transcript.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });

const withAgent = (state: UiState, agentId: string): UiState =>
  reduce(state, { type: "event", event: ev(agentId, "agent_started", { model: "m1" }) });

describe("reducer: checkpoint_created (F20/W22)", () => {
  it("with no matching agent in data.agentId, only rides the events ring", () => {
    const st = reduce(initialState, {
      type: "event",
      event: ev("checkpoint:1", "checkpoint_created", { id: "1", ref: "refs/chimera/checkpoints/1", trigger: "manual", agentId: null, taskId: null, cwd: "/repo" }),
    });
    expect(st.events).toHaveLength(1);
    expect(st.agents).toEqual({});
  });

  it("drops a dim ⚑ banner into the bound agent's transcript for a manual checkpoint", () => {
    let st = withAgent(initialState, "a1");
    st = reduce(st, {
      type: "event",
      event: ev("checkpoint:3", "checkpoint_created", { id: "3", ref: "refs/chimera/checkpoints/3", trigger: "manual", agentId: "a1", taskId: null, cwd: "/repo" }),
    });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "⚑ checkpoint cp-3 · manual (ctrl+s)" });
    // the raw event still rides the global ring (strip/card reconcile trigger)
    expect(st.events.at(-1)!.kind).toBe("checkpoint_created");
  });

  it("labels a task_start trigger and a destructive_bash trigger distinctly", () => {
    let st = withAgent(initialState, "a1");
    st = reduce(st, {
      type: "event",
      event: ev("checkpoint:1", "checkpoint_created", { id: "1", trigger: "task_start", agentId: "a1" }),
    });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "⚑ checkpoint cp-1 · task start" });
    st = reduce(st, {
      type: "event",
      event: ev("checkpoint:2", "checkpoint_created", { id: "2", trigger: "destructive_bash", agentId: "a1" }),
    });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "⚑ checkpoint cp-2 · before a destructive command" });
  });

  it("a data.agentId with no matching agent in state leaves every projection untouched", () => {
    const st = reduce(initialState, {
      type: "event",
      event: ev("checkpoint:1", "checkpoint_created", { id: "1", trigger: "manual", agentId: "ghost" }),
    });
    expect(st.agents).toEqual({});
  });

  it("checkpoint_reverted carries no agentId — never touches the agent map", () => {
    let st = withAgent(initialState, "a1");
    st = reduce(st, {
      type: "event",
      event: ev("checkpoint:1", "checkpoint_reverted", { id: "1", ref: "refs/chimera/checkpoints/1", cwd: "/repo" }),
    });
    expect(st.agents["a1"]!.transcript).toMatchObject([]);
  });

  it("stampTs (opt-in) stamps the banner's ts, mirroring result/error/failover/W18", () => {
    let st = withAgent(initialState, "a1");
    const e = ev("checkpoint:1", "checkpoint_created", { id: "1", trigger: "manual", agentId: "a1" });
    st = reduce(st, { type: "event", event: e, stampTs: true });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ role: "system", text: "⚑ checkpoint cp-1 · manual (ctrl+s)", ts: e.ts });
  });
});
