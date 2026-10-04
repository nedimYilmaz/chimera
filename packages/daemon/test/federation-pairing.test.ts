import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFederatedMesh, until } from "./fed-rig.js";

// D8 (pairing, coverage C7 · B15): invite/join/grant on a real 2-engine mesh, driven token-free
// over loopback (no SSH). Every new response/event is swept for leaked secrets.

// Secret-shape sweep: no sk-/tskey- key and no raw invite token may appear in a surface.
const sweep = (surface: unknown, tokens: string[] = []) => {
  const s = JSON.stringify(surface);
  expect(s).not.toMatch(/sk-[A-Za-z0-9]/);
  expect(s).not.toMatch(/tskey-[A-Za-z0-9]/);
  for (const t of tokens) expect(s).not.toContain(t);
};

describe("D8 pairing — invite / join / grant", () => {
  it("invite.create → join walks config→tunnel→handshake→paired; both sides pin read-only", async () => {
    const mesh = await makeFederatedMesh(["mbp", "studio"]);
    const mbp = mesh.get("mbp"), studio = mesh.get("studio");

    const inv = await mbp.engine.handle("fed.invite.create", {}) as { id: string; blob: string; exp: number };
    expect(inv.blob.startsWith("chimera-pair:v1;")).toBe(true);

    const res = await studio.engine.handle("fed.join", { blob: inv.blob }) as {
      steps: Array<{ step: string; ok: boolean; error?: string }>; paired: string | null;
    };
    expect(res.steps.map((s) => s.step)).toEqual(["config", "tunnel", "handshake", "paired"]);
    expect(res.steps.every((s) => s.ok)).toBe(true);
    expect(res.paired).toBe("mbp");

    // both directions come up; both peers are pinned READ-ONLY (default deny)
    await until(() => (mbp.engine.federation!.peersStatus().find((p) => p.engineId === "studio")?.state ?? "") === "connected");
    await until(() => (studio.engine.federation!.peersStatus().find((p) => p.engineId === "mbp")?.state ?? "") === "connected");
    expect(mbp.engine.peerConfig("studio")!.allowSpawn).toBe(false);
    expect(studio.engine.peerConfig("mbp")!.allowSpawn).toBe(false);

    // the invite is BURNED after pairing; the blob's raw token never reached invites.json / events
    const invitesFile = readFileSync(join(mbp.home, "invites.json"), "utf8");
    expect(JSON.parse(invitesFile)[0].used).toBe(true);
    sweep(res);
    await mesh.stop();
  });

  it("a token is single-use: a SECOND join with the same blob is rejected at the handshake step", async () => {
    const mesh = await makeFederatedMesh(["mbp", "studio", "extra"]);
    const mbp = mesh.get("mbp"), studio = mesh.get("studio"), extra = mesh.get("extra");
    const inv = await mbp.engine.handle("fed.invite.create", {}) as { blob: string };

    const first = await studio.engine.handle("fed.join", { blob: inv.blob }) as { paired: string | null };
    expect(first.paired).toBe("mbp");

    // a different engine replays the SAME blob → token already burned → responder default-denies
    const second = await extra.engine.handle("fed.join", { blob: inv.blob }) as {
      steps: Array<{ step: string; ok: boolean; error?: string }>; paired: string | null;
    };
    expect(second.paired).toBe(null);
    const handshake = second.steps.find((s) => s.step === "handshake");
    expect(handshake?.ok).toBe(false);
    // and no dangling peer was left behind by the failed join (rollback)
    expect(extra.engine.peerConfig("mbp")).toBeUndefined();
    await mesh.stop();
  });

  it("invite token is single-use UNDER THE RACE: two concurrent pairings with the same token pin only ONE peer", async () => {
    // Reproduces the D8 review race directly against a real Engine: checkInvite() is a pre-proof
    // peek, so two connections presenting the SAME leaked token both peek true. Single-use is
    // enforced at onPeerPaired() (burn-first), where the two post-proof calls run sequentially.
    const mesh = await makeFederatedMesh(["mbp"]);
    const mbp = mesh.get("mbp");
    const inv = await mbp.engine.handle("fed.invite.create", {}) as { blob: string };
    const token = JSON.parse(Buffer.from(inv.blob.slice("chimera-pair:v1;".length), "base64").toString("utf8")).inviteToken as string;

    // both connections peek the SAME unburned token before either burns it (the race window)
    expect(mbp.engine.checkInvite(token)).toBe(true);
    expect(mbp.engine.checkInvite(token)).toBe(true);

    const card = (id: string) => ({
      engineId: id, protocolVersion: 1, features: [], providers: [], accounts: [],
      publicKey: `pk-${id}`, endpoint: { socketPath: `/tmp/${id}.sock` },
    }) as unknown as Parameters<typeof mbp.engine.onPeerPaired>[0];

    // two DIFFERENT joiner cards present the same token; only the first may be pinned
    mbp.engine.onPeerPaired(card("attackerX"), token);
    mbp.engine.onPeerPaired(card("attackerY"), token);

    const pinned = mbp.engine.peerConfigs().map((p) => p.engineId);
    expect(pinned).toContain("attackerX");
    expect(pinned).not.toContain("attackerY");   // second use rejected — the race is closed
    expect(mbp.engine.invites.check(token)).toBe(false);   // token burned exactly once

    // exactly ONE peer_paired event, not two
    const paired = (await mbp.engine.handle("agent.tail", { agentId: "federation", n: 20 }) as Array<{ kind: string; data: Record<string, unknown> }>)
      .filter((e) => e.kind === "peer_paired");
    expect(paired.length).toBe(1);
    expect(paired[0]!.data.engineId).toBe("attackerX");
    await mesh.stop();
  });

  it("fed.join reports the FAILING step: bad blob (config), dead tunnel (tunnel), bad token (handshake)", async () => {
    const mesh = await makeFederatedMesh(["mbp", "studio"]);
    const studio = mesh.get("studio"), mbp = mesh.get("mbp");

    // bad blob → config step fails, nothing else runs
    const bad = await studio.engine.handle("fed.join", { blob: "not-a-pair-blob" }) as { steps: Array<{ step: string; ok: boolean }>; paired: null };
    expect(bad.steps).toEqual([{ step: "config", ok: false, error: expect.any(String) }]);
    expect(bad.paired).toBe(null);

    // dead tunnel: a well-formed invite whose endpoint socket doesn't exist → tunnel step fails
    const good = await mbp.engine.handle("fed.invite.create", {}) as { blob: string };
    const decoded = JSON.parse(Buffer.from(good.blob.slice("chimera-pair:v1;".length), "base64").toString("utf8"));
    decoded.endpoint.socketPath = "/tmp/cm-nonexistent-xyz.sock";
    const deadBlob = "chimera-pair:v1;" + Buffer.from(JSON.stringify(decoded), "utf8").toString("base64");
    const dead = await studio.engine.handle("fed.join", { blob: deadBlob }) as { steps: Array<{ step: string; ok: boolean }>; paired: null };
    expect(dead.steps.map((s) => [s.step, s.ok])).toEqual([["config", true], ["tunnel", false]]);

    // rejected handshake: a real endpoint but an unregistered (forged) token → responder rejects
    const forged = { ...decoded, endpoint: { socketPath: join(mbp.home, "federation.sock") }, inviteToken: "forged-never-registered" };
    const forgedBlob = "chimera-pair:v1;" + Buffer.from(JSON.stringify(forged), "utf8").toString("base64");
    const rej = await studio.engine.handle("fed.join", { blob: forgedBlob }) as { steps: Array<{ step: string; ok: boolean }>; paired: null };
    expect(rej.steps.map((s) => [s.step, s.ok])).toEqual([["config", true], ["tunnel", true], ["handshake", false]]);
    expect(studio.engine.peerConfig("mbp")).toBeUndefined();   // rolled back
    await mesh.stop();
  });

  it("fed.peer.grant live-applies: a peer's spawn is guardrailed before the grant, succeeds after", async () => {
    const mesh = await makeFederatedMesh(["mbp", "studio"]);
    const mbp = mesh.get("mbp"), studio = mesh.get("studio");
    await mesh.pair("mbp", "studio");   // studio joins mbp; both read-only

    const spec = { prompt: "remote work", cwd: "/tmp", account: "main", isolation: "none" };
    // studio → spawn on mbp: mbp has studio pinned read-only → guardrail
    await expect(studio.engine.handle("agent.spawn", { spec, engine: "mbp" })).rejects.toMatchObject({ code: "guardrail" });

    // mbp grants studio (an operator action, LOCAL overlay write)
    const grant = await mbp.engine.handle("fed.peer.grant", { engineId: "studio", allowSpawn: true, accounts: "auto" }) as { ok: boolean; peer: { allowSpawn: boolean } };
    expect(grant.peer.allowSpawn).toBe(true);
    expect(mbp.engine.peerConfig("studio")!.allowSpawn).toBe(true);   // live-applied to in-memory config

    // now the same spawn succeeds — no restart
    const rec = await studio.engine.handle("agent.spawn", { spec, engine: "mbp" }) as { agentId: string };
    expect(rec.agentId).toContain("mbp/");
    sweep(grant);
    await mesh.stop();
  });

  it("invite.list shows hashes/exp/used (never raw tokens); revoke removes one", async () => {
    const mesh = await makeFederatedMesh(["mbp", "studio"]);
    const mbp = mesh.get("mbp");
    const a = await mbp.engine.handle("fed.invite.create", { ttlSeconds: 60 }) as { id: string; blob: string };
    await mbp.engine.handle("fed.invite.create", {});
    const listed = await mbp.engine.handle("fed.invite.list", {}) as { invites: Array<{ id: string; hash: string; exp: number; used: boolean }> };
    expect(listed.invites.length).toBe(2);
    expect(listed.invites[0]).toMatchObject({ hash: expect.any(String), exp: expect.any(Number), used: false });
    // the raw token from the blob is NOWHERE in the list surface
    const token = JSON.parse(Buffer.from(a.blob.slice("chimera-pair:v1;".length), "base64").toString("utf8")).inviteToken as string;
    sweep(listed, [token]);

    const rev = await mbp.engine.handle("fed.invite.revoke", { id: a.id }) as { revoked: boolean };
    expect(rev.revoked).toBe(true);
    const after = await mbp.engine.handle("fed.invite.list", {}) as { invites: unknown[] };
    expect(after.invites.length).toBe(1);
    await mesh.stop();
  });

  it("local peer.status carries each peer's cached host-tools summary (F08 carriage)", async () => {
    const mesh = await makeFederatedMesh(["mbp", "studio"]);
    const mbp = mesh.get("mbp"), studio = mesh.get("studio");
    await mesh.pair("studio", "mbp");    // studio mints, mbp joins → both pinned

    await mbp.engine.handle("host.tools", {});   // mbp completes a local scan (fake: git only)

    const st = await studio.engine.handle("peer.status", {}) as {
      peers: Array<{ engineId: string; state: string; hostTools: { host: string; tools: Array<{ tool: string }> } | null }>;
    };
    const peerMbp = st.peers.find((p) => p.engineId === "mbp")!;
    expect(peerMbp.state).toBe("connected");
    expect(peerMbp.hostTools!.host).toBe("mbp");
    expect(peerMbp.hostTools!.tools.map((t) => t.tool)).toContain("git");
    sweep(st);
    await mesh.stop();
  });

  it("a peer_paired event fires on BOTH sides and carries no secret", async () => {
    const mesh = await makeFederatedMesh(["mbp", "studio"]);
    const mbp = mesh.get("mbp"), studio = mesh.get("studio");
    const inv = await mbp.engine.handle("fed.invite.create", {}) as { blob: string };
    const token = JSON.parse(Buffer.from(inv.blob.slice("chimera-pair:v1;".length), "base64").toString("utf8")).inviteToken as string;
    await studio.engine.handle("fed.join", { blob: inv.blob });

    const joinerEv = (await studio.engine.handle("agent.tail", { agentId: "federation", n: 20 }) as Array<{ kind: string; data: Record<string, unknown> }>)
      .find((e) => e.kind === "peer_paired");
    const responderEv = (await mbp.engine.handle("agent.tail", { agentId: "federation", n: 20 }) as Array<{ kind: string; data: Record<string, unknown> }>)
      .find((e) => e.kind === "peer_paired");
    expect(joinerEv?.data.engineId).toBe("mbp");
    expect(responderEv?.data.engineId).toBe("studio");
    sweep([joinerEv, responderEv], [token]);
    await mesh.stop();
  });
});
