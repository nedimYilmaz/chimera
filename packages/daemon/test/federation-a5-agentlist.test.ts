import { describe, it, expect } from "vitest";
import { makeFederatedPair } from "./fed-rig.js";

// §A5 remote-spawn local-row gap: engine.ts agent.list must merge the FederationManager record
// cache so a fresh remote spawn (engine=<peer>) yields a local ⇅ @engine row on the VERY FIRST
// window — before any peer-relayed event arrives. Additive, de-duped by agentId (local wins),
// and credential-free (D5: cached records carry account NAMES only).
describe("§A5 agent.list merges the federation record cache", () => {
  it("shows a fresh remote spawn as an engine-stamped row BEFORE any event/status poll", async () => {
    const pair = await makeFederatedPair({
      scenariosB: [[{ awaitSend: true }, { end: { resultText: "done" } }]],
    });
    try {
      const rec = await pair.a.engine.handle("agent.spawn", {
        spec: { prompt: "remote-row", cwd: "/tmp", account: "main", isolation: "none" }, engine: "studio",
      }) as { agentId: string };
      expect(rec.agentId).toMatch(/^studio\//);   // qualified <engine>/<localId>

      // IMMEDIATELY — no agent.status/agent.wait, no relayed event — the row is present locally.
      const list = await pair.a.engine.handle("agent.list", {}) as Array<{ agentId: string }>;
      const row = list.find((r) => r.agentId === rec.agentId);
      expect(row).toBeTruthy();
      // The UI reducer stamps AgentView.engine = parseAgentAddress(agentId).engineId → "studio".
      expect(row!.agentId.split("/")[0]).toBe("studio");
    } finally {
      await pair.stop();
    }
  });

  it("de-dupes a same-id local agent (local authoritative)", async () => {
    const pair = await makeFederatedPair({
      scenariosA: [[{ awaitSend: true }, { end: { resultText: "local" } }]],
    });
    try {
      const local = await pair.a.engine.handle("agent.spawn", {
        spec: { prompt: "local-row", cwd: "/tmp", account: "main", isolation: "none" },
      }) as { agentId: string };
      // Force a collision: cache a remote record whose agentId equals the local one (the
      // "somehow both" case). Local must win — exactly one row, projecting the LIVE local state.
      pair.a.engine.federation!.cacheRecord(local.agentId, {
        agentId: local.agentId, state: "failed", accountName: "ghost", provider: "claude",
        depth: 0, treeId: "t", createdAt: 0, principal: "peer:studio", attempts: [], costUsd: 0,
      });
      const list = await pair.a.engine.handle("agent.list", {}) as Array<{ agentId: string; state: string; accountName: string }>;
      const rows = list.filter((r) => r.agentId === local.agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.accountName).toBe("main");   // local record, not the "ghost" cache entry
      expect(rows[0]!.state).not.toBe("failed");
    } finally {
      await pair.stop();
    }
  });

  it("does NOT resurrect a killed remote agent (kill evicts the cache; no phantom row)", async () => {
    const pair = await makeFederatedPair({
      // awaitSend keeps the remote agent running until we kill it (never reaches end).
      scenariosB: [[{ awaitSend: true }, { end: { resultText: "unreached" } }]],
    });
    try {
      const rec = await pair.a.engine.handle("agent.spawn", {
        spec: { prompt: "kill-me", cwd: "/tmp", account: "main", isolation: "none" }, engine: "studio",
      }) as { agentId: string };
      // Present before the kill (the A5 first-window row).
      const before = await pair.a.engine.handle("agent.list", {}) as Array<{ agentId: string }>;
      expect(before.some((r) => r.agentId === rec.agentId)).toBe(true);

      await pair.a.engine.handle("agent.kill", { agentId: rec.agentId });

      // Immediately — no further status poll — the killed remote must be gone, not lingering with
      // its last-cached state. This is the exact resurrection the A5 merge could otherwise cause.
      const after = await pair.a.engine.handle("agent.list", {}) as Array<{ agentId: string }>;
      expect(after.some((r) => r.agentId === rec.agentId)).toBe(false);
    } finally {
      await pair.stop();
    }
  });

  it("drops phantom rows for an unpinned peer (removePeer clears its cached records)", async () => {
    const pair = await makeFederatedPair({
      scenariosB: [[{ awaitSend: true }, { end: { resultText: "unreached" } }]],
    });
    try {
      const rec = await pair.a.engine.handle("agent.spawn", {
        spec: { prompt: "orphan-me", cwd: "/tmp", account: "main", isolation: "none" }, engine: "studio",
      }) as { agentId: string };
      const before = await pair.a.engine.handle("agent.list", {}) as Array<{ agentId: string }>;
      expect(before.some((r) => r.agentId === rec.agentId)).toBe(true);

      // Unpair the peer from federation. Its cached AgentRecords must not keep surfacing.
      pair.a.engine.federation!.removePeer("studio");

      const after = await pair.a.engine.handle("agent.list", {}) as Array<{ agentId: string }>;
      expect(after.some((r) => r.agentId === rec.agentId)).toBe(false);
    } finally {
      await pair.stop();
    }
  });

  it("redaction sweep: no injected credential leaks through the agent.list response (D5)", async () => {
    const pair = await makeFederatedPair({
      // "second" injects ANTHROPIC_AUTH_TOKEN=tok-second ON B; a result echoing it must be
      // scrubbed before it ever crosses the peer link into A's record cache.
      scenariosB: [[{ end: { resultText: "leak attempt tok-second" } }]],
    });
    try {
      const rec = await pair.a.engine.handle("agent.spawn", {
        spec: { prompt: "leaky", cwd: "/tmp", account: "second", isolation: "none" }, engine: "studio",
      }) as { agentId: string };
      // Poll to done so the (scrubbed) resultText lands in A's federation record cache.
      const t0 = Date.now();
      let state = "";
      while (state !== "done") {
        if (Date.now() - t0 > 8000) throw new Error("timeout");
        state = (await pair.a.engine.handle("agent.status", { agentId: rec.agentId }) as { state: string }).state;
        if (state !== "done") await new Promise((r) => setTimeout(r, 15));
      }
      const list = await pair.a.engine.handle("agent.list", {});
      const blob = JSON.stringify(list);
      expect(blob).toContain(rec.agentId);        // the remote row is present…
      expect(blob).not.toContain("tok-second");   // …but no injected credential value
      // General credential-shape sweep (invariant: none are ever carried on a record row).
      expect(blob).not.toMatch(/sk-(ant|proj)-/);
      expect(blob).not.toMatch(/tskey-/);
    } finally {
      await pair.stop();
    }
  });
});
