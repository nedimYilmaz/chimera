import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { makeSupervisor } from "./helpers.js";

// PARITY WS-B: a `slash:true` user_message is a real SDK slash command and must reach the
// backend VERBATIM (leading "/"), skipping the usual "[from …] " prefix so the SDK can
// interpret it. The flag rides the mailbox envelope, so FIFO/outbox ordering is preserved.
describe("AgentSupervisor: WS-B agent-routed slash delivery", () => {
  // Intercept handle.send so we can assert the EXACT string delivered to the backend.
  function interceptSends(sup: unknown, agentId: string): string[] {
    const sent: string[] = [];
    const handles = (sup as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(agentId)!;
    handles.set(agentId, { ...real, send: async (t: string) => { sent.push(t); } });
    return sent;
  }

  it("delivers a slash:true message VERBATIM (no '[from tui] ' prefix)", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const sent = interceptSends(sup, rec.agentId);

    await sup.send(rec.agentId, "/compact keep the summary", "tui", undefined, true);
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual(["/compact keep the summary"]);   // leading "/" survives; no prefix
  });

  it("delivers slash:false (and the default) with the usual '[from …] ' prefix", async () => {
    const { sup } = makeSupervisor([[{ awaitSend: true }, { awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const sent = interceptSends(sup, rec.agentId);

    await sup.send(rec.agentId, "/looks-like-a-command", "tui", undefined, false);  // explicit false
    await sup.send(rec.agentId, "plain hello", "tui");                              // default (omitted)
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toEqual(["[from tui] /looks-like-a-command", "[from tui] plain hello"]);
  });

  it("still appends the delivered status record for a slash message (cross-client transcript)", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    interceptSends(sup, rec.agentId);

    await sup.send(rec.agentId, "/model opus", "tui", undefined, true);
    await new Promise((r) => setTimeout(r, 0));

    const delivered = new EventLog(dir).tail(rec.agentId, 50)
      .find((e) => e.kind === "status" && (e.data as Record<string, unknown>)["delivered"] === true);
    expect(delivered).toBeTruthy();
    // The record carries the RAW text (verbatim), not the prefixed form.
    expect((delivered!.data as Record<string, unknown>)["text"]).toBe("/model opus");
    expect((delivered!.data as Record<string, unknown>)["from"]).toBe("tui");
  });

  it("preserves FIFO order when slash and non-slash messages interleave in one batch", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    const sent = interceptSends(sup, rec.agentId);

    // Enqueue a mixed batch directly, then trigger one deliverBatch drain.
    const mb = new MailboxStore(dir);
    mb.enqueue(rec.agentId, { from: "tui", kind: "user_message", text: "/one", slash: true });
    mb.enqueue(rec.agentId, { from: "tui", kind: "user_message", text: "two" });
    mb.enqueue(rec.agentId, { from: "tui", kind: "user_message", text: "/three", slash: true });
    (sup as unknown as { deliverPending(id: string): void }).deliverPending(rec.agentId);
    await new Promise((r) => setTimeout(r, 0));

    // Order preserved; only the slash rows skip the prefix.
    expect(sent).toEqual(["/one", "[from tui] two", "/three"]);
  });

  it("preserves the slash flag when a mid-batch send failure re-enqueues the tail", async () => {
    const { sup, dir } = makeSupervisor([[{ awaitSend: true }, { end: { resultText: "-" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });

    let calls = 0;
    const handles = (sup as unknown as { handles: Map<string, { send(t: string): Promise<void> }> }).handles;
    const real = handles.get(rec.agentId)!;
    // First send succeeds, second rejects -> the failed message + tail re-enqueue (from the failed index).
    handles.set(rec.agentId, { ...real, send: async () => { calls++; if (calls === 2) throw new Error("boom"); } });

    const mb = new MailboxStore(dir);
    mb.enqueue(rec.agentId, { from: "tui", kind: "user_message", text: "/first", slash: true });
    mb.enqueue(rec.agentId, { from: "tui", kind: "user_message", text: "/second", slash: true });   // this one fails
    (sup as unknown as { deliverPending(id: string): void }).deliverPending(rec.agentId);
    await new Promise((r) => setTimeout(r, 0));

    // The re-enqueued "/second" must still carry slash:true so its retry stays a command.
    const pending = new MailboxStore(dir).pending(rec.agentId);
    expect(pending.map((m) => m.text)).toEqual(["/second"]);
    expect(pending[0]!.slash).toBe(true);
  });
});
