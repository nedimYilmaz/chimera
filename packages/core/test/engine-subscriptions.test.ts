import { describe, it, expect, vi } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { Subscription } from "@chimera/protocol";
import { makeEngineHome, fakeExec } from "./helpers.js";
import { makeFedHome, makeIdentity } from "./fed-helpers.js";

const backends = () => new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]);

describe("Engine sub.* RPC family end-to-end (HOOK-2, PLAN-HOOKS.md §2)", () => {
  it("sub.create dispatches through the engine onto the registry and returns a stamped Subscription", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const sub = await e.handle("sub.create", { subscriberId: "a1", topic: "queue.drained", once: false, wake: "deliver" }) as Subscription;
    expect(sub.id).toBeTruthy();
    expect(sub.topic).toBe("queue.drained");
    expect(sub.coalesceMs).toBe(5000);   // registry applied the durable conditional default
    // and it is now visible on the engine's own registry
    expect(e.subscriptions.list("a1")).toHaveLength(1);
  });

  it("sub.list returns the caller's live subscriptions", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("sub.create", { subscriberId: "a1", topic: "queue.drained", once: false, wake: "deliver" });
    await e.handle("sub.create", { subscriberId: "a1", topic: "agent.settled", once: false, wake: "deliver" });
    const list = await e.handle("sub.list", { subscriberId: "a1" }) as Subscription[];
    expect(list.map((s) => s.topic).sort()).toEqual(["agent.settled", "queue.drained"]);
  });

  it("sub.remove removes the caller's own subscription and reports { removed: true }", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const sub = await e.handle("sub.create", { subscriberId: "a1", topic: "queue.drained", once: false, wake: "deliver" }) as Subscription;
    expect(await e.handle("sub.remove", { subscriberId: "a1", id: sub.id })).toEqual({ removed: true });
    expect(await e.handle("sub.list", { subscriberId: "a1" })).toEqual([]);
  });

  it("sub.remove refuses to remove another subscriber's subscription", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    const sub = await e.handle("sub.create", { subscriberId: "owner", topic: "queue.drained", once: false, wake: "deliver" }) as Subscription;
    expect(await e.handle("sub.remove", { subscriberId: "intruder", id: sub.id })).toEqual({ removed: false });
    expect(e.subscriptions.list("owner")).toHaveLength(1);
  });

  it("a created subscription delivers a signal end-to-end when a matching event flows through the engine's EventLog", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: backends() });
    await e.handle("sub.create", { subscriberId: "watcher", topic: "queue.drained", once: true, coalesceMs: 0, wake: "deliver" });

    // Drive a real event through the same EventLog the registry subscribes to.
    e.events.append({ agentId: "queue:q1", kind: "queue_drained", data: { queue: "q1" } });

    const msgs = e.mailboxes.pending("watcher");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.kind).toBe("signal");
    expect(msgs[0]?.text).toContain("[signal:queue.drained]");
    expect(e.subscriptions.list("watcher")).toHaveLength(0);   // once:true auto-removed after firing
  });
});

describe("Engine mailbox.forward wakes an idle running subscriber (PLAN-HOOKS.md §4.3 gap fix)", () => {
  const PEER = { engineId: "mbp", publicKey: makeIdentity().identity.publicKey, socketPath: "/tmp/unused.sock" };

  it("calls supervisor.wakeMailbox after enqueuing a federated forward", async () => {
    const home = makeFedHome({ id: "studio", peers: [PEER] });
    const engine = new Engine({ home, backends: backends(), exec: fakeExec });
    const wake = vi.spyOn(engine.supervisor, "wakeMailbox");

    const message = { id: "m-1", ts: 1, from: "mbp/child", kind: "child_result" as const, text: "done", engineId: "mbp" };
    const res = await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a1", message });

    expect(res).toMatchObject({ ok: true });
    expect(engine.mailboxes.pending("a1")).toHaveLength(1);
    expect(wake).toHaveBeenCalledWith("a1");
  });

  it("does NOT re-wake on a deduped re-forward (the enqueue short-circuits before wakeMailbox)", async () => {
    const home = makeFedHome({ id: "studio", peers: [PEER] });
    const engine = new Engine({ home, backends: backends(), exec: fakeExec });
    const message = { id: "m-dup", ts: 1, from: "mbp/child", kind: "child_result" as const, text: "done", engineId: "mbp" };
    await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a2", message });

    const wake = vi.spyOn(engine.supervisor, "wakeMailbox");
    const res = await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a2", message });
    expect(res).toMatchObject({ ok: true, deduped: true });
    expect(wake).not.toHaveBeenCalled();
  });
});
