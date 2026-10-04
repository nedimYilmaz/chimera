import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}): NormalizedEvent =>
  ({ ts: 1000 + ++seq, seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

// QUEUE-PAUSE: fold queue_paused/queue_resumed into the master queues list + the open
// queueDetail drill (mirrors task_state_changed's own "keep the loaded snapshot current" fold).
describe("reducer: QUEUE-PAUSE event fold", () => {
  const withQueues = (): UiState => ({
    ...initialState,
    queues: { available: true, items: [{ name: "work", retryLimit: 2, workflow: null, paused: false }, { name: "other", retryLimit: 1, workflow: null, paused: false }] },
  });

  it("queue_paused flips the matching master-list item's paused flag, leaves others untouched", () => {
    const st = feed(withQueues(), [ev("queue:work", "queue_paused", { queue: "work" })]);
    expect(st.queues.items.find((q) => q["name"] === "work")).toMatchObject({ paused: true });
    expect(st.queues.items.find((q) => q["name"] === "other")).toMatchObject({ paused: false });
  });

  it("queue_resumed flips it back", () => {
    const paused = feed(withQueues(), [ev("queue:work", "queue_paused", { queue: "work" })]);
    const resumed = feed(paused, [ev("queue:work", "queue_resumed", { queue: "work" })]);
    expect(resumed.queues.items.find((q) => q["name"] === "work")).toMatchObject({ paused: false });
  });

  it("also updates the open queueDetail.spec when its drill matches the paused queue", () => {
    const base: UiState = {
      ...withQueues(),
      queueDetail: {
        spec: { name: "work", retryLimit: 2, workflow: null, paused: false },
        counts: { pending: 1, in_progress: 0, done: 0, failed: 0, blocked: 0, dead_letter: 0 },
        tasks: [],
      },
    };
    const st = feed(base, [ev("queue:work", "queue_paused", { queue: "work" })]);
    expect(st.queueDetail!.spec["paused"]).toBe(true);
  });

  it("leaves a queueDetail open on a DIFFERENT queue untouched", () => {
    const base: UiState = {
      ...withQueues(),
      queueDetail: {
        spec: { name: "other", retryLimit: 1, workflow: null, paused: false },
        counts: { pending: 0, in_progress: 0, done: 0, failed: 0, blocked: 0, dead_letter: 0 },
        tasks: [],
      },
    };
    const st = feed(base, [ev("queue:work", "queue_paused", { queue: "work" })]);
    expect(st.queueDetail!.spec["paused"]).toBe(false);
  });

  it("a queue_paused for an unknown queue name is a no-op on the items list", () => {
    const st = feed(withQueues(), [ev("queue:ghost", "queue_paused", { queue: "ghost" })]);
    expect(st.queues.items).toEqual(withQueues().queues.items);
  });
});
