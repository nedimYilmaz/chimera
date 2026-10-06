import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { AgentRecord } from "@chimera/core/supervisor";
import { MailboxStore } from "@chimera/core/mailbox";
import { makeSupervisor } from "./helpers.js";
import { waitUntil } from "./coord-helpers.js";

// LATE-MESSAGE-RESUME: a user_message that lands in an agent's mailbox right as it settles
// (deliverPending's `state !== "running"` guard bails, or a closing-stream send() gets
// re-enqueued by deliverBatch's catch — see backends/claude.ts's `finally { input.close() }`
// and backends/codex.ts's `ended` flag) used to sit there forever: the agent goes "done" and
// NOTHING ever rechecks the mailbox. checkPendingOnSettle (supervisor.ts) closes that gap: a
// "done" settle with a live session auto-resumes the SAME agentId (mirrors setModel's
// kill+respawn-with-resume), and the resumed run's agent_started -> deliverPending hook drains
// the stranded message into the fresh handle.
//
// Every test drives checkPendingOnSettle directly (mirroring this file's own castDeliverPending
// convention elsewhere in the suite) rather than racing FakeAgentBackend's synchronous,
// non-racy step execution against real timers: seeding the mailbox BEFORE a scenario's
// agent_started fires gets vacuumed up immediately by the (also new, and correct) agent_started
// -> deliverPending hook, which defeats the "stranded at settle" precondition this file needs to
// set up deterministically.
const castCheck = (s: unknown) => s as unknown as { checkPendingOnSettle(r: AgentRecord): void };

describe("AgentSupervisor: LATE-MESSAGE-RESUME (checkPendingOnSettle)", () => {
  it("a done agent with a pending user_message and a live session auto-resumes and delivers it", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "s1" } } }, { end: { resultText: "first" } }],
      [{ emit: { kind: "agent_started", data: { sessionId: "s1" } } }, { awaitSend: true }, { end: { resultText: "responded" } }],
    ];
    const { sup, fake, dir, events } = makeSupervisor(scenarios);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-1" });
    await waitUntil(() => sup.status("agent-1").state === "done");

    new MailboxStore(dir).enqueue("agent-1", { from: "tui", kind: "user_message", text: "are you still there?" });
    castCheck(sup).checkPendingOnSettle(sup.status("agent-1"));

    await waitUntil(() => fake.spawns.length >= 2 && sup.status("agent-1").state === "done");

    const respawned = fake.spawns[1];
    expect(respawned?.resume).toBe("s1");
    expect(respawned?.resumeOnly).toBe(true);
    expect(sup.status("agent-1").resultText).toBe("responded");

    // the resumed run actually received the stranded message (fake's awaitSend echoes it back;
    // deliverBatch prefixes the text with "[from <sender>] " for every non-slash delivery).
    const tail = events.tail("agent-1", 100);
    expect(tail.some((e) => e.kind === "message_complete" && e.data["text"] === "echo:are you still there?")).toBe(true);
  });

  it("a done agent with pending mail but no sessionId emits an undelivered-message status event instead of resuming", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "first" } }],
    ];
    const { sup, fake, dir, events } = makeSupervisor(scenarios);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-2" });
    await waitUntil(() => sup.status("agent-2").state === "done");
    expect(sup.status("agent-2").sessionId).toBeUndefined();

    new MailboxStore(dir).enqueue("agent-2", { from: "tui", kind: "user_message", text: "hello?" });
    castCheck(sup).checkPendingOnSettle(sup.status("agent-2"));
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);            // no respawn attempted
    const tail = events.tail("agent-2", 100);
    expect(tail.some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true)).toBe(true);
  });

  it("a failed agent with pending mail emits an undelivered-message status event and does not resume", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "s1" } } }, { fail: { message: "boom, unrecoverable" } }],
    ];
    const { sup, fake, dir, events } = makeSupervisor(scenarios);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-3" });
    await waitUntil(() => sup.status("agent-3").state === "failed");

    new MailboxStore(dir).enqueue("agent-3", { from: "tui", kind: "user_message", text: "hello?" });
    castCheck(sup).checkPendingOnSettle(sup.status("agent-3"));
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);            // no respawn attempted
    const tail = events.tail("agent-3", 100);
    expect(tail.some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true)).toBe(true);
  });

  // PLAN-HOOKS.md §4.3 gap fix (a): kill() now calls checkPendingOnSettle itself so a killed
  // agent's stranded mail surfaces instead of vanishing — but it must NEVER resume (an explicit
  // kill is deliberate and must never be silently undone by leftover mail), and unlike done/
  // failed it surfaces EVERY pending kind (not just user_message) since nothing will ever drain
  // this mailbox again.
  it("a killed agent with pending mail emits an undelivered-message status event and does NOT resume", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "s1" } } }, { awaitSend: true }],
    ];
    const { sup, fake, dir, events } = makeSupervisor(scenarios);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-4" });
    await new Promise((r) => setTimeout(r, 20));   // let agent_started settle (mailbox still empty here)
    new MailboxStore(dir).enqueue("agent-4", { from: "tui", kind: "user_message", text: "hello?" });

    await sup.kill("agent-4");
    await new Promise((r) => setTimeout(r, 20));

    expect(sup.status("agent-4").state).toBe("killed");
    expect(fake.spawns).toHaveLength(1);            // no respawn attempted
    const tail = events.tail("agent-4", 100);
    expect(tail.some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true)).toBe(true);
  });

  it("a killed agent's stranded child_result (not just user_message) is also surfaced, unlike a done/failed settle", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "s1" } } }, { awaitSend: true }],
    ];
    const { sup, fake, dir, events } = makeSupervisor(scenarios);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-4b" });
    await new Promise((r) => setTimeout(r, 20));
    new MailboxStore(dir).enqueue("agent-4b", { from: "child-1", kind: "child_result", text: "child done" });

    await sup.kill("agent-4b");
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);
    const tail = events.tail("agent-4b", 100);
    expect(tail.some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true)).toBe(true);
  });

  it("a child_result stranded in the mailbox at settle never triggers a resume or an undelivered event", async () => {
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "s1" } } }, { end: { resultText: "first" } }],
    ];
    const { sup, fake, dir, events } = makeSupervisor(scenarios);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-5" });
    await waitUntil(() => sup.status("agent-5").state === "done");

    new MailboxStore(dir).enqueue("agent-5", { from: "child-1", kind: "child_result", text: "child done" });
    castCheck(sup).checkPendingOnSettle(sup.status("agent-5"));
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(1);            // no respawn attempted
    const tail = events.tail("agent-5", 100);
    expect(tail.some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true)).toBe(false);
  });

  it("the SAME pending message id seen on two settle-checks degrades to an undelivered event instead of respawning twice", async () => {
    // Only one scenario queued for the INITIAL spawn — the fire-and-forget auto-resume below
    // falls back to FakeAgentBackend's default scenario, which is irrelevant here: both
    // checkPendingOnSettle calls run synchronously, back-to-back, before that resume's
    // (setTimeout-deferred) agent_started ever gets a chance to drain the mailbox.
    const scenarios: FakeStep[][] = [
      [{ emit: { kind: "agent_started", data: { sessionId: "s1" } } }, { end: { resultText: "first" } }],
    ];
    const { sup, fake, dir, events } = makeSupervisor(scenarios);
    await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" }, { agentId: "agent-6" });
    await waitUntil(() => sup.status("agent-6").state === "done");

    new MailboxStore(dir).enqueue("agent-6", { id: "stuck-1", from: "tui", kind: "user_message", text: "still there?" });
    // a plain snapshot, decoupled from the LIVE record the first call's fire-and-forget respawn
    // mutates (it flips state to "running" synchronously) — both calls must see state:"done" with
    // the mailbox still holding "stuck-1" for the guard's id-match to engage on the second call.
    const snapshot = { ...sup.status("agent-6") };
    castCheck(sup).checkPendingOnSettle(snapshot);   // 1st: resumes (spawns[1])
    castCheck(sup).checkPendingOnSettle(snapshot);   // 2nd: SAME pending id -> guard fires, no 2nd respawn
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.spawns).toHaveLength(2);               // no infinite respawn loop
    const tail = events.tail("agent-6", 200);
    expect(tail.some((e) => e.kind === "status" && e.data["undeliveredMessage"] === true)).toBe(true);
  });
});
