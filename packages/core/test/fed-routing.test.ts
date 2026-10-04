import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { EngineIdentity } from "@chimera/core/federation/identity";
import { fakeExec, makeEngineHome } from "./helpers.js";
import { makeFedHome, makeIdentity, startFakePeer } from "./fed-helpers.js";

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

async function rig(respond?: (method: string, params: unknown) => unknown) {
  const remote = makeIdentity();
  const preHome = makeFedHome({ id: "mbp", peers: [] });               // create home first to own an identity
  const myIdentity = EngineIdentity.loadOrCreate(preHome);
  const fake = await startFakePeer({ engineId: "studio", identity: remote.identity, peerKeys: new Map([["mbp", myIdentity.publicKey]]), respond });
  const home = makeFedHome({ id: "mbp", peers: [{ engineId: "studio", publicKey: remote.identity.publicKey, socketPath: fake.socketPath }] });
  // reuse the SAME identity dir: copy key into the new home
  const { copyFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  copyFileSync(join(preHome, "engine_key"), join(home, "engine_key"));
  const engine = new Engine({
    home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
    exec: fakeExec, fedReconnectBaseMs: 10, fedHeartbeatMs: 100,
  });
  return { engine, fake, remote };
}

describe("requester-side federation routing", () => {
  it("proxies engine-targeted spawn with deliverTo egress rewrite + qualified ids on status/send/kill", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const { engine, fake } = await rig((method, params) => {
      seen.push({ method, params });
      if (method === "agent.spawn") return { agentId: "remote-1", state: "running", costUsd: 0, principal: "peer:mbp" };
      if (method === "agent.status") return { agentId: "remote-1", state: "running", costUsd: 0 };
      return { ok: true };
    });
    // Sync point: the link is still mid-handshake immediately after construction (PeerLink.request()
    // fail-fasts on any non-"connected" state, by design — Task 9, locked). Wait for the handshake to
    // complete before the first federated call, exactly as every fed-manager.test.ts case does.
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    const rec = await engine.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "caller1" },
      engine: "studio",
    }) as { agentId: string };
    expect(rec.agentId).toBe("studio/remote-1");                        // qualified for the caller
    const sentSpawn = seen.find((s) => s.method === "agent.spawn")!.params as { spec: { deliverTo: string }; spawnId: string };
    expect(sentSpawn.spec.deliverTo).toBe("mbp/caller1");               // "local" alias rewritten at egress
    expect(sentSpawn.spawnId).toBeTruthy();                             // idempotency key attached

    expect(await engine.handle("agent.status", { agentId: "studio/remote-1" })).toMatchObject({ state: "running" });
    await engine.handle("agent.send", { agentId: "studio/remote-1", text: "hi", from: "caller1" });
    await engine.handle("agent.kill", { agentId: "studio/remote-1" });
    for (const m of ["agent.status", "agent.send", "agent.kill"])
      expect(seen.find((s) => s.method === m)!.params).toMatchObject({ agentId: "remote-1" });   // bare on the wire

    await expect(engine.handle("agent.wait", { agentId: "studio/remote-1" })).rejects.toMatchObject({ code: "protocol" });
    expect(await engine.handle("accounts.list", { engine: "studio" })).toBeTruthy();
    await engine.federation!.stop(); await fake.close();
  });

  it("daemon.status reports engineId and peers; local spawns are untouched", async () => {
    const { engine, fake } = await rig();
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    const st = await engine.handle("daemon.status", {}) as { engineId: string; peers: Array<{ engineId: string; state: string }> };
    expect(st.engineId).toBe("mbp");
    expect(st.peers[0]).toMatchObject({ engineId: "studio", state: "connected" });
    const local = await engine.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
    expect(local.agentId).not.toContain("/");                           // bare id: nothing federated locally
    await engine.federation!.stop(); await fake.close();
  });

  it("degrades agent.status to an unreachable stale snapshot on partition", async () => {
    const { engine, fake } = await rig((method) =>
      method === "agent.spawn" ? { agentId: "r9", state: "running", costUsd: 0 } : { agentId: "r9", state: "running", costUsd: 0 });
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");   // see sync-point note above
    const rec = await engine.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none" }, engine: "studio" }) as { agentId: string };
    await fake.close();                                                 // partition injection
    await until(() => engine.federation!.peersStatus()[0]!.state === "partitioned");
    const st = await engine.handle("agent.status", { agentId: rec.agentId }) as { state: string; stale: boolean };
    expect(st.state).toBe("unreachable");                               // never "failed" — link loss kills nothing
    expect(st.stale).toBe(true);
    await expect(engine.handle("agent.result", { agentId: rec.agentId })).rejects.toMatchObject({ code: "peer-unreachable" });
    await engine.federation!.stop();
  }, 15_000);

  // ---------- additional branch/edge coverage beyond the brief's 3 mandated tests ----------

  it("a qualified id naming THIS engine itself bypasses federation routing (addr.engineId === this.engineId)", async () => {
    const { engine, fake } = await rig();
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    // "mbp" IS this engine's own id — NOT routed to the peer link (which only knows "studio").
    // If this were mis-routed, federation.call("mbp", ...) would throw {code:"protocol", message:
    // 'unknown peer engine "mbp"'}; falling through to the local switch instead throws
    // UnknownAgentError ({code:"protocol", message: "unknown agent mbp/ghost"}) — distinguishable by message.
    await expect(engine.handle("agent.status", { agentId: "mbp/ghost" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("unknown agent") });
    await engine.federation!.stop(); await fake.close();
  });

  it("qualified-id proxy rejects with protocol when federation is not configured (no engine.id in config)", async () => {
    const home = makeEngineHome();   // no engine.id / federation block -> engine.federation === null
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    expect(engine.federation).toBeNull();
    await expect(engine.handle("agent.status", { agentId: "studio/x" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("federation is not configured") });
  });

  it("rejects a qualified id for a method outside the federated allowlist (agent.close)", async () => {
    const { engine, fake } = await rig();
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    await expect(engine.handle("agent.close", { agentId: "studio/x" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("does not accept engine-qualified ids") });
    await engine.federation!.stop(); await fake.close();
  });

  it("agent.status on a NEVER-cached qualified id re-throws peer-unreachable as-is when partitioned (no stale fallback)", async () => {
    const { engine, fake } = await rig();
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    await fake.close();
    await until(() => engine.federation!.peersStatus()[0]!.state === "partitioned");
    await expect(engine.handle("agent.status", { agentId: "studio/nevercached" }))
      .rejects.toMatchObject({ code: "peer-unreachable" });
    await engine.federation!.stop();
  });

  it("a real (non-unreachable) peer-side error on a qualified-id proxy call re-throws unchanged", async () => {
    const { engine, fake } = await rig((method) => {
      if (method === "agent.send") throw { code: "guardrail", message: "denied by peer policy" };
      return { ok: true };
    });
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    await expect(engine.handle("agent.send", { agentId: "studio/x", text: "hi", from: "caller1" }))
      .rejects.toMatchObject({ code: "guardrail" });
    await engine.federation!.stop(); await fake.close();
  });

  it("proxies a successful agent.tail/agent.result on a qualified id without caching (only agent.status caches)", async () => {
    const { engine, fake } = await rig((method) =>
      method === "agent.result" ? { state: "done", text: "hi", costUsd: 0 } : { ok: true });
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    expect(await engine.handle("agent.tail", { agentId: "studio/x" })).toMatchObject({ ok: true });
    expect(await engine.handle("agent.result", { agentId: "studio/x" })).toMatchObject({ state: "done" });
    expect(engine.federation!.cachedRecord("studio/x")).toBeUndefined();   // only agent.status caches
    await engine.federation!.stop(); await fake.close();
  });

  it("agent.spawn with engine set to THIS engine's own id is a LOCAL spawn (bare id, no wire traffic)", async () => {
    const seen: string[] = [];
    const { engine, fake } = await rig((method) => { seen.push(method); return { ok: true }; });
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    const rec = await engine.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", isolation: "none" }, engine: "mbp",
    }) as { agentId: string };
    expect(rec.agentId).not.toContain("/");
    expect(seen).not.toContain("agent.spawn");                            // never hit the wire
    await engine.federation!.stop(); await fake.close();
  });

  it("agent.spawn to a different engine rejects with protocol when federation is not configured", async () => {
    const home = makeEngineHome();
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    await expect(engine.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", isolation: "none" }, engine: "studio",
    })).rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("federation is not configured") });
  });

  it("agent.spawn rejects a providerOptions credential-smuggle attempt BEFORE the wire (guardrail, on OUR side)", async () => {
    const seen: string[] = [];
    const { engine, fake } = await rig((method) => { seen.push(method); return { ok: true }; });
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    await expect(engine.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", account: "main", isolation: "none", providerOptions: { env: { X: "y" } } },
      engine: "studio",
    })).rejects.toMatchObject({ code: "guardrail" });
    expect(seen).not.toContain("agent.spawn");                            // rejected locally, never reached the peer
    await engine.federation!.stop(); await fake.close();
  });

  it("agent.spawn leaves an ALREADY-qualified deliverTo untouched (no double-qualification)", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const { engine, fake } = await rig((method, params) => {
      seen.push({ method, params });
      return { agentId: "remote-2", state: "running", costUsd: 0 };
    });
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    await engine.handle("agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", account: "main", isolation: "none", deliverTo: "otherengine/someid" },
      engine: "studio",
    });
    const sent = seen.find((s) => s.method === "agent.spawn")!.params as { spec: { deliverTo: string } };
    expect(sent.spec.deliverTo).toBe("otherengine/someid");               // already-qualified: not rewritten
    await engine.federation!.stop(); await fake.close();
  });

  it("accounts.list with engine set to THIS engine's own id returns the local registry (not a wire call)", async () => {
    const seen: string[] = [];
    const { engine, fake } = await rig((method) => { seen.push(method); return { ok: true }; });
    await until(() => (engine.federation!.peersStatus()[0]?.state ?? "") === "connected");
    const accounts = await engine.handle("accounts.list", { engine: "mbp" }) as Array<{ name: string }>;
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.map((a) => a.name).sort()).toEqual(["main", "second"]);
    expect(seen).not.toContain("accounts.list");
    await engine.federation!.stop(); await fake.close();
  });

  it("accounts.list to a different engine rejects with protocol when federation is not configured", async () => {
    const home = makeEngineHome();
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    await expect(engine.handle("accounts.list", { engine: "studio" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("federation is not configured") });
  });
});
