import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

// F01-QA follow-up: a job fired late by the sleep-wake catch-up path spawns its agent AFTER
// clock_jump already fired, so the agent never gets that banner (see reducer-checkpoint-w22-style
// clock_jump coverage). This case stamps a first-turn system line onto the spawned agent instead,
// gated on trigger === "sleep-wake" (readopted runs are excluded — they're not late, they're a
// boot-time resume of an already-running job).

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });

const withAgent = (state: UiState, agentId: string): UiState =>
  reduce(state, { type: "event", event: ev(agentId, "agent_started", { model: "m1" }) });

describe("reducer: job_run_started sleep-wake transcript stamp (F01-QA follow-up)", () => {
  it("stamps a late-run banner into the spawned agent's transcript", () => {
    let st = withAgent(initialState, "a1");
    st = reduce(st, {
      type: "event",
      event: ev("job:nightly", "job_run_started", {
        job: "nightly", jobName: "nightly", runId: "job:nightly:123", agentId: "a1",
        trigger: "sleep-wake", latenessMs: 33_180_000, coalescedOccurrences: 9,
        nominalFireTs: 1000, idempotencyKey: "job:nightly:123",
      }),
    });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({
      role: "system",
      text: "nightly ran late by 9h 13m (machine was asleep) · 9 occurrences coalesced",
    });
    expect(st.events.at(-1)!.kind).toBe("job_run_started");
  });

  it("a non-sleep-wake trigger never touches the agent transcript", () => {
    let st = withAgent(initialState, "a1");
    st = reduce(st, {
      type: "event",
      event: ev("job:nightly", "job_run_started", {
        job: "nightly", jobName: "nightly", runId: "job:nightly:124", agentId: "a1",
        trigger: "scheduled", nominalFireTs: 1000, idempotencyKey: "job:nightly:124",
      }),
    });
    expect(st.agents["a1"]!.transcript).toEqual([]);
  });

  it("a readopted sleep-wake-adjacent run (no agentId match) leaves every projection untouched", () => {
    const st = reduce(initialState, {
      type: "event",
      event: ev("job:nightly", "job_run_started", {
        job: "nightly", jobName: "nightly", runId: "job:nightly:125",
        trigger: "sleep-wake", nominalFireTs: 1000, idempotencyKey: "job:nightly:125", readopted: true,
      }),
    });
    expect(st.agents).toEqual({});
  });

  it("readopted takes precedence over lateness wording even when agentId is bound", () => {
    let st = withAgent(initialState, "a1");
    st = reduce(st, {
      type: "event",
      event: ev("job:nightly", "job_run_started", {
        job: "nightly", jobName: "nightly", runId: "job:nightly:126", agentId: "a1",
        trigger: "sleep-wake", nominalFireTs: 1000, idempotencyKey: "job:nightly:126", readopted: true,
      }),
    });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({
      role: "system",
      text: "nightly: re-adopted a run that was still in flight when the daemon restarted",
    });
  });

  it("stampTs (opt-in) stamps the banner's ts, mirroring W22/clock_jump", () => {
    let st = withAgent(initialState, "a1");
    const e = ev("job:nightly", "job_run_started", {
      job: "nightly", jobName: "nightly", runId: "job:nightly:127", agentId: "a1",
      trigger: "sleep-wake", latenessMs: 45_000, nominalFireTs: 1000, idempotencyKey: "job:nightly:127",
    });
    st = reduce(st, { type: "event", event: e, stampTs: true });
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({ ts: e.ts });
  });
});
