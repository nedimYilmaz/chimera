import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import {
  CAPACITY_HELP, capacityLabel, capacityTone, evictionCandidateLabel, initialState,
  memoryEventLine, nextOutLabels, nextOutSummary, pinnedSummary, reduce,
  type MemoryCapacityView,
} from "@chimera/ui-state";

const cap = (over: Partial<MemoryCapacityView> = {}): MemoryCapacityView => ({
  limit: 2000, total: 1586, fill: 0.793, alarmAt: 0.9, alarming: false, pinned: 3,
  nextToEvict: [
    { id: "aaaaaaaabbbb", title: null, kind: "fact", value: 0, inbound: 0, pinned: false },
    { id: "c2", title: "an old note", kind: "fact", value: 1, inbound: 1, pinned: false },
  ],
  ...over,
});

// F36.UI (QA F36 "UI gaps"): eviction is otherwise INVISIBLE — a note leaves and no
// surface ever said it would. These helpers are the single vocabulary both UIs render.
describe("F36.UI capacity helpers", () => {
  it("capacityLabel is the exact chip text F36.2 shipped (AC 14)", () => {
    expect(capacityLabel(cap())).toBe("1586/2000 · 79% full");
  });

  it("capacityTone follows the DAEMON's alarm flag, never a second client threshold", () => {
    expect(capacityTone(cap({ fill: 0.99 }))).toBe("ok");            // daemon says not alarming → not alarming
    expect(capacityTone(cap({ alarming: true }))).toBe("alarm");
  });

  it("evictionCandidateLabel falls back to a short id for an untitled note", () => {
    expect(evictionCandidateLabel({ title: null, id: "aaaaaaaabbbb" })).toBe("aaaaaaaa");
    expect(evictionCandidateLabel({ title: "keep me", id: "x" })).toBe("keep me");
  });

  it("nextOut* says the day-one state in words instead of showing an empty box", () => {
    expect(nextOutLabels(cap())).toEqual(["aaaaaaaa", "an old note"]);
    expect(nextOutSummary(cap())).toBe("next out: aaaaaaaa · an old note");
    expect(nextOutSummary(cap({ nextToEvict: [] }))).toBe("nothing to drop yet");
    expect(nextOutSummary(null)).toBe("nothing to drop yet");        // stats not loaded yet
    expect(nextOutLabels(cap({ nextToEvict: [] }))).toEqual([]);
  });

  it("pinnedSummary pluralises the pin budget", () => {
    expect(pinnedSummary(cap({ pinned: 1 }))).toBe("1 pinned");
    expect(pinnedSummary(cap({ pinned: 0 }))).toBe("0 pinned");
    expect(pinnedSummary(null)).toBe("0 pinned");
  });

  it("CAPACITY_HELP explains eviction without assuming code knowledge", () => {
    expect(CAPACITY_HELP).toMatch(/archived/);
    expect(CAPACITY_HELP).toMatch(/Pin a note/);
  });
});

describe("F36.UI memoryEventLine", () => {
  it("humanises the pressure alarm, naming what goes first", () => {
    expect(memoryEventLine("memory_pressure", {
      total: 1801, limit: 2000, fill: 0.9005, threshold: 0.9,
      nextToEvict: { id: "abcdefgh1234", title: null, value: 0 },
    })).toBe("shared memory 90% full (1801/2000) — next out: abcdefgh");
    expect(memoryEventLine("memory_pressure", { total: 1801, limit: 2000, fill: 0.9, nextToEvict: null }))
      .toBe("shared memory 90% full (1801/2000) — notes will start being dropped");
  });

  it("distinguishes the per-record eviction from the TRUNCATION summary", () => {
    // The summary carries {truncated,total} and NO title — the per-record branch would
    // render it as the eviction of a nameless note.
    expect(memoryEventLine("memory_evicted", { truncated: 12, total: 62 }))
      .toBe("dropped 62 notes to free space (12 not listed individually)");
    expect(memoryEventLine("memory_evicted", { id: "zz99aa11", title: "stale plan", kind: "fact" }))
      .toBe('dropped fact note "stale plan" — archived, not lost');
  });

  // F36.FIX: "archived, not lost" used to be asserted from the CONTRACT, not the event — so a
  // failed archive write still read as reassuring. The daemon now says which happened.
  it("reads `archived` off the event instead of promising from the contract", () => {
    expect(memoryEventLine("memory_evicted", { id: "zz99aa11", title: "stale plan", kind: "fact", archived: true }))
      .toBe('dropped fact note "stale plan" — archived, not lost');
    expect(memoryEventLine("memory_evicted", { id: "zz99aa11", title: "stale plan", kind: "fact", archived: false }))
      .toBe('dropped fact note "stale plan" — ARCHIVE WRITE FAILED, this note is gone');
    // Events written before the field existed keep the old wording, not a scarier one.
    expect(memoryEventLine("memory_evicted", { id: "zz99aa11", title: "stale plan", kind: "fact" }))
      .toBe('dropped fact note "stale plan" — archived, not lost');
    expect(memoryEventLine("memory_evicted", { truncated: 12, total: 62, archived: false }))
      .toBe("dropped 62 notes to free space (12 not listed individually) — ARCHIVE WRITE FAILED, these notes are gone");
  });

  it("returns null for unrelated kinds so callers keep their generic summary", () => {
    expect(memoryEventLine("tool_call", { name: "x" })).toBeNull();
  });
});

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });

describe("F36.UI reducer", () => {
  it("memory system events never materialise a phantom 'memory' agent", () => {
    const st = [
      ev("memory", "memory_pressure", { total: 1801, limit: 2000, fill: 0.9 }),
      ev("memory", "memory_evicted", { truncated: 12, total: 62 }),
      ev("memory:abc", "memory_evicted", { id: "abc", title: "gone" }),
    ].reduce((s, e) => reduce(s, { type: "event", event: e }), initialState);
    expect(Object.keys(st.agents)).toEqual([]);
    expect(st.events.map((e) => e.kind)).toEqual(["memory_pressure", "memory_evicted", "memory_evicted"]);
  });

  it("memoryStats carries the capacity block through", () => {
    const st = reduce(initialState, { type: "memoryStats", stats: { total: 1586, capacity: cap() } });
    expect(st.memoryStats?.capacity?.limit).toBe(2000);
  });
});
