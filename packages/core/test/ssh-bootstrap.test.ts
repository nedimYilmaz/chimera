import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { InMemoryKeychain } from "@chimera/core/keychain";
import { removeFedKey } from "@chimera/core/network";
import type { NetExecFn } from "@chimera/core/network";
import type { ProbeFn } from "@chimera/core/cloudflare-selfprobe";
import type { CfFetchFn } from "@chimera/core/cloudflare";
import { EngineIdentity } from "@chimera/core/federation/identity";
import { ResponderHandshake } from "@chimera/core/federation/handshake";
import { decodeFrames, encodeFrame, PairBlobSchema, PAIR_BLOB_PREFIX, decodePairBlob, encodePairBlob } from "@chimera/protocol";

// Minimal responder loop mirroring packages/daemon/src/federation.ts's startFederationServer,
// wired directly to a REAL Engine's checkInvite/onPeerPaired/engineCard so a real fed.join
// (real chimera handshake, real invite-token TOFU admission, real onPeerPaired auto-pin) can run
// over a real (loopback unix socket) transport — the only thing NOT real is the outer ssh/cloudflared
// carrier, which is daemon-layer and out of package scope here.
async function startEngineResponder(engine: Engine, identity: EngineIdentity, socketPath: string) {
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    let buf = "";
    let phase: "hello" | "auth" | "established" = "hello";
    const peerKeys = new Map(engine.peerConfigs().map((p) => [p.engineId, p.publicKey]));
    const responder = new ResponderHandshake({
      identity, card: engine.engineCard(), peerKeys,
      checkInvite: (token) => engine.checkInvite(token),
      onPaired: (card, token) => engine.onPeerPaired(card, token),
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const { frames, rest } = decodeFrames(buf); buf = rest;
      for (const f of frames) {
        try {
          if (phase === "hello") { sock.write(encodeFrame(responder.onHello(f) as never)); phase = "auth"; }
          else if (phase === "auth") { sock.write(encodeFrame(responder.onAuth(f).welcome as never)); phase = "established"; }
        } catch { sock.destroy(); }
      }
    });
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return { close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

// §13 addendum tests: the SSH-layer credential bootstrap without which the first fed.join SSH
// connection cannot succeed. NO test here spawns a real ssh-keygen/ssh/cloudflared process, and
// EVERY engine is given an isolated `userSshDir` tmp dir so target:"user" writes NEVER touch a
// real user's ~/.ssh — the same fake-exec / injected-seam discipline as network-d6.test.ts and
// cloudflare-engine.test.ts.

function makeHome(id: string): string {
  const home = mkdtempSync(join(tmpdir(), `chm-sshboot-${id}-`));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    engine: { id },
  }));
  return home;
}

function makeUserSshDir(id: string): string {
  return mkdtempSync(join(tmpdir(), `chm-sshboot-usersshdir-${id}-`));
}

function fakeEd25519PubKey(seed = 9): string {
  const typeStr = Buffer.from("ssh-ed25519", "ascii");
  const lp = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  const blob = Buffer.concat([lp(typeStr), lp(Buffer.alloc(32, seed))]).toString("base64");
  return `ssh-ed25519 ${blob} someone@host`;
}

function fakeSshKeygenExec(seed = 9): NetExecFn {
  return async (cmd, args) => {
    if (cmd === "ssh-keygen") {
      const f = args[args.indexOf("-f") + 1]!;
      writeFileSync(f, "PRIVATE\n", { mode: 0o600 });
      writeFileSync(`${f}.pub`, `${fakeEd25519PubKey(seed)}\n`);
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

function fakeCfFetch(engineId: string, accountId = "acct1", tunnelId = "tunnel1", clientId = "cid-1"): CfFetchFn {
  return (async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const ok = (body: unknown) => new Response(JSON.stringify({ success: true, result: body }), { status: 200 });
    if (key === "GET https://api.cloudflare.com/client/v4/user/tokens/verify") return ok({ status: "active" });
    if (key === "GET https://api.cloudflare.com/client/v4/accounts") return ok([{ id: accountId }]);
    if (key === "GET https://api.cloudflare.com/client/v4/zones?name=example.com") return ok([{ id: "zone1" }]);
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?name=chimera-${engineId}`) return ok([]);
    if (key === `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`) return ok({ id: tunnelId });
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`) return ok("tunnel-token-value");
    if (key === `PUT https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`) return ok({});
    if (key === `GET https://api.cloudflare.com/client/v4/zones/zone1/dns_records?name=${engineId}.example.com`) return ok([]);
    if (key === "POST https://api.cloudflare.com/client/v4/zones/zone1/dns_records") return ok({});
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens`) return ok([]);
    if (key === `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens`)
      return ok({ client_id: clientId, client_secret: "secret-xyz" });
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`) return ok([]);
    if (key === `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`) return ok({ id: "app1" });
    throw new Error(`unmocked fetch: ${key}`);
  }) as CfFetchFn;
}

async function makeProvisionedInviter(opts?: { id?: string; readHostKeys?: () => string[] }) {
  const id = opts?.id ?? "inviter";
  const home = makeHome(id);
  const userSshDir = makeUserSshDir(id);
  const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
  const probe: ProbeFn = async ({ withToken }) => ({ sawSshBanner: withToken !== null });
  const engine = new Engine({
    home, backends, keychain: new InMemoryKeychain(),
    cfFetch: fakeCfFetch(id), cfProbe: probe, userSshDir,
    netExec: fakeSshKeygenExec(1), readHostKeys: opts?.readHostKeys ?? (() => ["ssh-ed25519 AAAAHOSTKEY hostkeycomment"]),
  });
  await engine.handle("fed.cloudflare.up", { apiToken: "tok", domain: "example.com" });
  return { engine, home, userSshDir };
}

// ---------------------------------------------------------------------------
// 1. First-connection path end to end: invite → blob carries ephemeral key + host key lines →
//    joiner writes identity file + authorizes the inviter's durable key + materializes
//    known_hosts. No real ssh/cloudflared ever spawns; the chimera handshake runs over a real
//    (loopback) unix socket exactly like every other fed.join test in this package.
// ---------------------------------------------------------------------------
describe("§13 SSH-layer credential bootstrap — first-connection path", () => {
  it("invite blob carries the ephemeral key + host key lines; the inviter's OWN authorized_keys gets the invite-tagged line", async () => {
    const { engine: inviter, userSshDir: inviterSshDir } = await makeProvisionedInviter();
    const created = await inviter.handle("fed.invite.create", {}) as { id: string; blob: string };
    const decoded = decodePairBlob(created.blob);

    expect(decoded.inviteKeyPrivate).toBeTruthy();
    expect(decoded.fedSshPublicKey).toBeTruthy();
    expect(decoded.endpoint.hostKeyLines).toEqual(["ssh-ed25519 AAAAHOSTKEY hostkeycomment"]);
    expect(decoded.endpoint.sshUser).toBeTruthy();

    const authKeys = readFileSync(join(inviterSshDir, "authorized_keys"), "utf8");
    expect(authKeys).toContain(`chimera-fed:invite-${created.id}`);
    expect(authKeys.startsWith("restrict,port-forwarding ")).toBe(true);
  });

  it("joiner writes the identity key, authorizes the inviter's fed_ssh_key.pub, and materializes known_hosts — full fed.invite.create -> fed.join round trip against a REAL responder engine", async () => {
    const { engine: inviter, home: inviterHome } = await makeProvisionedInviter({ id: "e2e" });
    const inviterIdentity = EngineIdentity.loadOrCreate(inviterHome);   // same identity the engine itself uses (engine.id "e2e")
    const socketPath = join(inviterHome, "federation.sock");
    const responder = await startEngineResponder(inviter, inviterIdentity, socketPath);

    const created = await inviter.handle("fed.invite.create", {}) as { id: string; blob: string };

    const joinerHome = makeHome("joiner");
    const joinerSshDir = makeUserSshDir("joiner");
    const joinerBackends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const joinerKeychain = new InMemoryKeychain();
    const joiner = new Engine({
      home: joinerHome, backends: joinerBackends, keychain: joinerKeychain, userSshDir: joinerSshDir,
      netExec: fakeSshKeygenExec(3), readHostKeys: () => [],
    });
    const result = await joiner.handle("fed.join", { blob: created.blob }) as { steps: Array<{ step: string; ok: boolean }>; paired: string | null };

    expect(result.steps.find((s) => s.step === "sshkeys")).toMatchObject({ ok: true });
    expect(result.paired).toBe("e2e");   // real chimera handshake actually completed

    // Identity file at the §4 IdentityFile path, containing the shown-once private key.
    const idPath = join(joinerHome, "federation", "e2e.key");
    expect(existsSync(idPath)).toBe(true);

    // The inviter's durable fed_ssh_key.pub is authorized in the JOINER's own authorized_keys.
    const joinerAuthKeys = readFileSync(join(joinerSshDir, "authorized_keys"), "utf8");
    expect(joinerAuthKeys).toContain("chimera-fed:e2e");

    // known_hosts materialized under the managed federation dir, StrictHostKeyChecking-ready.
    const knownHosts = readFileSync(join(joinerHome, "federation", "known_hosts"), "utf8");
    expect(knownHosts).toContain("ssh-ed25519 AAAAHOSTKEY hostkeycomment");

    await responder.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Revoke / expiry sweep removes the authorized_keys line — no key material outlives its invite.
// ---------------------------------------------------------------------------
describe("§13a/f invite-key lifecycle: revoke and expiry sweep", () => {
  it("fed.invite.revoke removes the inviter-side authorized_keys line", async () => {
    const { engine, userSshDir } = await makeProvisionedInviter({ id: "revoke" });
    const created = await engine.handle("fed.invite.create", {}) as { id: string; blob: string };
    const tag = `invite-${created.id}`;

    expect(readFileSync(join(userSshDir, "authorized_keys"), "utf8")).toContain(`chimera-fed:${tag}`);
    const rev = await engine.handle("fed.invite.revoke", { id: created.id }) as { revoked: boolean };
    expect(rev.revoked).toBe(true);
    expect(readFileSync(join(userSshDir, "authorized_keys"), "utf8")).not.toContain(`chimera-fed:${tag}`);
    // Confirmed also via the pure helper against the SAME isolated dir:
    expect(removeFedKey({ home: "", tag, target: "user", userSshDir })).toBe(false);   // already gone
  });

  it("an expired, unpaired invite's key line is swept on the next fed.invite.create", async () => {
    const { engine, userSshDir } = await makeProvisionedInviter({ id: "sweep" });
    const created = await engine.handle("fed.invite.create", { ttlSeconds: 1 }) as { id: string };
    const tag = `invite-${created.id}`;
    expect(readFileSync(join(userSshDir, "authorized_keys"), "utf8")).toContain(`chimera-fed:${tag}`);

    // Let the 1s TTL elapse (the ledger's own clock is uninjected Date.now here).
    await new Promise((r) => setTimeout(r, 1100));
    await engine.handle("fed.invite.create", {});   // triggers the sweep as its first step
    expect(readFileSync(join(userSshDir, "authorized_keys"), "utf8")).not.toContain(`chimera-fed:${tag}`);
  });
});

// ---------------------------------------------------------------------------
// 3. onPeerPaired upserts instead of skipping an already-pinned peer.
// ---------------------------------------------------------------------------
describe("§13e onPeerPaired upserts an already-pinned peer", () => {
  it("a re-pair with a fresh endpoint UPDATES socketPath/ssh; identity + grants unchanged", async () => {
    const { EngineIdentity } = await import("@chimera/core/federation/identity");
    const home = makeHome("upsert");
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const engine = new Engine({ home, backends, keychain: new InMemoryKeychain() });
    const peerIdentity = EngineIdentity.loadOrCreate(makeHome("upsert-peer"));

    // Mint a real invite so the token is valid, then simulate the responder-side onPeerPaired call
    // directly (this is exactly what ResponderHandshake invokes on a successful pairing auth).
    const inv1 = await engine.handle("fed.invite.create", {}) as { blob: string };
    const token1 = decodePairBlob(inv1.blob).inviteToken;
    const card1 = { engineId: "peerA", protocolVersion: 1, features: [], providers: [], accounts: [],
      publicKey: peerIdentity.publicKey, endpoint: { socketPath: "/tmp/one.sock" } };
    engine.onPeerPaired(card1 as never, token1);

    type Cfg = { federation?: { peers: Array<{ engineId: string; socketPath: string; allowSpawn: boolean }> } };
    const peerAfterFirst = (engine as unknown as { cfg: Cfg }).cfg.federation!.peers.find((p) => p.engineId === "peerA")!;
    expect(peerAfterFirst.socketPath).toBe("/tmp/one.sock");

    // Grant spawn so we can assert grants survive the upsert untouched.
    await engine.handle("fed.peer.grant", { engineId: "peerA", allowSpawn: true });

    // Re-pair: fresh invite, fresh endpoint (rotated socketPath / new ssh block).
    const inv2 = await engine.handle("fed.invite.create", {}) as { blob: string };
    const token2 = decodePairBlob(inv2.blob).inviteToken;
    const card2 = { ...card1, endpoint: { socketPath: "/tmp/two.sock" } };
    engine.onPeerPaired(card2 as never, token2);

    const peers = (engine as unknown as { cfg: Cfg }).cfg.federation!.peers.filter((p) => p.engineId === "peerA");
    expect(peers.length).toBe(1);                        // upsert, not a duplicate row
    expect(peers[0]!.socketPath).toBe("/tmp/two.sock");   // UPDATED
    expect(peers[0]!.allowSpawn).toBe(true);              // grant PRESERVED across the re-pair
  });
});

// ---------------------------------------------------------------------------
// 4. Rollback: a failed join leaves no residue (identity file / known_hosts / authorized line).
// ---------------------------------------------------------------------------
describe("§13f rollback — a failed fed.join leaves no residue", () => {
  it("an unreachable socket (tunnel step fails) rolls back the sshkeys-step artifacts", async () => {
    const { EngineIdentity } = await import("@chimera/core/federation/identity");
    const joinerHome = makeHome("rollback-joiner");
    const joinerSshDir = makeUserSshDir("rollback-joiner");
    const joinerBackends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const joiner = new Engine({ home: joinerHome, backends: joinerBackends, keychain: new InMemoryKeychain(), userSshDir: joinerSshDir });
    const inviterIdentity = EngineIdentity.loadOrCreate(makeHome("rollback-inviter"));

    const blob = encodePairBlob({
      card: { engineId: "ghost", protocolVersion: 1, features: [], providers: [], accounts: [], publicKey: inviterIdentity.publicKey },
      endpoint: {
        socketPath: join(joinerHome, "definitely-not-listening.sock"),   // nothing is listening here
        hostKeyLines: ["ssh-ed25519 AAAAGHOST ghostcomment"],
        sshUser: "chimera",
      },
      inviteToken: "ghost-token",
      exp: Date.now() + 60_000,
      inviteKeyPrivate: "GHOST-PRIVATE-KEY\n",
      fedSshPublicKey: fakeEd25519PubKey(4),
    });

    const result = await joiner.handle("fed.join", { blob }) as { steps: Array<{ step: string; ok: boolean }>; paired: string | null };
    expect(result.paired).toBeNull();
    expect(result.steps.find((s) => s.step === "tunnel")).toMatchObject({ ok: false });

    // No residue: identity file absent, known_hosts/authorized_keys carry no ghost entries, no peer pinned.
    expect(existsSync(join(joinerHome, "federation", "ghost.key"))).toBe(false);
    const khPath = join(joinerHome, "federation", "known_hosts");
    if (existsSync(khPath)) expect(readFileSync(khPath, "utf8")).not.toContain("ghostcomment");
    const akPath = join(joinerSshDir, "authorized_keys");
    if (existsSync(akPath)) expect(readFileSync(akPath, "utf8")).not.toContain("chimera-fed:ghost");
    const cfg = (joiner as unknown as { cfg: { federation?: { peers: unknown[] } } }).cfg;
    expect(cfg.federation?.peers ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Backward compatibility — old blobs / configs with the §13 fields absent parse/behave
//    byte-identically.
// ---------------------------------------------------------------------------
describe("§13 backward compatibility", () => {
  it("a pre-§13 blob (no hostKeyLines/sshUser/inviteKeyPrivate/fedSshPublicKey) still parses", () => {
    const legacy = {
      card: { engineId: "legacy", protocolVersion: 1, features: [], providers: [], accounts: [] },
      endpoint: { socketPath: "/tmp/legacy.sock" },
      inviteToken: "legacy-token-0123456789",
      exp: Date.now() + 60_000,
    };
    const parsed = PairBlobSchema.parse(legacy);
    expect(parsed.endpoint.hostKeyLines).toBeUndefined();
    expect(parsed.inviteKeyPrivate).toBeUndefined();
    expect(parsed.fedSshPublicKey).toBeUndefined();

    const blob = PAIR_BLOB_PREFIX + Buffer.from(JSON.stringify(legacy), "utf8").toString("base64");
    expect(decodePairBlob(blob)).toEqual(legacy);
  });

  it("fed.invite.create with no Cloudflare provisioning never mints an ssh-layer key (byte-identical to pre-§13)", async () => {
    const home = makeHome("plain");
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const engine = new Engine({ home, backends, keychain: new InMemoryKeychain() });
    const created = await engine.handle("fed.invite.create", {}) as { blob: string };
    const decoded = decodePairBlob(created.blob);
    expect(decoded.inviteKeyPrivate).toBeUndefined();
    expect(decoded.fedSshPublicKey).toBeUndefined();
    expect(decoded.endpoint.hostKeyLines).toBeUndefined();
    expect(existsSync(join(home, "authorized_keys"))).toBe(false);
  });
});
