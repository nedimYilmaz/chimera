import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { AgentSupervisor, UnknownAgentError } from "@chimera/core/supervisor";
import type { AgentBackend, AgentHandle, EventSink } from "@chimera/core/backend";
import { CFG, fakeExec, makeSupervisor } from "./helpers.js";

const settle = () => new Promise((r) => setTimeout(r, 20));

function mkSup(backend: AgentBackend) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-cond-"));
  const events = new EventLog(dir);
  const mailboxes = new MailboxStore(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", backend]]),
    events,
    mailboxes,
    cooldowns: new CooldownTracker(60_000),
  });
  return { sup, events, mailboxes, dir };
}

function stubBackend() {
  const calls: string[] = [];
  let sinkRef: EventSink | null = null;
  const backend: AgentBackend = {
    provider: "claude",
    capabilities: { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true },
    spawn(_spec, sink) {
      sinkRef = sink;
      sink({ kind: "agent_started", data: {} });
      return {
        send: async () => { calls.push("send"); },
        interrupt: async () => { calls.push("interrupt"); },
        kill: async () => { calls.push("kill"); },
        close: async () => {
          calls.push("close");
          sinkRef?.({ kind: "turn_complete", data: {} });
          sinkRef?.({ kind: "result", data: { text: "closed cleanly", costUsd: 0 } });
        },
      } satisfies AgentHandle;
    },
  };
  return { backend, calls };
}

// close() closes the input (send rejects afterwards) but the terminal result arrives
// only when ctl.finish() is called — this models the real conductor close window.
function closingBackend() {
  const ctl = { finish: () => {} };
  let closed = false;
  const backend: AgentBackend = {
    provider: "claude",
    capabilities: { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true },
    spawn(_spec, sink) {
      sink({ kind: "agent_started", data: {} });
      ctl.finish = () => {
        sink({ kind: "turn_complete", data: {} });
        sink({ kind: "result", data: { text: "closed", costUsd: 0 } });
      };
      return {
        send: async () => { if (closed) throw new Error("input stream closed"); },
        interrupt: async () => {},
        kill: async () => {},
        close: async () => { closed = true; },
      } satisfies AgentHandle;
    },
  };
  return { backend, ctl };
}

describe("AgentSupervisor conductor close", () => {
  it("normalizes a standalone conductor to persistent and keeps it running after its first completed turn", async () => {
    const { sup, events, fake } = makeSupervisor([[
      { emit: { kind: "agent_started", data: {} } },
      { turn: { text: "initial prompt complete" } },
    ]]);
    const rec = await sup.spawn({
      prompt: "conduct", cwd: "/tmp", isolation: "none", account: "main",
      conductor: true, displayLabel: "release captain",
    });
    await settle();

    expect(fake.spawns[0]).toMatchObject({ conductor: true, persistent: true, displayLabel: "release captain" });
    expect(events.tail(rec.agentId, 50).some((e) => e.kind === "turn_complete")).toBe(true);
    expect(sup.status(rec.agentId)).toMatchObject({
      state: "running", displayLabel: "release captain",
      spec: { conductor: true, persistent: true, displayLabel: "release captain" },
    });

    await sup.closeInput(rec.agentId);
    await expect(sup.waitFor(rec.agentId, 1000)).resolves.toMatchObject({ state: "done" });
  });

  it("closeInput calls the handle's close and the agent finishes with a result", async () => {
    const { backend, calls } = stubBackend();
    const { sup } = mkSup(backend);
    const rec = await sup.spawn({ prompt: "conduct", cwd: "/tmp", isolation: "none", account: "main", conductor: true });
    await sup.closeInput(rec.agentId);
    expect(calls).toContain("close");
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("closed cleanly");
  });

  it("closeInput throws UnknownAgentError for ghosts and tolerates handles without close", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "x" } }]]);
    await expect(sup.closeInput("ghost")).rejects.toBeInstanceOf(UnknownAgentError);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main" });
    await expect(sup.closeInput(rec.agentId)).resolves.toBeUndefined();   // FakeAgentBackend handle has no close()
  });

  it("a message sent in the close window is re-enqueued, not ACKed-and-lost (spec §8 no-drop)", async () => {
    const { backend, ctl } = closingBackend();
    const { sup, mailboxes } = mkSup(backend);
    const rec = await sup.spawn({ prompt: "conduct", cwd: "/tmp", isolation: "none", account: "main", conductor: true });
    await sup.closeInput(rec.agentId);
    await sup.send(rec.agentId, "in the window", "caller");   // record still "running" — passes the state check
    await settle();                                           // let the rejected handle.send re-enqueue
    expect(mailboxes.drain(rec.agentId).map((m) => m.text)).toEqual(["in the window"]);   // preserved, not lost
    ctl.finish();
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
  });

  it("deliverPending appends a status{delivered} event so every client's user turns can render", async () => {
    const { backend } = stubBackend();
    const { sup, events } = mkSup(backend);
    const rec = await sup.spawn({ prompt: "conduct", cwd: "/tmp", isolation: "none", account: "main", conductor: true });
    await sup.send(rec.agentId, "status update please", "mcp");
    await settle();                                           // deliverPending's handle.send is fire-and-forget
    const delivered = events.tail(rec.agentId, 50).find((e) => e.kind === "status" && e.data["delivered"] === true);
    expect(delivered?.data).toEqual({ delivered: true, from: "mcp", text: "status update please" });
  });

  it("permission policy \"tui\" emits permission_request and honors respondPermission", async () => {
    const { sup, events } = makeSupervisor([[{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }]]);
    const policies: unknown[] = [];
    events.subscribe((e) => {
      if (e.kind === "permission_request") {
        policies.push(e.data["policy"]);
        expect(sup.respondPermission(String(e.data["requestId"]), true)).toBe(true);
      }
    });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main", on: { permissionRequest: "tui" } });
    await sup.waitFor(rec.agentId, 1000);
    expect(policies).toEqual(["tui"]);
    expect(events.tail(rec.agentId, 50).map((e) => e.kind)).toContain("tool_call");
  });

  it("the timeout fallback emits a correlatable status{permissionResolved} event", async () => {
    const { sup, events } = makeSupervisor([[{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main", on: { permissionRequest: "tui" } });
    await sup.waitFor(rec.agentId, 2000);                     // nobody answers; the 100ms fallback fires
    const evs = events.tail(rec.agentId, 50);
    const req = evs.find((e) => e.kind === "permission_request")!;
    const resolved = evs.find((e) => e.kind === "status" && e.data["permissionResolved"] === true)!;
    expect(resolved.data["requestId"]).toBe(req.data["requestId"]);
    expect(resolved.data["timedOut"]).toBe(true);
    expect(resolved.data["allow"]).toBe(false);               // default profile denies Bash
  });

  // ---------- additional coverage: branches/edges beyond the brief's examples ----------

  it("closeInput on an already-finished agent still calls the handle's close (no running-state guard)", async () => {
    const { backend, calls } = stubBackend();
    const { sup } = mkSup(backend);
    const rec = await sup.spawn({ prompt: "conduct", cwd: "/tmp", isolation: "none", account: "main", conductor: true });
    await sup.closeInput(rec.agentId);                        // 1st close -> finishes the agent
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(final.state).toBe("done");
    // the handle is never removed from the supervisor's map after completion,
    // and closeInput does not gate on running state — a 2nd close is a no-op
    // pass-through to the (still-present) handle, not a thrown error.
    await expect(sup.closeInput(rec.agentId)).resolves.toBeUndefined();
    expect(calls.filter((c) => c === "close").length).toBe(2);
  });

  it("deliverPending does NOT append status{delivered} when handle.send rejects (message is re-enqueued instead)", async () => {
    const backend: AgentBackend = {
      provider: "claude",
      capabilities: { supportsResume: true, supportsMcpServers: true, supportsSettingSources: true },
      spawn(_spec, sink) {
        sink({ kind: "agent_started", data: {} });
        return {
          send: async () => { throw new Error("boom"); },
          interrupt: async () => {},
          kill: async () => {},
        } satisfies AgentHandle;
      },
    };
    const { sup, events, mailboxes } = mkSup(backend);
    const rec = await sup.spawn({ prompt: "conduct", cwd: "/tmp", isolation: "none", account: "main", conductor: true });
    await sup.send(rec.agentId, "will fail", "caller");
    await settle();
    const delivered = events.tail(rec.agentId, 50).find((e) => e.kind === "status" && e.data["delivered"] === true);
    expect(delivered).toBeUndefined();
    expect(mailboxes.drain(rec.agentId).map((m) => m.text)).toEqual(["will fail"]);   // no-drop: re-enqueued
  });

  it("the timeout fallback's status{permissionResolved} reflects allow:true when the profile's autoDecision permits", async () => {
    const { sup, events } = makeSupervisor([[{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", isolation: "none", account: "main",
      permissionProfile: "full", on: { permissionRequest: "tui" },
    });                                                        // nobody answers -> fallback -> autoDecision("full", "Bash") === true
    await sup.waitFor(rec.agentId, 2000);
    const resolved = events.tail(rec.agentId, 50).find((e) => e.kind === "status" && e.data["permissionResolved"] === true);
    expect(resolved?.data["allow"]).toBe(true);
    expect(resolved?.data["timedOut"]).toBe(true);
  });

  // ANSWERED-PROMPT-STAYS-PENDING: same correction as its question-side twin in
  // supervisor-questions.test.ts — the invariant here is that responding CANCELS THE TIMER, which
  // used to be proven by the absence of any permissionResolved event. Responding now emits its
  // own (so a client that did not itself answer stops showing a stale banner), so the timer
  // invariant is pinned directly: one resolution, and it is not the timeout's.
  it("responding cancels the timeout — exactly one resolution event, and it is not the timeout's", async () => {
    const { sup, events } = makeSupervisor([[{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }]]);
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "main", on: { permissionRequest: "tui" } });
    await sup.waitFor(rec.agentId, 1000);
    await new Promise((r) => setTimeout(r, 150));             // well past the 100ms timeout the answer must have cleared
    const resolved = events.tail(rec.agentId, 50).filter((e) => e.kind === "status" && e.data["permissionResolved"] === true);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.data["timedOut"]).toBeUndefined();
    expect(resolved[0]!.data["allow"]).toBe(true);
  });
});
