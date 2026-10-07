import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../src/index";

const origin = { from: "app", source: "operator" as const, engineId: "local" };
const messageMetadata = { ...origin, kind: "user_message" };

describe("authored message identity", () => {
  it("retains same-target same-ID messages from different origins through live, replay and paging", () => {
    const id = "same-id";
    const metadata = (from: string, source: "operator" | "agent" | "external", engineId: string) => ({ from, source, engineId, kind: "user_message" });
    const deliveries = [
      { from: "app", text: "operator body", messageMetadata: metadata("app", "operator", "local") },
      { from: "worker", text: "worker body", messageMetadata: metadata("worker", "agent", "local") },
      { from: "app", text: "external body", messageMetadata: metadata("app", "external", "local") },
      { from: "app", text: "remote body", messageMetadata: metadata("app", "operator", "remote") },
    ];
    const events = deliveries.map((data, index) => ({ agentId: "a", seq: index + 10, ts: index + 10, kind: "status" as const, data: { delivered: true, messageId: id, ...data } }));
    let live = reduce(initialState, { type: "userSent", agentId: "a", messageId: id, messageOrigin: origin, text: "operator body" });
    for (const event of events) live = reduce(live, { type: "event", event });
    expect(live.agents.a!.transcript.map(row => row.text)).toEqual(deliveries.map(row => row.text));
    const replay = reduce(initialState, { type: "backfillHistory", agentId: "a", events });
    expect(replay.agents.a!.transcript.map(row => row.text)).toEqual(deliveries.map(row => row.text));
    let paged = reduce(initialState, { type: "backfillHistory", agentId: "a", events: events.slice(1) });
    paged = reduce(paged, { type: "prependHistory", agentId: "a", events: events.slice(0, 1) });
    expect(paged.agents.a!.transcript.map(row => row.text)).toEqual(deliveries.map(row => row.text));
    for (const [index, event] of events.entries()) paged = reduce(paged, { type: "event", event: { ...event, seq: 20 + index } });
    expect(paged.agents.a!.transcript.map(row => row.text)).toEqual(deliveries.map(row => row.text));
    expect(paged.agents.a!.transcript[0]!.seq).toBe(10);
  });

  it("reconciles beyond the old echo window, uses authoritative content, and keeps the original position", () => {
    let state = reduce(initialState, { type: "userSent", agentId: "a", text: "trimmed", messageId: "first", messageOrigin: origin, forced: true });
    for (let seq = 1; seq <= 12; seq++) state = reduce(state, { type: "event", event: { agentId: "a", seq, ts: seq, kind: "message_complete", data: { text: `reply ${seq}` } } });
    state = reduce(state, { type: "event", stampTs: true, event: { agentId: "a", seq: 13, ts: 99, kind: "status", data: { delivered: true, messageMetadata, from: "app", messageId: "first", text: " authoritative ", content: [{ type: "text", text: " authoritative " }] } } });
    expect(state.agents.a!.transcript.filter(row => row.role === "user")).toHaveLength(1);
    expect(state.agents.a!.transcript[0]).toMatchObject({ messageId: "first", messageOrigin: origin, forced: true, text: " authoritative ", ts: 99 });
  });

  it("preserves legacy identical events and distinct-ID repeats, coalescing only the same authored ID", () => {
    let state = initialState;
    for (const [index, messageId] of [undefined, undefined, "one", "two", "one"].entries()) {
      state = reduce(state, { type: "event", event: { agentId: "a", seq: index + 1, ts: index + 1, kind: "status", data: { delivered: true, messageMetadata, from: "app", text: "same", ...(messageId ? { messageId } : {}) } } });
    }
    expect(state.agents.a!.transcript.filter(row => row.role === "user")).toHaveLength(4);
  });

  it("reconciles retry identity across history pages and reconnect overlap", () => {
    const event = (seq: number, messageId: string) => ({ agentId: "a", seq, ts: seq, kind: "status" as const, data: { delivered: true, messageMetadata, from: "app", text: "same", messageId } });
    let state = reduce(initialState, { type: "backfillHistory", agentId: "a", events: [event(10, "retry"), event(11, "intentional-repeat")] });
    state = reduce(state, { type: "prependHistory", agentId: "a", events: [event(1, "retry")] });
    state = reduce(state, { type: "event", event: event(12, "retry") });
    expect(state.agents.a!.transcript.filter(row => row.role === "user").map(row => row.messageId)).toEqual(["retry", "intentional-repeat"]);
    expect(state.agents.a!.transcript[0]!.seq).toBe(1);
  });

  it("scopes identity to the target and preserves old persisted image bodies without an ID", () => {
    const content = [{ type: "image", mediaType: "image/png", data: "YQ==" }, { type: "text", text: " legacy " }];
    let state = initialState;
    for (const [index, agentId] of ["a", "b"].entries()) {
      state = reduce(state, { type: "event", event: { agentId, seq: index + 1, ts: index + 1, kind: "status", data: { delivered: true, messageMetadata, from: "app", messageId: "same-authored-id", text: "same", content } } });
    }
    expect(state.agents.a!.transcript).toHaveLength(1);
    expect(state.agents.b!.transcript).toHaveLength(1);
    state = reduce(state, { type: "backfillHistory", agentId: "old", events: [{ agentId: "old", seq: 3, ts: 3, kind: "status", data: { delivered: true, messageMetadata, from: "app", text: " legacy ", content } }] });
    expect(state.agents.old!.transcript).toMatchObject([{ role: "user", content }]);
  });

  it("does not replace a known-origin echo with missing, invalid or contradictory origin metadata", () => {
    let state = reduce(initialState, { type: "userSent", agentId: "a", text: "original", messageId: "same", messageOrigin: origin });
    const bodies = [
      { from: "app", text: "missing" },
      { from: "app", text: "invalid", messageMetadata: { ...origin, source: "unknown" } },
      { from: "worker", text: "contradictory", messageMetadata },
      { from: "app", text: "acknowledged", messageMetadata },
    ];
    for (const [index, data] of bodies.entries()) state = reduce(state, { type: "event", event: { agentId: "a", seq: index + 1, ts: index + 1, kind: "status", data: { delivered: true, messageId: "same", ...data } } });
    expect(state.agents.a!.transcript.map(row => row.text)).toEqual(["acknowledged", "missing", "invalid", "contradictory"]);
  });
});
