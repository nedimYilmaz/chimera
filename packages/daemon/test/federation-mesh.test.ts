import { describe, it, expect } from "vitest";
import { makeFederatedMesh } from "./fed-rig.js";

// D8 (multi-peer mesh, coverage C8 · F10): N peers = N INDEPENDENT pairwise links. Every pair
// runs its own invite/join (A-B, A-C, B-C = 3 pairings). NO transitive relay — B cannot forward
// to C on A's behalf (the mailbox.forward bare-target rule). peers[] carries N entries.

describe("D8 multi-peer mesh (A · B · C)", () => {
  it("all three pairs pair via invite/join; every engine ends with 2 peers", async () => {
    const mesh = await makeFederatedMesh(["A", "B", "C"]);
    for (const [x, y] of [["A", "B"], ["A", "C"], ["B", "C"]] as const) {
      const res = await mesh.pair(x, y) as { steps: Array<{ ok: boolean }>; paired: string | null };
      expect(res.paired).toBe(x);
      expect(res.steps.every((s) => s.ok)).toBe(true);
    }
    // each engine now sees exactly its two peers, all connected
    for (const node of mesh.nodes) {
      const peers = node.engine.federation!.peersStatus();
      expect(peers.map((p) => p.engineId).sort()).toEqual(["A", "B", "C"].filter((id) => id !== node.id));
      expect(peers.every((p) => p.state === "connected")).toBe(true);
    }
    // daemon.status peers[] carries N entries on every node
    for (const node of mesh.nodes) {
      const st = await node.engine.handle("daemon.status", {}) as { peers: unknown[] };
      expect(st.peers.length).toBe(2);
    }
    await mesh.stop();
  }, 30_000);

  it("NO transitive relay: A → (via B) → C is refused with a protocol error (bare-target rule)", async () => {
    const mesh = await makeFederatedMesh(["A", "B", "C"]);
    await mesh.pair("A", "B");   // A and B are paired; A and C are NOT
    const a = mesh.get("A");

    // A tries to forward to a C-qualified target THROUGH B's peer link. B rejects a qualified
    // agentId over a peer link (no transitive relay) with a protocol error.
    await expect(a.engine.federation!.call("B", "mailbox.forward", {
      agentId: "C/some-agent",
      message: { id: "m1", ts: Date.now(), from: "A/orchestrator", kind: "signal", text: "relay me", engineId: "A" },
    })).rejects.toMatchObject({ code: "protocol" });

    // And A cannot reach C at all — they never paired (default deny, no relay path exists).
    await expect(a.engine.handle("agent.status", { agentId: "C/ghost" })).rejects.toMatchObject({ code: "protocol" });
    await mesh.stop();
  }, 30_000);
});
