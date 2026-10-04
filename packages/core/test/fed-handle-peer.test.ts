import { describe, it, expect } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { fakeExec } from "./helpers.js";
import { makeFedHome, makeIdentity } from "./fed-helpers.js";

const HAPPY: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { end: { resultText: "remote done" } }];
const SLOW: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "x" } }];

function makeEngine(peers: Parameters<typeof makeFedHome>[0]["peers"], scenarios: FakeStep[][] = []) {
  const home = makeFedHome({ id: "studio", peers });
  const fake = new FakeAgentBackend(scenarios);
  const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", fake]]), exec: fakeExec });
  return { engine, fake, home };
}
const PEER = { engineId: "mbp", publicKey: makeIdentity().identity.publicKey, socketPath: "/tmp/unused.sock" };

describe("Engine federation surface", () => {
  it("exposes engineId and a names-only engine card", () => {
    const { engine } = makeEngine([PEER]);
    expect(engine.engineId).toBe("studio");
    const card = engine.engineCard();
    expect(card.features).toContain("federation.v1");
    expect(card.accounts).toEqual([{ name: "main", provider: "claude" }, { name: "second", provider: "claude" }]);
    expect(JSON.stringify(card)).not.toContain("authType");
    expect(engine.peerConfig("mbp")!.allowSpawn).toBe(false);
  });

  // ---------- additional coverage ----------

  it("engineCard().engineId echoes the configured engine.id verbatim (non-'local' case)", () => {
    const { engine } = makeEngine([PEER]);
    expect(engine.engineCard().engineId).toBe("studio");
  });

  it("engineCard().providers lists the registered backend keys", () => {
    const { engine } = makeEngine([PEER]);
    expect(engine.engineCard().providers).toEqual(["claude"]);
  });

  it("maps engineId 'local' (no engine.id configured) to 'unfederated' in the card, without changing engine.engineId itself", async () => {
    const { makeEngineHome } = await import("./helpers.js");
    const home = makeEngineHome();
    const engine = new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    expect(engine.engineId).toBe("local");
    expect(engine.engineCard().engineId).toBe("unfederated");
  });

  it("peerConfig returns undefined for an unconfigured engine id", () => {
    const { engine } = makeEngine([PEER]);
    expect(engine.peerConfig("nobody")).toBeUndefined();
  });

  it("peerConfigs returns every configured peer", () => {
    const OTHER = { engineId: "other", publicKey: makeIdentity().identity.publicKey, socketPath: "/tmp/other.sock" };
    const { engine } = makeEngine([PEER, OTHER]);
    expect(engine.peerConfigs().map((p) => p.engineId).sort()).toEqual(["mbp", "other"]);
  });

  it("peerConfigs returns an empty array when no peers are configured", () => {
    const { engine } = makeEngine([]);
    expect(engine.peerConfigs()).toEqual([]);
  });
});

describe("Engine.handlePeer authz boundary", () => {
  it("rejects unknown peers and non-allowlisted methods", async () => {
    const { engine } = makeEngine([PEER]);
    await expect(engine.handlePeer("stranger", "peer.status", {})).rejects.toMatchObject({ code: "peer-auth" });
    for (const m of ["daemon.stop", "subscribe", "agent.wait", "agent.permissionRespond", "team.create"])
      await expect(engine.handlePeer("mbp", m, {})).rejects.toMatchObject({ code: "protocol" });
  });

  it("answers peer.status and grant-filtered names-only accounts.list", async () => {
    const { engine } = makeEngine([{ ...PEER, accounts: ["second"] }]);
    expect(await engine.handlePeer("mbp", "peer.status", {})).toMatchObject({ engineId: "studio", protocolVersion: 1 });
    expect(await engine.handlePeer("mbp", "accounts.list", {})).toEqual([{ name: "second", provider: "claude" }]);
    const { engine: autoEngine } = makeEngine([{ ...PEER, accounts: "auto" as const }]);
    expect((await autoEngine.handlePeer("mbp", "accounts.list", {}) as unknown[]).length).toBe(2);
  });

  it("refuses qualified agentIds (no transitive relay)", async () => {
    const { engine } = makeEngine([PEER]);
    await expect(engine.handlePeer("mbp", "agent.status", { agentId: "attic/a1" })).rejects.toMatchObject({ code: "protocol" });
  });

  // ---------- additional coverage ----------

  it("checks the unknown-peer authz boundary BEFORE the method allowlist (peer-auth wins even for a bogus method)", async () => {
    await expect(makeEngine([PEER]).engine.handlePeer("stranger", "totally-bogus-method", {}))
      .rejects.toMatchObject({ code: "peer-auth" });
  });

  it("rejects the empty-string method for a known peer", async () => {
    const { engine } = makeEngine([PEER]);
    await expect(engine.handlePeer("mbp", "", {})).rejects.toMatchObject({ code: "protocol" });
  });

  it("accounts.list returns an empty array when the peer has no account grant (default [])", async () => {
    const { engine } = makeEngine([PEER]); // accounts defaults to []
    expect(await engine.handlePeer("mbp", "accounts.list", {})).toEqual([]);
  });

  it("peer.status counts agents across every state, not just running", async () => {
    const DONE: FakeStep[] = [{ end: { resultText: "d" } }];
    const FAILED: FakeStep[] = [{ fail: { message: "boom" } }];
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: "auto" as const, maxConcurrent: 10 }], [SLOW, DONE, FAILED]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const running = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "r1" }) as { agentId: string };
    const done = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "r2" }) as { agentId: string };
    const failed = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "r3" }) as { agentId: string };
    await engine.handle("agent.wait", { agentId: done.agentId, timeoutMs: 1000 });
    await engine.handle("agent.wait", { agentId: failed.agentId, timeoutMs: 1000 });
    const status = await engine.handlePeer("mbp", "peer.status", {}) as { agents: Record<string, number> };
    expect(status.agents).toEqual({ running: 1, paused: 0, done: 1, failed: 1, killed: 0 });
    void running;
  });

  // Task N-SHADOW: a native sub-agent/workflow "shadow" row inherits its parent's
  // principal (peer:mbp here), so without the `!a.shadow` filters at engine.ts's
  // peer.status count and the runningForPeer guard it would inflate a peer's
  // reported agent tally AND count against that peer's maxConcurrent cap.
  const TASK_SLOW: FakeStep[] = [
    { emit: { kind: "agent_started", data: {} } },
    { task: { taskId: "PT1", subagentType: "reviewer" } },   // -> shadow with principal peer:mbp
    { awaitSend: true }, { end: { resultText: "x" } },
  ];
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("peer.status does NOT count a shadow row (only the real peer-spawned parent)", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"], maxConcurrent: 10 }], [TASK_SLOW]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "s1" });
    await tick();                                            // let the fake emit its agent_task -> shadow
    const status = await engine.handlePeer("mbp", "peer.status", {}) as { agents: Record<string, number> };
    expect(status.agents).toEqual({ running: 1, paused: 0, done: 0, failed: 0, killed: 0 });   // the shadow is NOT the 2nd running
  });

  it("a shadow does not count against the per-peer maxConcurrent cap", async () => {
    // cap = 2. One peer-spawned parent + its shadow. If the shadow counted, the
    // pair would already fill the cap and a 2nd real spawn would be rejected.
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"], maxConcurrent: 2 }], [TASK_SLOW, HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "cap-a" });
    await tick();                                            // shadow now live with principal peer:mbp
    // 2nd real spawn must still fit under the cap (parent=1 real; shadow excluded)
    const b = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "cap-b" }) as { agentId: string };
    expect(b.agentId).toBeTruthy();
  });

  it("agent.kill/agent.tail (the default delegating case) also refuse a qualified agentId", async () => {
    const { engine } = makeEngine([PEER]);
    await expect(engine.handlePeer("mbp", "agent.kill", { agentId: "attic/a1" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("agent.tail with no agentId at all is passed through (tail is optional in the underlying schema)", async () => {
    const { engine } = makeEngine([PEER]);
    await expect(engine.handlePeer("mbp", "agent.tail", {})).resolves.toBeDefined();
  });
});

describe("Engine.handlePeer federated spawn policy", () => {
  it("enforces allowSpawn, account grants, and the providerOptions denylist", async () => {
    const { engine } = makeEngine([PEER], [HAPPY]);                     // allowSpawn defaults false
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "s1" })).rejects.toMatchObject({ code: "guardrail" });

    const { engine: e2 } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["second"] }], [HAPPY, HAPPY]);
    await expect(e2.handlePeer("mbp", "agent.spawn", { spec, spawnId: "s1" })).rejects.toMatchObject({ code: "guardrail" });  // main not granted
    await expect(e2.handlePeer("mbp", "agent.spawn", { spec: { ...spec, account: "auto" }, spawnId: "s2" }))
      .rejects.toMatchObject({ code: "guardrail" });                    // auto needs accounts:"auto"
    await expect(e2.handlePeer("mbp", "agent.spawn", {
      spec: { ...spec, account: "second", providerOptions: { env: { X: "y" } } }, spawnId: "s3",
    })).rejects.toMatchObject({ code: "guardrail" });                   // smuggling hole closed
    const rec = await e2.handlePeer("mbp", "agent.spawn", { spec: { ...spec, account: "second" }, spawnId: "s4" }) as { agentId: string; principal: string };
    expect(rec.principal).toBe("peer:mbp");
  });

  it("spawnId retry returns the SAME agent instead of double-spawning", async () => {
    const { engine, fake } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }], [HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const r1 = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "once" }) as { agentId: string };
    const r2 = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "once" }) as { agentId: string };
    expect(r2.agentId).toBe(r1.agentId);
    expect(fake.spawns.length).toBe(1);
  });

  it("enforces the per-peer maxConcurrent principal cap", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"], maxConcurrent: 1 }], [SLOW, HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "a" });
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "b" })).rejects.toMatchObject({ code: "guardrail" });
  });

  // ---------- additional coverage: exact gauntlet ORDER ----------

  it("validates the outer {spec,spawnId,depth,maxDepthCap} envelope BEFORE the allowSpawn check", async () => {
    const { engine } = makeEngine([PEER]); // allowSpawn defaults false
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec: {}, spawnId: "" })) // spawnId fails min(1)
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects malformed envelope fields: missing spawnId, negative depth, non-positive maxDepthCap", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec })).rejects.toMatchObject({ code: "protocol" }); // spawnId missing
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "d1", depth: -1 })).rejects.toMatchObject({ code: "protocol" });
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "d2", maxDepthCap: 0 })).rejects.toMatchObject({ code: "protocol" });
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "d3", maxDepthCap: -1 })).rejects.toMatchObject({ code: "protocol" });
  });

  it("allows the exact boundary depth: 0", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }], [HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const rec = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "depth0", depth: 0 }) as { agentId: string };
    expect(rec.agentId).toBeTruthy();
  });

  it("checks allowSpawn BEFORE validating the spec shape (guardrail wins over a malformed spec)", async () => {
    const { engine } = makeEngine([PEER]); // allowSpawn defaults false
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec: { totally: "bogus" }, spawnId: "bad1" }))
      .rejects.toMatchObject({ code: "guardrail" });
  });

  it("a spawnId cache hit short-circuits BEFORE spec re-validation (idempotent retry never re-validates)", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }], [HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const r1 = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "cache1" }) as { agentId: string };
    const r2 = await engine.handlePeer("mbp", "agent.spawn", { spec: { garbage: true }, spawnId: "cache1" }) as { agentId: string };
    expect(r2.agentId).toBe(r1.agentId);
  });

  it("returns protocol for a spec that fails AgentSpecSchema.parse once allowSpawn passes and there is no cache hit", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }]);
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec: { totally: "bogus" }, spawnId: "invalid1" }))
      .rejects.toMatchObject({ code: "protocol" });
  });

  it("checks the providerOptions denylist (assertFederationSafeSpec) BEFORE the account grant, when both would fail", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["second"] }], [HAPPY]);
    // account "main" is NOT granted AND providerOptions smuggle env — smuggling message must win
    await expect(engine.handlePeer("mbp", "agent.spawn", {
      spec: { prompt: "p", cwd: "/tmp", account: "main", isolation: "none", providerOptions: { env: { X: "y" } } },
      spawnId: "order1",
    })).rejects.toMatchObject({ code: "guardrail", message: expect.stringContaining("providerOptions") });
  });

  it("checks the account grant BEFORE the maxConcurrent cap (rejects on grant even when the cap is also exceeded)", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["second"], maxConcurrent: 1 }], [SLOW, HAPPY]);
    const specSecond = { prompt: "p", cwd: "/tmp", account: "second", isolation: "none" };
    await engine.handlePeer("mbp", "agent.spawn", { spec: specSecond, spawnId: "occupy" }); // fills the cap (SLOW = running)
    const specMain = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };      // not granted
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec: specMain, spawnId: "ord3" }))
      .rejects.toMatchObject({ code: "guardrail", message: expect.stringContaining("account") });
  });

  it("accounts:'auto' grants any explicit account name, including spec.account:'auto' itself", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: "auto" as const }], [HAPPY, HAPPY]);
    const specExplicit = { prompt: "p", cwd: "/tmp", account: "second", isolation: "none" };
    const r1 = await engine.handlePeer("mbp", "agent.spawn", { spec: specExplicit, spawnId: "auto1" }) as { agentId: string };
    expect(r1.agentId).toBeTruthy();
    const specAuto = { prompt: "p", cwd: "/tmp", account: "auto", isolation: "none" };
    const r2 = await engine.handlePeer("mbp", "agent.spawn", { spec: specAuto, spawnId: "auto2" }) as { agentId: string };
    expect(r2.agentId).toBeTruthy();
  });

  it("the maxConcurrent cap only counts RUNNING agents for THIS peer's principal — a finished agent frees the slot", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"], maxConcurrent: 1 }], [HAPPY, HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const a = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "fin-a" }) as { agentId: string };
    await engine.handle("agent.wait", { agentId: a.agentId, timeoutMs: 1000 }); // now "done", not "running"
    const b = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "fin-b" }) as { agentId: string };
    expect(b.agentId).toBeTruthy();
    expect(b.agentId).not.toBe(a.agentId);
  });

  it("killing an agent through the peer link frees its maxConcurrent slot for a subsequent spawn", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"], maxConcurrent: 1 }], [SLOW, HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const a = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "kill-a" }) as { agentId: string };
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "kill-b" })).rejects.toMatchObject({ code: "guardrail" });
    await engine.handlePeer("mbp", "agent.kill", { agentId: a.agentId });
    const b = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "kill-c" }) as { agentId: string };
    expect(b.agentId).toBeTruthy();
  });

  it("the spawnId cache key is scoped per-peer: the same spawnId from a different peer spawns independently", async () => {
    const OTHER = { engineId: "other", publicKey: makeIdentity().identity.publicKey, socketPath: "/tmp/other.sock" };
    const { engine, fake } = makeEngine(
      [{ ...PEER, allowSpawn: true, accounts: ["main"] }, { ...OTHER, allowSpawn: true, accounts: ["main"] }],
      [HAPPY, HAPPY],
    );
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const r1 = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "shared-id" }) as { agentId: string };
    const r2 = await engine.handlePeer("other", "agent.spawn", { spec, spawnId: "shared-id" }) as { agentId: string };
    expect(r1.agentId).not.toBe(r2.agentId);
    expect(fake.spawns.length).toBe(2);
  });

  it("remote-supplied depth/maxDepthCap are advisory: local orchestration.maxDepth stays authoritative", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }]);
    const spec = {
      prompt: "p", cwd: "/tmp", account: "main", isolation: "none",
      orchestration: { allow: true, maxDepth: 10 },
    };
    // maxDepthCap (peer-supplied) caps the effective max at 2; depth 3 exceeds it
    await expect(engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "deep1", depth: 3, maxDepthCap: 2 }))
      .rejects.toMatchObject({ code: "guardrail" });
  });
});

describe("Engine.handlePeer mailbox.forward", () => {
  it("enqueues idempotently and re-stamps origin from the authenticated peer", async () => {
    const { engine } = makeEngine([PEER]);
    const message = { id: "m-1", ts: 1, from: "spoofed/child", kind: "child_result" as const, text: "done", engineId: "spoofed" };
    expect(await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a1", message })).toMatchObject({ ok: true });
    expect(await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a1", message })).toMatchObject({ ok: true, deduped: true });
    const pending = engine.mailboxes.pending("a1");
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe("m-1");                                  // sender-assigned id preserved
    expect(pending[0]!.engineId).toBe("mbp");                            // origin re-stamped, not trusted
    expect(pending[0]!.from).toBe("mbp/child");
    await expect(engine.handlePeer("mbp", "mailbox.forward", { agentId: "x/y", message }))
      .rejects.toMatchObject({ code: "protocol" });                      // no transitive relay
  });

  // ---------- additional coverage ----------

  it("preserves the sender-assigned ts and meta, and forwards a bare (unqualified) from as-is under the new engine prefix", async () => {
    const { engine } = makeEngine([PEER]);
    const message = { id: "m-bare", ts: 4242, from: "childOnly", kind: "child_result" as const, text: "hi", meta: { costUsd: 0.5 }, engineId: "spoofed" };
    await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a2", message });
    const pending = engine.mailboxes.pending("a2");
    expect(pending[0]!.ts).toBe(4242);
    expect(pending[0]!.meta).toEqual({ costUsd: 0.5 });
    expect(pending[0]!.from).toBe("mbp/childOnly");
  });

  it("strips only the FIRST '/' qualifier segment of a from with embedded slashes", async () => {
    const { engine } = makeEngine([PEER]);
    const message = { id: "m-nested", ts: 1, from: "spoofed/child/grandchild", kind: "child_result" as const, text: "t", engineId: "spoofed" };
    await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a3", message });
    const pending = engine.mailboxes.pending("a3");
    expect(pending[0]!.from).toBe("mbp/child/grandchild");
  });

  it("dedup holds even after the message has been drained (hasMessage scans full history, not just pending)", async () => {
    const { engine } = makeEngine([PEER]);
    const message = { id: "m-drain", ts: 1, from: "child", kind: "child_result" as const, text: "t", engineId: "spoofed" };
    await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a4", message });
    engine.mailboxes.drain("a4");
    const res = await engine.handlePeer("mbp", "mailbox.forward", { agentId: "a4", message });
    expect(res).toEqual({ ok: true, deduped: true });
  });

  it("rejects malformed forward params via zod (missing message fields) with code protocol", async () => {
    const { engine } = makeEngine([PEER]);
    await expect(engine.handlePeer("mbp", "mailbox.forward", { agentId: "a5", message: { id: "m-x" } }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});

describe("Engine.handlePeer agent.send", () => {
  it("re-stamps a default 'from' to <peerId>/caller, visible in the delivered echo", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }], [SLOW]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const rec = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "send1" }) as { agentId: string };
    await engine.handlePeer("mbp", "agent.send", { agentId: rec.agentId, text: "hi" });
    await engine.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
    const tail = engine.events.tail(rec.agentId, 50);
    const echoed = tail.find((ev) => ev.kind === "message_complete");
    expect(echoed?.data["text"]).toBe("echo:[from mbp/caller] hi");
  });

  it("re-stamps an explicit 'from' to <peerId>/<bare-from>", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }], [SLOW]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const rec = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "send2" }) as { agentId: string };
    await engine.handlePeer("mbp", "agent.send", { agentId: rec.agentId, text: "hi", from: "child1" });
    await engine.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
    const tail = engine.events.tail(rec.agentId, 50);
    const echoed = tail.find((ev) => ev.kind === "message_complete");
    expect(echoed?.data["text"]).toBe("echo:[from mbp/child1] hi");
  });

  it("rejects a qualified agentId (no transitive relay) for agent.send", async () => {
    const { engine } = makeEngine([PEER]);
    await expect(engine.handlePeer("mbp", "agent.send", { agentId: "x/y", text: "hi" })).rejects.toMatchObject({ code: "protocol" });
  });
});

// --- Phase-5 deferred-must: secrets must never cross the trust boundary (spec §6) ---
describe("Engine.handlePeer trust-boundary redaction (deferred MUST)", () => {
  it("redacts resultText out of BOTH agent.status and agent.result peer-facing responses, but leaves the raw supervisor record untouched", async () => {
    expect.assertions(6);
    const secretScenario: FakeStep[] = [{ end: { resultText: "leaked secret: tok-second embedded here", costUsd: 0.02 } }];
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["second"] }], [secretScenario]);
    const spec = { prompt: "p", cwd: "/tmp", account: "second", isolation: "none" };
    const rec = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "sec1" }) as { agentId: string };
    await engine.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });

    const status = await engine.handlePeer("mbp", "agent.status", { agentId: rec.agentId }) as { resultText?: string };
    expect(status.resultText).toContain("[REDACTED]");
    expect(status.resultText).not.toContain("tok-second");

    const result = await engine.handlePeer("mbp", "agent.result", { agentId: rec.agentId }) as { text?: string };
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("tok-second");

    // the raw record itself (local trust domain, e.g. daemon.status/handle()) stays unscrubbed
    expect(engine.supervisor.status(rec.agentId).resultText).toContain("tok-second");
    expect((await engine.handle("agent.result", { agentId: rec.agentId }) as { text?: string }).text).toContain("tok-second");
  });

  it("scrubs resultText on a spawnId-idempotent retry once the agent has since completed with a secret", async () => {
    const secretScenario: FakeStep[] = [{ end: { resultText: "leak: tok-second done" } }];
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["second"] }], [secretScenario]);
    const spec = { prompt: "p", cwd: "/tmp", account: "second", isolation: "none" };
    const r1 = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "retry1" }) as { agentId: string };
    await engine.handle("agent.wait", { agentId: r1.agentId, timeoutMs: 1000 });
    const r2 = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "retry1" }) as { agentId: string; resultText?: string };
    expect(r2.agentId).toBe(r1.agentId);
    expect(r2.resultText).toContain("[REDACTED]");
    expect(r2.resultText).not.toContain("tok-second");
  });

  it("agent.spawn's immediate SUCCESS return has no resultText yet (spawn is synchronous with the launch, not the result) — scrub is a safe no-op", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }], [HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const rec = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "nosecret" }) as { resultText?: string };
    expect(rec.resultText).toBeUndefined();
  });

  it("redaction on secret-free resultText is a no-op (ordinary results pass through unchanged)", async () => {
    const { engine } = makeEngine([{ ...PEER, allowSpawn: true, accounts: ["main"] }], [HAPPY]);
    const spec = { prompt: "p", cwd: "/tmp", account: "main", isolation: "none" };
    const rec = await engine.handlePeer("mbp", "agent.spawn", { spec, spawnId: "plain1" }) as { agentId: string };
    await engine.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
    const status = await engine.handlePeer("mbp", "agent.status", { agentId: rec.agentId }) as { resultText?: string };
    expect(status.resultText).toBe("remote done");
  });
});
