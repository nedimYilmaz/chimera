import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { isAgentUnseen } from "@chimera/protocol";
import { makeEngineHome, makeSupervisor } from "./helpers.js";

// F09.QA — supervisor-level regressions for three defects found reviewing F09.0/1/2.
// The rig stubs the handle's send so the fake agent never emits a turn-opening event: every
// delivery stays unacknowledged, which is precisely the state each bug needs.

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend(
  Array.from({ length: 6 }, () => [{ awaitSend: true }]),
)]]);
const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

type StallMaps = { stalls: Map<string, unknown>; isMidTurn(agentId: string): boolean };
const rig = async () => {
  const e = new Engine({ home: makeEngineHome(), backends: backends() });
  const a = await e.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
  await flush();
  const sup = e.supervisor as unknown as {
    handles: Map<string, { send(t: string): Promise<void> }>;
    agents: Map<string, Record<string, unknown>>;
    promptAck: StallMaps;
    parkIdle(agentId: string, idleMs: number): Promise<void>;
    onEvent(record: unknown, e: { kind: string; data?: Record<string, unknown> }): void;
  };
  const real = sup.handles.get(a.agentId)!;
  sup.handles.set(a.agentId, { ...real, send: async () => {} });
  return { e, sup, agentId: a.agentId };
};
const SLOW = 30_000;

describe("F09.QA: a slash command never arms the prompt-stall watch", () => {
  it("leaves no stall entry — /compact legitimately runs longer than PROMPT_STALL_MS", async () => {
    const { e, sup, agentId } = await rig();
    await e.handle("agent.send", { agentId, text: "/compact", from: "conductor", slash: true });
    await flush();
    expect(sup.promptAck.stalls.has(agentId)).toBe(false);
  }, SLOW);

  it("still arms it for an ordinary prompt — the exemption is scoped to slash", async () => {
    const { e, sup, agentId } = await rig();
    await e.handle("agent.send", { agentId, text: "do the thing", from: "conductor" });
    await flush();
    expect(sup.promptAck.stalls.has(agentId)).toBe(true);
  }, SLOW);
});

describe("F09.QA: parking an agent drops its ack watch (A7)", () => {
  it("parkIdle forgets the pending stall instead of leaving a timer to fire on a paused agent", async () => {
    const { e, sup, agentId } = await rig();
    await e.handle("agent.send", { agentId, text: "do the thing", from: "conductor" });
    await flush();
    expect(sup.promptAck.stalls.has(agentId)).toBe(true);
    await sup.parkIdle(agentId, 1);
    expect(sup.agents.get(agentId)!["state"]).toBe("paused");
    // Without the forget the timer still fires: firePromptStall drops it (state !== running) but
    // the entry is already marked `fired`, so the first turn-opening event after resume appends a
    // promptStallCleared for a stall no client ever saw.
    expect(sup.promptAck.stalls.has(agentId)).toBe(false);
  }, SLOW);
});

describe("F09.QA: a replayed stall is cleared by the next turn", () => {
  it("clears a replayed stall on the provider's explicit start before any content", async () => {
    const { sup, agentId } = await rig();
    const record = sup.agents.get(agentId)!;
    record["promptStall"] = { deliveryId: "msg-1", from: "app", sinceTs: 1, sinceMs: 45_000, lastSeq: 3, messageCount: 1 };
    sup.onEvent(record, { kind: "status", data: { turnStarted: true } });
    expect(record["promptStall"]).toBeNull();
    expect(sup.promptAck.isMidTurn(agentId)).toBe(true);
  }, SLOW);

  it("clears record.promptStall on a turn-opening event even when the watch has no entry", async () => {
    const { sup, agentId } = await rig();
    const record = sup.agents.get(agentId)!;
    // Exactly what replay.ts's agent_prompt_stalled fold rebuilds after a daemon restart — while
    // PromptAckWatch comes back EMPTY, so observe() has nothing to resolve.
    record["promptStall"] = { deliveryId: "msg-1", from: "conductor", sinceTs: 1, sinceMs: 45_000, lastSeq: 3, messageCount: 1 };
    sup.onEvent(record, { kind: "message_delta", data: { text: "working" } });
    expect(record["promptStall"]).toBeNull();
  }, SLOW);
});

describe("F09.QA item 3: a fired stall raises the fleet unseen flag", () => {
  it("firePromptStall's agent_prompt_stalled event stamps attentionAt, so isAgentUnseen flips true", async () => {
    // A supervisor-level rig (not Engine): promptStallMs is only reachable via makeSupervisor's
    // DI seam, and a few ms here beats waiting out ChimeraConfigSchema.promptAck's real 45s.
    const { sup } = makeSupervisor([[{ awaitSend: true }]], undefined, { promptStallMs: 20 });
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", isolation: "none" });
    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async () => {} });     // never acks — the stall must fire
    await sup.send(rec.agentId, "do the thing", "conductor", undefined, false, undefined, { awaitAckMs: 5 });
    await new Promise((r) => setTimeout(r, 80));
    const status = sup.status(rec.agentId) as { attentionAt?: number; reviewedAt?: number };
    expect(status.attentionAt).toBeDefined();
    expect(isAgentUnseen({ attentionAt: status.attentionAt, reviewedAt: status.reviewedAt })).toBe(true);
  }, SLOW);
});
