import { describe, it, expect, vi } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError, AgentNotRunningError, type AgentRecord } from "@chimera/core/supervisor";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { makeSupervisor } from "./helpers.js";

describe("AgentSupervisor mailboxes", () => {
  it("send() enqueues and delivers to a live agent", async () => {
    const scenario: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "after msg" } }];
    const { sup, dir } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId, "extra instruction", "tester");
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    const echo = new EventLog(dir).tail(rec.agentId, 50).find((e) => e.kind === "message_complete");
    expect(echo?.data["text"]).toBe("echo:[from tester] extra instruction");
  });

  it("send() to an unknown agent throws UnknownAgentError", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.send("ghost", "hi")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  // WORKER-TEAM-CONTEXT: a team worker's roster (scheduler.ts rosterFor) deliberately shows only
  // an 8-char agentId prefix in its own spawn instructions ("per the design", for readability) —
  // agent_send must accept that exact short form a worker was told IS its teammate's id, or every
  // worker addressing a teammate that way gets "unknown agent".
  it("send() resolves a unique 8-char id prefix to the full agentId (roster short-id addressing)", async () => {
    const scenario: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "after msg" } }];
    const { sup, dir } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId.slice(0, 8), "hi", "tester");
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    const echo = new EventLog(dir).tail(rec.agentId, 50).find((e) => e.kind === "message_complete");
    expect(echo?.data["text"]).toBe("echo:[from tester] hi");
  });

  it("send() to an unknown short id still throws UnknownAgentError (no accidental partial match)", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.send("ghosthea", "hi")).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("send() to a finished agent rejects with AgentNotRunningError", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    await expect(sup.send(rec.agentId, "too late")).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("deliverTo routes a child result into the parent's stream", async () => {
    const parent: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "parent done" } }];
    const child: FakeStep[] = [{ end: { resultText: "child done" } }];
    const { sup, dir } = makeSupervisor([parent, child]);
    const p = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });
    const c = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: p.agentId });
    await sup.waitFor(c.agentId, 1000);
    const pFinal = await sup.waitFor(p.agentId, 1000);           // child result woke the parent
    expect(pFinal.state).toBe("done");
    const echo = new EventLog(dir).tail(p.agentId, 50).find((e) => e.kind === "message_complete");
    expect(echo?.data["text"]).toBe(`echo:[from ${c.agentId}] child done`);
  });
});

// ---------- additional coverage: every branch/edge beyond the brief's examples ----------

describe("AgentSupervisor: send() additional branches", () => {
  it("send() defaults `from` to 'caller' when omitted", async () => {
    const scenario: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "done" } }];
    const { sup, dir } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.send(rec.agentId, "hi");                    // no `from` argument
    await sup.waitFor(rec.agentId, 1000);
    const echo = new EventLog(dir).tail(rec.agentId, 50).find((e) => e.kind === "message_complete");
    expect(echo?.data["text"]).toBe("echo:[from caller] hi");
  });

  it("send() to a killed agent rejects with AgentNotRunningError", async () => {
    expect.assertions(1);
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.kill(rec.agentId);
    await expect(sup.send(rec.agentId, "too late")).rejects.toBeInstanceOf(AgentNotRunningError);
  });
});

describe("AgentSupervisor: deliverPending no-op branches (protected, direct-call)", () => {
  function castDeliverPending(sup: unknown) {
    return sup as unknown as { deliverPending(agentId: string): void };
  }

  it("no-ops for a completely unknown agentId (no record)", async () => {
    const { sup, dir } = makeSupervisor([]);
    // enqueue directly (bypassing sup.send, which would throw for an unknown agent)
    new MailboxStore(dir).enqueue("ghost", { from: "x", kind: "signal", text: "unreachable" });
    expect(() => castDeliverPending(sup).deliverPending("ghost")).not.toThrow();
    // no record => no drain: the message must still be pending afterward
    expect(new MailboxStore(dir).pending("ghost").map((m) => m.text)).toEqual(["unreachable"]);
  });

  it("no-ops when the record exists but is not running (e.g. done)", async () => {
    const { sup, dir } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    new MailboxStore(dir).enqueue(rec.agentId, { from: "x", kind: "user_message", text: "too late" });
    expect(() => castDeliverPending(sup).deliverPending(rec.agentId)).not.toThrow();
    expect(new MailboxStore(dir).pending(rec.agentId).map((m) => m.text)).toEqual(["too late"]);
  });

  it("no-ops when the record is running but has no live handle registered", async () => {
    const scenario: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "never" } }];
    const { sup, dir } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    // simulate the record existing without a registered handle (internal invariant edge)
    (sup as unknown as { handles: Map<string, unknown> }).handles.delete(rec.agentId);
    new MailboxStore(dir).enqueue(rec.agentId, { from: "x", kind: "user_message", text: "stuck" });
    expect(() => castDeliverPending(sup).deliverPending(rec.agentId)).not.toThrow();
    expect(new MailboxStore(dir).pending(rec.agentId).map((m) => m.text)).toEqual(["stuck"]);
  });
});

describe("AgentSupervisor: re-enqueue on handle.send() rejection (no-drop, spec §8)", () => {
  it("re-enqueues a user_message (meta-less) when handle.send() rejects", async () => {
    const scenario: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "done" } }];
    const { sup, dir } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async () => { throw new Error("boom"); } });

    await sup.send(rec.agentId, "hello", "tester");
    // deliverPending fires the send-then-catch as a detached promise; flush microtasks+macrotask
    await new Promise((r) => setTimeout(r, 0));

    const pending = new MailboxStore(dir).pending(rec.agentId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ from: "tester", kind: "user_message", text: "hello" });
    expect(pending[0]!.meta).toBeUndefined();               // falsy-meta ternary branch: no `meta` key spread in
  });

  it("re-enqueues a child_result (with meta.costUsd) when the parent's handle.send() rejects", async () => {
    const parent: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "parent done" } }];
    const child: FakeStep[] = [{ end: { resultText: "child done", costUsd: 0.5 } }];
    const { sup, dir } = makeSupervisor([parent, child]);
    const p = await sup.spawn({ prompt: "conduct", cwd: "/tmp", account: "main", isolation: "none" });

    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(p.agentId)!;
    handles.set(p.agentId, { ...real, send: async () => { throw new Error("boom"); } });

    const c = await sup.spawn({ prompt: "work", cwd: "/tmp", account: "second", isolation: "none", deliverTo: p.agentId });
    await sup.waitFor(c.agentId, 1000);
    await new Promise((r) => setTimeout(r, 0));              // flush the detached send().catch()

    const pending = new MailboxStore(dir).pending(p.agentId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ from: c.agentId, kind: "child_result", text: "child done", meta: { costUsd: 0.5 } });
  });

  it("head-of-batch failure re-enqueues the whole batch in original order, delivering nothing", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    // handle whose send rejects on the FIRST call and would resolve afterwards
    let calls = 0;
    const sent: string[] = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async (t: string) => { calls++; if (calls === 1) throw new Error("boom"); sent.push(t); } });

    const mb = new MailboxStore(dir);
    mb.enqueue(rec.agentId, { from: "a", kind: "user_message", text: "one" });
    mb.enqueue(rec.agentId, { from: "b", kind: "user_message", text: "two" });

    (sup as unknown as { deliverPending(id: string): void }).deliverPending(rec.agentId);
    await new Promise((r) => setTimeout(r, 0));

    // first send failed → both re-enqueued in original order; second NOT delivered ahead of the failed first
    expect(calls).toBe(1);
    expect(sent).toEqual([]);
    expect(new MailboxStore(dir).pending(rec.agentId).map((m) => m.text)).toEqual(["one", "two"]);
  });

  // TOKEN-OPT-BATCH-TURNS: a drained batch is now delivered as one TURN per foldable run, not
  // one turn per message — a send is a full context pass, so five results arriving together used
  // to cost five. The no-drop/FIFO guarantee is unchanged and is what these tests pin; what
  // changed is only where the turn boundaries fall. A run that fails re-enqueues the WHOLE run,
  // because none of it was delivered.
  it("true mid-batch failure: delivers the first turn, re-enqueues the failed turn + tail in order", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    let calls = 0;
    const sent: string[] = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    // msg #1 succeeds, msg #2 rejects — the genuine mid-batch case (re-enqueue must start at the FAILED index, not 0)
    handles.set(rec.agentId, { ...real, send: async (t: string) => { calls++; if (calls === 2) throw new Error("boom"); sent.push(t); } });

    const mb = new MailboxStore(dir);
    mb.enqueue(rec.agentId, { from: "a", kind: "user_message", text: "one" });
    // a slash command can never share a turn (it must arrive verbatim), so it forces a second
    // turn — which is what makes a genuine MID-batch failure reachable at all now
    mb.enqueue(rec.agentId, { from: "b", kind: "user_message", text: "/compact", slash: true });
    mb.enqueue(rec.agentId, { from: "c", kind: "user_message", text: "three" });

    (sup as unknown as { deliverPending(id: string): void }).deliverPending(rec.agentId);
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toBe(2);
    expect(sent).toEqual(["[from a] one"]);                                    // first turn delivered, NOT re-enqueued
    expect(new MailboxStore(dir).pending(rec.agentId).map((m) => m.text)).toEqual(["/compact", "three"]);  // failed + tail, in order
  });

  it("a failed COALESCED turn re-enqueues every message in it — none of them was delivered", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async () => { throw new Error("boom"); } });

    const mb = new MailboxStore(dir);
    for (const t of ["one", "two", "three"]) mb.enqueue(rec.agentId, { from: "a", kind: "user_message", text: t });

    (sup as unknown as { deliverPending(id: string): void }).deliverPending(rec.agentId);
    await new Promise((r) => setTimeout(r, 0));

    expect(new MailboxStore(dir).pending(rec.agentId).map((m) => m.text)).toEqual(["one", "two", "three"]);
  });

  it("delivers a multi-message batch as ONE turn, with every message still attributed", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    const sent: string[] = [];
    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    handles.set(rec.agentId, { ...real, send: async (t: string) => { sent.push(t); } });

    const mb = new MailboxStore(dir);
    mb.enqueue(rec.agentId, { from: "a", kind: "user_message", text: "one" });
    mb.enqueue(rec.agentId, { from: "b", kind: "user_message", text: "two" });

    (sup as unknown as { deliverPending(id: string): void }).deliverPending(rec.agentId);
    await new Promise((r) => setTimeout(r, 0));

    // one send, not two — but nothing is lost: both attributions survive inside the turn, in
    // arrival order, which is what the agent actually needs to tell them apart
    expect(sent).toEqual(["[from a] one\n\n[from b] two"]);
    expect(new MailboxStore(dir).pending(rec.agentId)).toEqual([]);            // whole batch acked, nothing left
  });
});

describe("AgentSupervisor: turn_complete triggers deliverPending", () => {
  it("delivers a mailbox message enqueued directly (not via send()) once turn_complete fires", async () => {
    const scenario: FakeStep[] = [
      { emit: { kind: "turn_complete", data: {} } },
      { awaitSend: true },
      { end: { resultText: "done" } },
    ];
    const { sup, dir } = makeSupervisor([scenario]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    // enqueue directly into the mailbox, bypassing sup.send() (which would itself trigger delivery)
    new MailboxStore(dir).enqueue(rec.agentId, { from: "direct", kind: "user_message", text: "hello" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    const echo = new EventLog(dir).tail(rec.agentId, 50).find((e) => e.kind === "message_complete");
    expect(echo?.data["text"]).toBe("echo:[from direct] hello");
  });
});

describe("AgentSupervisor: afterResult (protected, direct-call) branches", () => {
  function castAfterResult(sup: unknown) {
    return sup as unknown as { afterResult(record: AgentRecord): void };
  }

  it("is a no-op when spec.deliverTo is null", () => {
    const { sup, dir } = makeSupervisor([]);
    const record = {
      agentId: "child-none", spec: { deliverTo: null }, accountName: "main", provider: "claude",
      state: "done", depth: 0, createdAt: Date.now(), principal: "local", attempts: [],
      resultText: "irrelevant", costUsd: 0,
    } as unknown as AgentRecord;
    expect(() => castAfterResult(sup).afterResult(record)).not.toThrow();
    // nothing should have been written anywhere reachable; spot-check a plausible target
    expect(new MailboxStore(dir).pending("child-none")).toEqual([]);
  });

  it("enqueues a child_result with from/kind/text/meta.costUsd into the deliverTo mailbox", () => {
    const { sup, dir } = makeSupervisor([]);
    const record = {
      agentId: "child-1", spec: { deliverTo: "parent-1" }, accountName: "main", provider: "claude",
      state: "done", depth: 0, createdAt: Date.now(), principal: "local", attempts: [],
      resultText: "the answer", costUsd: 0.25,
    } as unknown as AgentRecord;
    castAfterResult(sup).afterResult(record);
    const msgs = new MailboxStore(dir).pending("parent-1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from: "child-1", kind: "child_result", text: "the answer", meta: { costUsd: 0.25 } });
  });

  it("defaults text to an empty string when resultText is undefined", () => {
    const { sup, dir } = makeSupervisor([]);
    const record = {
      agentId: "child-2", spec: { deliverTo: "parent-2" }, accountName: "main", provider: "claude",
      state: "done", depth: 0, createdAt: Date.now(), principal: "local", attempts: [],
      resultText: undefined, costUsd: 0,
    } as unknown as AgentRecord;
    castAfterResult(sup).afterResult(record);
    const msgs = new MailboxStore(dir).pending("parent-2");
    expect(msgs[0]?.text).toBe("");
  });
});


it("explicit force steers an active backend before visible turn events, preserving ordered text blocks", async () => {
  const { sup } = makeSupervisor([[{ awaitSend: true }]]);
  const rec = await sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
  const handles = (sup as unknown as { handles: Map<string, import("@chimera/core/backend").AgentHandle> }).handles;
  const handle = handles.get(rec.agentId)!;
  const steer = vi.fn(async () => {});
  const send = vi.spyOn(handle, "send");
  handle.isTurnActive = () => true;
  handle.steer = steer;
  await sup.send(rec.agentId, "fallback", "app", undefined, false, [{ type: "text", text: "first" }, { type: "text", text: "second" }], { force: true });
  expect(steer).toHaveBeenCalledWith("[from app] fallback", undefined, [{ type: "text", text: "[from app] first" }, { type: "text", text: "second" }]);
  expect(send).not.toHaveBeenCalled();
  await sup.kill(rec.agentId);
});

it.each(["child_result", "child_failed", "signal", "user_message"] as const)("keeps ordinary %s durable while Codex is active and delivers at its boundary", async kind => {
  const { sup, dir } = makeSupervisor([[{ awaitSend: true }]]);
  const rec = await sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
  rec.provider = "codex";
  const internals = sup as unknown as {
    handles: Map<string, import("@chimera/core/backend").AgentHandle>;
    deliverPending(id: string): void;
    onEvent(record: AgentRecord, event: import("@chimera/core/backend").BackendEvent): void;
  };
  const handle = internals.handles.get(rec.agentId)!;
  handle.isTurnActive = () => true; // still active inside the synchronous turn_complete callback
  handle.send = vi.fn(async () => {});
  handle.steer = vi.fn(async () => {});
  const mb = new MailboxStore(dir);
  mb.enqueue(rec.agentId, { from: "peer", kind, text: "peer result" });
  internals.deliverPending(rec.agentId);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(handle.steer).not.toHaveBeenCalled();
  expect(handle.send).not.toHaveBeenCalled();
  expect(mb.pending(rec.agentId)).toHaveLength(1);
  internals.onEvent(rec, { kind: "turn_complete", data: {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(handle.steer).not.toHaveBeenCalled();
  expect(handle.send).toHaveBeenCalledTimes(1);
  expect(mb.pending(rec.agentId)).toEqual([]);
  await sup.kill(rec.agentId);
});

it("force keeps older mail first without turning a peer result into a forced message", async () => {
  const { sup, dir } = makeSupervisor([[{ awaitSend: true }]]);
  const rec = await sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
  rec.provider = "codex";
  const handle = (sup as unknown as { handles: Map<string, import("@chimera/core/backend").AgentHandle> }).handles.get(rec.agentId)!;
  handle.isTurnActive = () => true;
  const sent: string[] = [];
  handle.send = async text => { sent.push(`send:${text}`); };
  handle.steer = async text => { sent.push(`force:${text}`); };
  const result = await sup.send(rec.agentId, "earlier", "peer", undefined, false, undefined, { awaitAckMs: 10 });
  expect(result).toMatchObject({ delivered: false, ack: "mid_turn" });
  expect(new MailboxStore(dir).pending(rec.agentId)).toHaveLength(1);
  await sup.send(rec.agentId, "now", "app", undefined, false, undefined, { force: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent).toEqual(["send:[from peer] earlier", "force:[from app] now"]);
  await sup.kill(rec.agentId);
});

it("empty startup delivery does not erase a message retained for error recovery", async () => {
  const { sup } = makeSupervisor([[{ awaitSend: true }]]);
  const rec = await sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
  const internals = sup as unknown as {
    handles: Map<string, import("@chimera/core/backend").AgentHandle>;
    inFlight: Map<string, import("@chimera/core/mailbox").MailboxMessage[]>;
    deliverPending(id: string): void;
  };
  internals.handles.get(rec.agentId)!.send = async () => {};
  await sup.send(rec.agentId, "retained", "peer");
  await new Promise(resolve => setTimeout(resolve, 0));
  internals.deliverPending(rec.agentId);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(internals.inFlight.get(rec.agentId)?.map(m => m.text)).toEqual(["retained"]);
  await sup.kill(rec.agentId);
});
