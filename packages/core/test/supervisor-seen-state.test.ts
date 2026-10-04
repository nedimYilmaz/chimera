import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { isAgentUnseen } from "@chimera/protocol";
import type { AgentBackend } from "@chimera/core/backend";
import { AgentSpecSchema } from "@chimera/protocol";
import { MAX_TERMINAL_AGENTS_PERSISTED, type AgentRecord } from "@chimera/core/supervisor";
import { makeEngineHome, CFG, fakeExec } from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { AgentArchiveStore } from "@chimera/core/agent-archive";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";

// F47 (fleet seen-state): attentionAt is stamped by the supervisor at every attention-class
// event; reviewedAt only by an explicit operator markSeen. "Unseen" is DERIVED from the pair
// (isAgentUnseen), never stored — which is exactly what makes a new attention event re-unsee an
// agent for free.

const engineWithFake = (fake: FakeAgentBackend): Engine =>
  new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", fake]]) });

const settle = () => new Promise((r) => setTimeout(r, 30));
// Date.now() has ms resolution: without this, a markSeen and the attention event that follows it
// can land in the SAME millisecond, and the tie reads as SEEN by contract.
const tick = () => new Promise((r) => setTimeout(r, 5));

function terminalRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "a", spec: AgentSpecSchema.parse({ prompt: "hello", cwd: "/tmp", isolation: "none" }),
    accountName: "main", provider: "claude", state: "done", depth: 0, treeId: "a",
    createdAt: Date.now(), principal: "local", attempts: [], costUsd: 0, parentId: null,
    projectId: null, resultText: "r",
    ...over,
  };
}

describe("AgentSupervisor seen-state (F47)", () => {
  it("A1: a freshly spawned agent has no attentionAt and is seen", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ awaitSend: true }]]));
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await settle();

    const r = e.supervisor.status(rec.agentId);
    expect(r.attentionAt).toBeUndefined();
    expect(r.reviewedAt).toBeUndefined();
    expect(isAgentUnseen(r)).toBe(false);
  });

  it("A2: a result event stamps attentionAt and makes the agent unseen", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ end: { resultText: "done" } }]]));
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await settle();

    const r = e.supervisor.status(rec.agentId);
    expect(typeof r.attentionAt).toBe("number");
    expect(isAgentUnseen(r)).toBe(true);
  });

  it("streaming chatter is not attention: message_delta leaves attentionAt untouched", async () => {
    const e = engineWithFake(new FakeAgentBackend([[
      { emit: { kind: "message_delta", data: { text: "thinking" } } },
      { emit: { kind: "turn_complete", data: {} } },
      { awaitSend: true },
    ]]));
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await settle();

    expect(e.supervisor.status(rec.agentId).attentionAt).toBeUndefined();
    expect(e.events.tail(rec.agentId, 20).some((ev) => ev.kind === "message_delta")).toBe(true);
  });

  it("A3 + A4: markSeen acknowledges, and the NEXT attention event re-unsees", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]]));
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await settle();

    e.supervisor.markSeen([rec.agentId]);
    const acked = e.supervisor.status(rec.agentId);
    expect(typeof acked.reviewedAt).toBe("number");
    expect(isAgentUnseen(acked)).toBe(false);

    await tick();
    await e.supervisor.send(rec.agentId, "go");                 // drives the scripted result
    await settle();

    const after = e.supervisor.status(rec.agentId);
    expect(after.attentionAt!).toBeGreaterThan(after.reviewedAt!);
    expect(isAgentUnseen(after)).toBe(true);

    await tick();
    e.supervisor.markSeen([rec.agentId]);
    const reacked = e.supervisor.status(rec.agentId);
    expect(reacked.reviewedAt!).toBeGreaterThanOrEqual(reacked.attentionAt!);
    expect(isAgentUnseen(reacked)).toBe(false);
  });

  it("A5: one unknown id fails the whole call and stamps NOTHING (validate-all-then-mutate)", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ awaitSend: true }]]));
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await settle();

    expect(() => e.supervisor.markSeen([rec.agentId, "ghost-1"])).toThrow();
    expect(e.supervisor.status(rec.agentId).reviewedAt).toBeUndefined();
  });

  it("A6: markSeen appends exactly one status event per agent, carrying state + reviewedAt", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ awaitSend: true }], [{ awaitSend: true }]]));
    const a = await e.supervisor.spawn({ prompt: "a", cwd: "/tmp", isolation: "none" });
    const b = await e.supervisor.spawn({ prompt: "b", cwd: "/tmp", isolation: "none" });
    await settle();

    const before = { a: e.events.tail(a.agentId, 100).length, b: e.events.tail(b.agentId, 100).length };
    e.supervisor.markSeen([a.agentId, b.agentId]);

    for (const [id, prev] of [[a.agentId, before.a], [b.agentId, before.b]] as const) {
      const tail = e.events.tail(id, 100);
      expect(tail.length).toBe(prev + 1);
      const last = tail[tail.length - 1]!;
      expect(last.kind).toBe("status");
      expect(last.data).toEqual({ state: e.supervisor.status(id).state, reviewedAt: e.supervisor.status(id).reviewedAt });
    }
  });

  it("a shadow (native sub-agent) row is never stamped by its parent's attention event", async () => {
    const e = engineWithFake(new FakeAgentBackend([[
      { task: { taskId: "t1", toolUseId: "tu1", subagentType: "explore", description: "look" } },
      { end: { resultText: "done" } },
    ]]));
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await settle();

    const shadow = e.supervisor.list().find((r) => r.shadow === true);
    expect(shadow).toBeTruthy();
    expect(shadow!.attentionAt).toBeUndefined();
    expect(e.supervisor.status(rec.agentId).attentionAt).toBeDefined();   // the real row got it
  });

  it("A8: both stamps survive archiveColdTerminalAgents + lightenAgentRecord", async () => {
    const e = engineWithFake(new FakeAgentBackend([]));
    const now = Date.now();
    const n = MAX_TERMINAL_AGENTS_PERSISTED + 3;
    for (let i = 0; i < n; i++) {
      e.supervisor.reattachTerminal(terminalRecord({
        agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i,
        attentionAt: 1_000 + i, reviewedAt: 500 + i,
      }));
    }

    const snap = e.supervisor.snapshotAgents();
    const lightened = snap.filter((a) => a.archived === true);
    expect(lightened.length).toBeGreaterThan(0);
    for (const a of lightened) {
      expect(a.spec.prompt).toBe("");                        // genuinely lightened
      expect(typeof a.attentionAt).toBe("number");           // ...but the cheap stamps ride along
      expect(typeof a.reviewedAt).toBe("number");
    }
  });
});

// F47.FIX M-1 / M-2 (QA findings on the landed feature). markSeen is the one operator write that
// can be aimed at a WHOLE page of old, cold agents — so it must not be the thing that undoes
// MEMORY-BOUNDED-DISK, and a chunked fleet sweep must not half-mark.

// Counts read()s so a test can assert the stamp path never touched disk. (spy-by-subclass: the
// store is injected whole, so this is the seam with no vi.mock of a module we also import.)
class CountingArchive extends AgentArchiveStore {
  public reads = 0;
  override read(agentId: string): AgentRecord | undefined {
    this.reads++;
    return super.read(agentId);
  }
}

function supWithArchive() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-seen-archive-"));
  const agentArchive = new CountingArchive(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend([]) as AgentBackend]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    agentArchive,
  });
  return { sup, agentArchive };
}

describe("markSeen on cold/archived agents (F47.FIX M-1)", () => {
  it("stamps a lightened record IN PLACE: no archive read, no re-promotion into the hot set", () => {
    const { sup, agentArchive } = supWithArchive();
    const now = Date.now();
    const n = MAX_TERMINAL_AGENTS_PERSISTED + 6;
    for (let i = 0; i < n; i++) {
      sup.reattachTerminal(terminalRecord({ agentId: `d${i}`, treeId: `d${i}`, createdAt: now + i, attentionAt: now - 60_000 + i }));
    }
    sup.snapshotAgents();                                   // lightens everything past the cap
    const cold = sup.list().filter((a) => a.archived === true).map((a) => a.agentId);
    expect(cold.length).toBe(6);

    agentArchive.reads = 0;
    const res = sup.markSeen(cold);

    expect(res.marked).toBe(cold.length);
    expect(agentArchive.reads).toBe(0);                     // THE point: no blocking disk read per id
    for (const id of cold) {
      const row = sup.list().find((a) => a.agentId === id)!;
      expect(row.archived).toBe(true);                      // still lightened — not rehydrated
      expect(row.spec.prompt).toBe("");
      expect(typeof row.reviewedAt).toBe("number");         // ...and the stamp landed anyway
      expect(isAgentUnseen(row)).toBe(false);
    }
  });

  it("skipUnknown stamps every id the daemon knows and REPORTS the rest (chunked sweeps can't half-mark)", async () => {
    const e = engineWithFake(new FakeAgentBackend([[{ awaitSend: true }]]));
    const rec = await e.supervisor.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await settle();

    const res = e.supervisor.markSeen([rec.agentId, "ghost-1"], { skipUnknown: true });

    expect(res.marked).toBe(1);
    expect(res.unknownIds).toEqual(["ghost-1"]);
    expect(typeof e.supervisor.status(rec.agentId).reviewedAt).toBe("number");
  });
});
