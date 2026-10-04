import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import { fmtStallAge, promptStallBadge, promptStallDetail, reduce } from "@chimera/ui-state";
import { initialState, type UiState } from "@chimera/ui-state";

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, s?: number): NormalizedEvent =>
  ({ ts: 1000 + (s ?? ++seq), seq: s ?? seq, agentId, kind, data });
const feed = (state: UiState, events: NormalizedEvent[]) =>
  events.reduce((st, e) => reduce(st, { type: "event", event: e }), state);

describe("reducer: F09 prompt-stall fold", () => {
  it("folds agent_prompt_stalled into promptStall + one system transcript row", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "agent_prompt_stalled", { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 }),
    ]);
    const agent = st.agents["a1"]!;
    expect(agent.promptStall).toMatchObject({ deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 });
    expect(agent.transcript).toMatchObject([
      { role: "system", text: "prompt start unconfirmed: delivered from conductor 45s ago, no turn-start confirmation yet" },
    ]);
  });

  it("promptStallCleared clears it AND records the pickup in the transcript", () => {
    // F09.UI: the clear used to only null the field — the badge vanished with nothing recorded,
    // so an operator who looked away could not tell a resolved stall from an imagined one.
    const st = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "agent_prompt_stalled", { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 }),
      ev("a1", "status", { promptStallCleared: true, deliveryId: "d1", ackMs: 100000 }),
    ]);
    expect(st.agents["a1"]!.promptStall).toBeNull();
    expect(st.agents["a1"]!.transcript.at(-1)).toMatchObject({
      role: "system",
      text: "prompt picked up: the agent started a turn 1m after the message from conductor was delivered",
    });
  });

  it("clearing a partial (fresh-client) stall with no ackMs quotes no duration at all", () => {
    // sinceTs is 0 on a snapshot-only stall, so the wall-clock fallback would print an
    // epoch-sized "480000h" — the line has to survive without a duration instead.
    const seeded = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, promptStalled: true }],
    } as never);
    const st = feed(seeded, [ev("a1", "status", { promptStallCleared: true })]);
    const line = String((st.agents["a1"]!.transcript.at(-1) as { text?: string } | undefined)?.text ?? "");
    expect(line).toContain("prompt picked up");
    expect(line).not.toMatch(/\d/);
  });

  it("a duplicate/replayed clear never prints a phantom pickup line", () => {
    const once = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "agent_prompt_stalled", { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 }),
      ev("a1", "status", { promptStallCleared: true, deliveryId: "d1", ackMs: 100 }),
    ]);
    const twice = feed(once, [ev("a1", "status", { promptStallCleared: true, deliveryId: "d1", ackMs: 100 })]);
    expect(twice.agents["a1"]!.transcript.length).toBe(once.agents["a1"]!.transcript.length);
  });

  it("captures the delivered prompt text so the cockpits can offer a one-key resend", () => {
    const st = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "status", { delivered: true, from: "conductor", text: "review the diff" }),
      ev("a1", "agent_prompt_stalled", { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 }),
    ]);
    expect(st.agents["a1"]!.promptStall?.text).toBe("review the diff");
  });

  it("a FRESH client with only the boolean snapshot still warns, without inventing a duration", () => {
    const snap = reduce(initialState, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, promptStalled: true }],
    });
    expect(snap.agents["a1"]!.promptStall).toMatchObject({ partial: true });
    expect(promptStallBadge(snap.agents["a1"]!.promptStall!, 9_999_999)).toBe("⚠ start unconfirmed");
  });

  it("an agentRecords snapshot does not resurrect a cleared stall", () => {
    const stalled = feed(initialState, [
      ev("a1", "agent_started", { model: "m1" }),
      ev("a1", "agent_prompt_stalled", { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 }),
      ev("a1", "status", { promptStallCleared: true, deliveryId: "d1", ackMs: 100 }),
    ]);
    expect(stalled.agents["a1"]!.promptStall).toBeNull();

    const snapshotted = reduce(stalled, {
      type: "agentRecords",
      records: [{ agentId: "a1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, promptStalled: false }],
    });
    expect(snapshotted.agents["a1"]!.promptStall).toBeNull();
  });
});

describe("promptStall vocabulary (shared by app + tui)", () => {
  it("fmtStallAge stays coarse past a minute — the 45s detection threshold has no second-precision", () => {
    expect(fmtStallAge(0)).toBe("0s");
    expect(fmtStallAge(45_000)).toBe("45s");
    expect(fmtStallAge(4 * 60_000 + 13_000)).toBe("4m");
    expect(fmtStallAge(65 * 60_000)).toBe("1h 5m");
    expect(fmtStallAge(120 * 60_000)).toBe("2h");
  });

  it("the badge ticks off sinceTs, never the frozen sinceMs snapshot (QA U1)", () => {
    const stall = { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 };
    expect(promptStallBadge(stall, 1000 + 45_000)).toBe("⚠ start unconfirmed 45s");
    expect(promptStallBadge(stall, 1000 + 4 * 60_000)).toBe("⚠ start unconfirmed 4m");
  });

  it("the detail names the SENDER — the disambiguator the TUI badge had dropped (QA U2)", () => {
    const stall = { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 };
    expect(promptStallDetail(stall, 1000 + 45_000)).toContain("from conductor");
    expect(promptStallDetail(stall, 1000 + 45_000)).toContain("resending can repeat the message");
  });
});
