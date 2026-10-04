import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { MailboxStore, type MailboxMessage } from "@chimera/core/mailbox";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { CFG, fakeExec } from "./helpers.js";
import { tmpHome } from "./fed-helpers.js";

const HAPPY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "child done", costUsd: 0.01 } }];

function makeFedSupervisor(scenarios: FakeStep[][], forward?: (t: { engineId: string; agentId: string }, m: MailboxMessage) => void) {
  const dir = tmpHome("sup5");
  const events = new EventLog(dir);
  const mailboxes = new MailboxStore(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG), credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", new FakeAgentBackend(scenarios)]]),
    events, mailboxes, cooldowns: new CooldownTracker(60_000),
    ...(forward ? { mailboxForward: forward } : {}),
  });
  return { sup, mailboxes, events };
}

describe("MailboxStore.hasMessage", () => {
  it("detects ids even after drain (dedup past the watermark)", () => {
    const mb = new MailboxStore(tmpHome("mb5"));
    mb.enqueue("a1", { id: "m-1", from: "x", kind: "child_result", text: "t" });
    expect(mb.hasMessage("a1", "m-1")).toBe(true);
    mb.drain("a1");
    expect(mb.hasMessage("a1", "m-1")).toBe(true);      // drained but remembered
    expect(mb.hasMessage("a1", "m-2")).toBe(false);
    expect(mb.hasMessage("ghost", "m-1")).toBe(false);
  });

  // ---------- additional coverage ----------

  it("returns false for a mailbox file that was never created", () => {
    const mb = new MailboxStore(tmpHome("mb5-empty"));
    expect(mb.hasMessage("never-touched", "m-1")).toBe(false);
  });

  it("finds an id in the middle of multiple messages, not just the first/last", () => {
    const mb = new MailboxStore(tmpHome("mb5-multi"));
    mb.enqueue("a1", { id: "m-1", from: "x", kind: "child_result", text: "t1" });
    mb.enqueue("a1", { id: "m-2", from: "x", kind: "child_result", text: "t2" });
    mb.enqueue("a1", { id: "m-3", from: "x", kind: "child_result", text: "t3" });
    expect(mb.hasMessage("a1", "m-2")).toBe(true);
    expect(mb.hasMessage("a1", "m-4")).toBe(false);
  });

  it("does not crash on a torn/partial line and still finds well-formed ids around it", () => {
    expect.assertions(4);
    const home = tmpHome("mb5-torn");
    const mb = new MailboxStore(home);
    mb.enqueue("a1", { id: "m-1", from: "x", kind: "child_result", text: "t1" });
    // simulate a crash mid-appendFileSync: a torn line landed in the JSONL file
    const path = join(home, "mailboxes", encodeURIComponent("a1") + ".jsonl");
    appendFileSync(path, '{"id":"m-broken", "no closing brace"\n');
    mb.enqueue("a1", { id: "m-2", from: "x", kind: "child_result", text: "t2" });
    expect(() => mb.hasMessage("a1", "m-1")).not.toThrow();
    expect(mb.hasMessage("a1", "m-1")).toBe(true);
    expect(mb.hasMessage("a1", "m-2")).toBe(true);       // lines after the torn one are still scanned
    expect(mb.hasMessage("a1", "m-broken")).toBe(false); // the torn line itself never counts as a match
  });
});

describe("spawn principal", () => {
  it("defaults to local and records a caller-supplied principal", async () => {
    const { sup } = makeFedSupervisor([HAPPY, HAPPY]);
    const a = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" });
    expect(a.principal).toBe("local");
    await sup.waitFor(a.agentId, 1000);   // helpers.ts CFG caps perAccount.main=1; let `a` finish before reusing "main" (else spawn(b) throws the per-account GuardrailError before principal is recorded)
    const b = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" }, { principal: "peer:studio" });
    expect(b.principal).toBe("peer:studio");
  });

  // ---------- additional coverage ----------

  it("defaults to local when opts is an explicit empty object", async () => {
    const { sup } = makeFedSupervisor([HAPPY]);
    const a = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" }, {});
    expect(a.principal).toBe("local");
  });

  it("treats an explicit empty-string principal as itself, not the default (?? is nullish-only, not falsy-or)", async () => {
    const { sup } = makeFedSupervisor([HAPPY]);
    const a = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none" }, { principal: "" });
    expect(a.principal).toBe("");
  });
});

describe("deliverTo forward seam", () => {
  it("routes a QUALIFIED deliverTo through mailboxForward with a sender-assigned id", async () => {
    const forwards: Array<{ target: { engineId: string; agentId: string }; message: MailboxMessage }> = [];
    const { sup, mailboxes } = makeFedSupervisor([HAPPY], (target, message) => forwards.push({ target, message }));
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "studio/parent1" });
    await sup.waitFor(rec.agentId, 1000);
    expect(forwards.length).toBe(1);
    expect(forwards[0]!.target).toEqual({ engineId: "studio", agentId: "parent1" });
    expect(forwards[0]!.message.kind).toBe("child_result");
    expect(forwards[0]!.message.text).toContain("child done");
    expect(forwards[0]!.message.id).toBeTruthy();                       // sender-assigned — dedup key on the far side
    expect(mailboxes.pending("studio/parent1")).toEqual([]);            // nothing written locally
  });

  it("keeps bare deliverTo local, and drops-with-event when qualified but federation is off", async () => {
    const { sup, mailboxes } = makeFedSupervisor([HAPPY]);              // no forward seam
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "parent1" });
    await sup.waitFor(rec.agentId, 1000);
    expect(mailboxes.pending("parent1").map((m) => m.kind)).toEqual(["child_result"]);

    const { sup: sup2, events } = makeFedSupervisor([HAPPY]);
    const rec2 = await sup2.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "studio/parent1" });
    await sup2.waitFor(rec2.agentId, 1000);
    const dropped = events.tail(rec2.agentId, 20).find((e) => e.kind === "status" && e.data["deliverToDropped"]);
    expect(dropped).toBeTruthy();
  });

  // ---------- additional coverage ----------

  it("bare deliverTo wins precedence: stays local even when a forward seam IS configured", async () => {
    const forwards: Array<unknown> = [];
    const { sup, mailboxes } = makeFedSupervisor([HAPPY], (t, m) => forwards.push({ t, m }));
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "parent1" });
    await sup.waitFor(rec.agentId, 1000);
    expect(forwards.length).toBe(0);
    expect(mailboxes.pending("parent1").map((m) => m.kind)).toEqual(["child_result"]);
  });

  it("qualified-but-no-seam drop event carries the exact target and a stable reason string", async () => {
    const { sup, events } = makeFedSupervisor([HAPPY]);
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "studio/parent9" });
    await sup.waitFor(rec.agentId, 1000);
    const dropped = events.tail(rec.agentId, 20).find((e) => e.kind === "status" && e.data["deliverToDropped"]);
    expect(dropped?.data["deliverToDropped"]).toBe("studio/parent9");
    expect(dropped?.data["reason"]).toBe("federation disabled");
  });

  it("forwarded message.meta.costUsd carries the child's accumulated cost (Phase 1 field preserved)", async () => {
    const forwards: Array<{ message: MailboxMessage }> = [];
    const { sup } = makeFedSupervisor([HAPPY], (t, m) => forwards.push({ message: m }));
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "studio/parent1" });
    await sup.waitFor(rec.agentId, 1000);
    expect(forwards[0]!.message.meta).toEqual({ costUsd: 0.01 });
  });

  // --- Phase-5 deferred-must: secrets must never cross the trust boundary (spec §6) ---
  it("redacts a known injected secret out of resultText before it crosses the forward seam, but keeps the raw record untouched", async () => {
    const secretScenario: FakeStep[] = [{ end: { resultText: "leaked value: tok-second embedded here", costUsd: 0.02 } }];
    const forwards: Array<{ message: MailboxMessage }> = [];
    const { sup } = makeFedSupervisor([secretScenario], (t, m) => forwards.push({ message: m }));
    // account "second" (helpers.ts CFG) resolves via keychain to "tok-second" and pushes it into
    // supervisor.secrets — the exact injected-credential list `redact()` scrubs against.
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "second", isolation: "none", deliverTo: "studio/parent1" });
    const final = await sup.waitFor(rec.agentId, 1000);
    expect(forwards.length).toBe(1);
    expect(forwards[0]!.message.text).not.toContain("tok-second");
    expect(forwards[0]!.message.text).toContain("[REDACTED]");
    expect(final.resultText).toContain("tok-second");   // raw record field stays unscrubbed (Phase 1 local-trust behavior)
  });

  it("redact on secret-free text is a no-op (forwarded text is unchanged when nothing matches)", async () => {
    const forwards: Array<{ message: MailboxMessage }> = [];
    const { sup } = makeFedSupervisor([HAPPY], (t, m) => forwards.push({ message: m }));
    const rec = await sup.spawn({ prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "studio/parent1" });
    await sup.waitFor(rec.agentId, 1000);
    expect(forwards[0]!.message.text).toBe("child done");
  });
});
