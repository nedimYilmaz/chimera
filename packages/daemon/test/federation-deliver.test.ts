import { describe, it, expect } from "vitest";
import { makeFederatedPair, until } from "./fed-rig.js";

describe("cross-engine deliverTo (MVP DoD #4)", () => {
  it("delivers a remote child result into the caller-side mailbox, duplicate-safe", async () => {
    const pair = await makeFederatedPair();
    const rec = await pair.a.engine.handle("agent.spawn", {
      spec: { prompt: "build it", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "caller1" },
      engine: "studio",
    }) as { agentId: string };
    expect(rec.agentId.startsWith("studio/")).toBe(true);

    await until(() => pair.a.engine.mailboxes.pending("caller1").length > 0);
    const inbox = pair.a.engine.mailboxes.pending("caller1");
    expect(inbox.length).toBe(1);
    expect(inbox[0]!.kind).toBe("child_result");
    expect(inbox[0]!.text).toContain("fake:build it");                 // FakeAgentBackend default result, computed ON B
    expect(inbox[0]!.engineId).toBe("studio");                          // authenticated origin
    expect(inbox[0]!.from.startsWith("studio/")).toBe(true);

    // duplicate forward (link retry replay) must dedup on the sender-assigned id
    await pair.a.engine.handlePeer("studio", "mailbox.forward", { agentId: "caller1", message: {
      id: inbox[0]!.id, ts: inbox[0]!.ts, from: inbox[0]!.from, kind: "child_result", text: inbox[0]!.text, engineId: "studio",
    } });
    expect(pair.a.engine.mailboxes.pending("caller1").length).toBe(1);  // still exactly one
    await pair.stop();
  }, 20_000);

  it("parks the forward during an A-side outage and replays it on reconnect", async () => {
    const pair = await makeFederatedPair();
    await until(() => pair.b.engine.federation!.peersStatus()[0]!.state === "connected");
    await pair.a.server.close();                                        // A's federation server dies (partition injection)
    await until(() => pair.b.engine.federation!.peersStatus()[0]!.state === "partitioned");

    const rec = await pair.b.engine.handle("agent.spawn", {             // spawned ON B locally; result must flow B->A
      spec: { prompt: "offline work", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "mbp/caller1" },
    }) as { agentId: string };
    await pair.b.engine.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 5000 });
    await until(() => pair.b.engine.federation!.peersStatus()[0]!.outboxPending === 1);   // parked, not lost, not local
    expect(pair.a.engine.mailboxes.pending("caller1")).toEqual([]);

    await pair.a.restartServer();                                       // reconnect -> outbox replay
    await until(() => pair.b.engine.federation!.peersStatus()[0]!.outboxPending === 0, 10_000);
    await until(() => pair.a.engine.mailboxes.pending("caller1").length === 1);
    expect(pair.a.engine.mailboxes.pending("caller1")[0]!.text).toContain("fake:offline work");
    await pair.stop();
  }, 25_000);
});
