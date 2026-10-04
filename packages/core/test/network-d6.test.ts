import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { InMemoryKeychain } from "@chimera/core/keychain";
import {
  NetworkManager, parseTailscaleStatus, parseAuthUrl, validateSshPublicKey, acceptFedKey,
  resolveTailscaleFallback, FED_AUTHORIZED_KEYS_OPTIONS, TAILSCALE_AUTHKEY_SERVICE,
  type NetExecFn, type NetExecResult,
} from "@chimera/core/network";
import type { NormalizedEvent, TailscaleNetworkStatus } from "@chimera/protocol";

// ---------------------------------------------------------------------------
// Fakes: a scriptable NetExecFn keyed on the command line; a stub keychain lives in
// InMemoryKeychain. NO real tailscale/ssh-keygen process ever runs (D0 token-free).
// ---------------------------------------------------------------------------
type ExecReply = Partial<NetExecResult> | ((args: string[]) => Partial<NetExecResult>);
function fakeNetExec(routes: Record<string, ExecReply>, calls?: string[][]): NetExecFn {
  return async (cmd, args) => {
    calls?.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    // Longest matching prefix wins so "tailscale up --auth-key <k>" can match "tailscale up --auth-key".
    const match = Object.keys(routes).filter((k) => key.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const r = match ? routes[match]! : {};
    const resolved = typeof r === "function" ? r(args) : r;
    return { stdout: "", stderr: "", code: 0, ...resolved };
  };
}

const STATUS_RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { TailscaleIPs: ["100.101.102.103", "fd7a:1::1"], Capabilities: ["https://tailscale.com/cap/ssh"] },
  CurrentTailnet: { MagicDNSEnabled: true },
  MagicDNSSuffix: "tail1234.ts.net",
});
const STATUS_NEEDS_LOGIN = JSON.stringify({ BackendState: "NeedsLogin", Self: { TailscaleIPs: [] } });

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chm-d6-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    engine: { id: "studio" },
  }));
  return home;
}

function makeManager(opts: {
  routes: Record<string, ExecReply>; keychain?: InMemoryKeychain; now?: () => number; cacheMs?: number;
  calls?: string[][]; pathExists?: (path: string) => boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), "chm-d6nm-"));
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const keychain = opts.keychain ?? new InMemoryKeychain();
  const nm = new NetworkManager({
    home, engineId: "studio", keychain,
    emit: (kind, data) => events.push({ kind, data }),
    exec: fakeNetExec(opts.routes, opts.calls), now: opts.now, cacheMs: opts.cacheMs,
    pathExists: opts.pathExists,
  });
  return { nm, events, home, keychain };
}

// ---------------------------------------------------------------------------
// parseTailscaleStatus — installed / logged-in / logged-out / absent
// ---------------------------------------------------------------------------
describe("parseTailscaleStatus", () => {
  it("logged-in Running node → installed, loggedIn, ip4, magicDNS, tailscaleSSH", () => {
    const s = parseTailscaleStatus({ stdout: STATUS_RUNNING, stderr: "", code: 0 });
    expect(s).toEqual<TailscaleNetworkStatus>({ installed: true, loggedIn: true, ip4: "100.101.102.103", magicDNS: true, tailscaleSSH: true });
  });
  it("logged-OUT node (exit 1 + NeedsLogin JSON) → installed but not loggedIn, no ip", () => {
    const s = parseTailscaleStatus({ stdout: STATUS_NEEDS_LOGIN, stderr: "", code: 1 });
    expect(s).toEqual<TailscaleNetworkStatus>({ installed: true, loggedIn: false, ip4: null, magicDNS: false, tailscaleSSH: false });
  });
  it("binary ABSENT (ENOENT) → installed:false, never throws", () => {
    const s = parseTailscaleStatus({ stdout: "", stderr: "", code: 1, errno: "ENOENT" });
    expect(s).toEqual<TailscaleNetworkStatus>({ installed: false, loggedIn: false, ip4: null, magicDNS: false, tailscaleSSH: false });
  });
  it("installed but unparseable output → installed:true, unknown-state", () => {
    const s = parseTailscaleStatus({ stdout: "not json", stderr: "", code: 0 });
    expect(s.installed).toBe(true);
    expect(s.loggedIn).toBe(false);
  });
});

describe("parseAuthUrl", () => {
  it("extracts the tailscale login URL from up() output", () => {
    const out = "\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/deadbeefcafe\n\n";
    expect(parseAuthUrl(out)).toBe("https://login.tailscale.com/a/deadbeefcafe");
  });
  it("returns null when no URL is present (already up)", () => {
    expect(parseAuthUrl("Success.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tailscale binary resolution — PATH-absent but installed at a known absolute path
// (e.g. the macOS standalone app, off PATH under a launchd-started daemon).
// ---------------------------------------------------------------------------
describe("resolveTailscaleFallback", () => {
  it("returns the first known path that exists, in priority order", () => {
    const found = "/opt/homebrew/bin/tailscale";
    expect(resolveTailscaleFallback((p) => p === found)).toBe(found);
  });
  it("returns null when none of the known paths exist", () => {
    expect(resolveTailscaleFallback(() => false)).toBeNull();
  });
});

describe("NetworkManager resolves tailscale off a known absolute path when PATH lookup ENOENTs", () => {
  const BUNDLE_PATH = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

  it("installed:true via the macOS app bundle path, not just bare PATH", async () => {
    const calls: string[][] = [];
    const { nm } = makeManager({
      routes: {
        "tailscale status --json": { code: 1, errno: "ENOENT" },              // not on PATH
        [`${BUNDLE_PATH} status --json`]: { stdout: STATUS_RUNNING, code: 0 }, // but installed here
      },
      pathExists: (p) => p === BUNDLE_PATH,
      calls,
    });
    const s = await nm.status();
    expect(s).toMatchObject({ installed: true, loggedIn: true, ip4: "100.101.102.103" });
    expect(calls).toEqual([["tailscale", "status", "--json"], [BUNDLE_PATH, "status", "--json"]]);
  });

  it("caches the resolved path so a later call skips the doomed bare-PATH attempt", async () => {
    let t = 0;
    const calls: string[][] = [];
    const { nm } = makeManager({
      routes: {
        "tailscale status --json": { code: 1, errno: "ENOENT" },
        [`${BUNDLE_PATH} status --json`]: { stdout: STATUS_RUNNING, code: 0 },
      },
      pathExists: (p) => p === BUNDLE_PATH,
      now: () => t, cacheMs: 5000,
      calls,
    });
    await nm.status();
    t += 6000;                          // past the cache window → forces a second real probe
    await nm.status();
    expect(calls).toEqual([
      ["tailscale", "status", "--json"], [BUNDLE_PATH, "status", "--json"],   // first call: PATH miss, then fallback
      [BUNDLE_PATH, "status", "--json"],                                     // second call: straight to the cached path
    ]);
  });

  it("installed:false when tailscale is absent from PATH AND every known path", async () => {
    const { nm } = makeManager({
      routes: { "tailscale status --json": { code: 1, errno: "ENOENT" } },
      pathExists: () => false,
    });
    expect(await nm.status()).toMatchObject({ installed: false, loggedIn: false });
  });
});

// ---------------------------------------------------------------------------
// NetworkManager.status — 5s cache (fake clock) + network_changed on change
// ---------------------------------------------------------------------------
describe("NetworkManager.status cache + network_changed", () => {
  it("caches within 5s and re-probes past staleness (fake clock)", async () => {
    let t = 1000;
    const calls: string[][] = [];
    const { nm } = makeManager({ routes: { "tailscale status --json": { stdout: STATUS_RUNNING } }, now: () => t, calls });
    await nm.status();
    await nm.status();                             // within cache window → no second probe
    expect(calls.filter((c) => c[1] === "status").length).toBe(1);
    t += 6000;                                     // past the 5s cache
    await nm.status();
    expect(calls.filter((c) => c[1] === "status").length).toBe(2);
  });

  it("emits network_changed on the first probe and again only when state differs", async () => {
    let t = 0;
    let statusJson = STATUS_NEEDS_LOGIN;
    const { nm, events } = makeManager({
      routes: { "tailscale status --json": () => ({ stdout: statusJson, code: statusJson === STATUS_NEEDS_LOGIN ? 1 : 0 }) },
      now: () => t, cacheMs: 5000,
    });
    await nm.status();
    expect(events.filter((e) => e.kind === "network_changed").length).toBe(1);   // initial
    t += 6000;
    await nm.status();                             // same state → no new event
    expect(events.filter((e) => e.kind === "network_changed").length).toBe(1);
    t += 6000;
    statusJson = STATUS_RUNNING;                   // now joined
    const s = await nm.status();
    expect(s.loggedIn).toBe(true);
    expect(events.filter((e) => e.kind === "network_changed").length).toBe(2);   // state changed → new event
    // the network_changed payload carries NO secret and matches the wire shape
    expect(events.at(-1)!.data).toMatchObject({ installed: true, loggedIn: true, ip4: "100.101.102.103" });
  });
});

// ---------------------------------------------------------------------------
// fed.network.up — auth URL capture, never echoes raw output
// ---------------------------------------------------------------------------
describe("NetworkManager.up", () => {
  it("returns the auth URL when tailscale needs interactive login", async () => {
    const { nm } = makeManager({
      routes: {
        "tailscale up": { stderr: "To authenticate, visit:\n\thttps://login.tailscale.com/a/abc123" },
        "tailscale status --json": { stdout: STATUS_NEEDS_LOGIN, code: 1 },
      },
    });
    expect(await nm.up()).toEqual({ authUrl: "https://login.tailscale.com/a/abc123" });
  });
  it("returns authUrl:null when already up", async () => {
    const { nm } = makeManager({
      routes: { "tailscale up": { stdout: "Success." }, "tailscale status --json": { stdout: STATUS_RUNNING } },
    });
    expect(await nm.up()).toEqual({ authUrl: null });
  });
});

// ---------------------------------------------------------------------------
// Startup auto-join: burn on success, network_error (no key) on failure
// ---------------------------------------------------------------------------
describe("NetworkManager.autoJoin", () => {
  const TSKEY = "tskey-auth-liveSECRETkey1234567890";

  it("already logged in → no-op (no `tailscale up`, key untouched)", async () => {
    const keychain = new InMemoryKeychain({ [TAILSCALE_AUTHKEY_SERVICE]: TSKEY });
    const calls: string[][] = [];
    const { nm } = makeManager({ routes: { "tailscale status --json": { stdout: STATUS_RUNNING } }, keychain, calls });
    expect(await nm.autoJoin()).toBe("already-logged-in");
    expect(calls.some((c) => c.includes("--auth-key"))).toBe(false);
    expect(keychain.has(TAILSCALE_AUTHKEY_SERVICE)).toBe(true);
  });

  it("logged out + stored key + success → joins and BURNS the key", async () => {
    const keychain = new InMemoryKeychain({ [TAILSCALE_AUTHKEY_SERVICE]: TSKEY });
    const { nm, events } = makeManager({
      routes: {
        "tailscale status --json": { stdout: STATUS_NEEDS_LOGIN, code: 1 },
        "tailscale up --auth-key": { stdout: "Success.", code: 0 },
      },
      keychain,
    });
    expect(await nm.autoJoin()).toBe("joined");
    expect(keychain.has(TAILSCALE_AUTHKEY_SERVICE)).toBe(false);   // burned
    expect(events.some((e) => e.kind === "network_error")).toBe(false);
  });

  it("logged out + no stored key → no-key (no join attempt)", async () => {
    const { nm } = makeManager({ routes: { "tailscale status --json": { stdout: STATUS_NEEDS_LOGIN, code: 1 } } });
    expect(await nm.autoJoin()).toBe("no-key");
  });

  it("join FAILURE → network_error whose message NEVER contains the key; key is NOT burned", async () => {
    const keychain = new InMemoryKeychain({ [TAILSCALE_AUTHKEY_SERVICE]: TSKEY });
    const { nm, events } = makeManager({
      routes: {
        "tailscale status --json": { stdout: STATUS_NEEDS_LOGIN, code: 1 },
        // tailscale often echoes the key back in the error — the manager must scrub it.
        "tailscale up --auth-key": { stderr: `backend error: invalid key: ${TSKEY}`, code: 1 },
      },
      keychain,
    });
    expect(await nm.autoJoin()).toBe("failed");
    expect(keychain.has(TAILSCALE_AUTHKEY_SERVICE)).toBe(true);    // kept for a retry
    const err = events.find((e) => e.kind === "network_error");
    expect(err).toBeDefined();
    expect(JSON.stringify(err!.data)).not.toContain(TSKEY);
    expect(JSON.stringify(err!.data)).not.toMatch(/tskey-/);
  });
});

// ---------------------------------------------------------------------------
// SSH public key validation + fed.accept authorized_keys line
// ---------------------------------------------------------------------------
// A REAL, well-formed ssh-ed25519 public key (32 zero bytes as the raw key) so the embedded-type
// check has valid bytes to parse. Blob = ssh wire: string "ssh-ed25519" + string <32 bytes>.
function ed25519PubKey(raw = Buffer.alloc(32, 7)): string {
  const typeStr = Buffer.from("ssh-ed25519", "ascii");
  const lp = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  const blob = Buffer.concat([lp(typeStr), lp(raw)]).toString("base64");
  return `ssh-ed25519 ${blob} someone@host`;
}

describe("validateSshPublicKey", () => {
  it("accepts a well-formed ed25519 key and strips the comment", () => {
    const { type, blob } = validateSshPublicKey(ed25519PubKey());
    expect(type).toBe("ssh-ed25519");
    expect(blob).not.toContain("someone@host");
  });
  it("rejects a non-key string", () => {
    expect(() => validateSshPublicKey("not a key")).toThrow(/public key|unsupported|base64/i);
  });
  it("rejects an unsupported type prefix", () => {
    expect(() => validateSshPublicKey("ssh-dss AAAAB3 comment")).toThrow(/unsupported key type/);
  });
  it("rejects a prefix/embedded-type mismatch (forged blob)", () => {
    const good = ed25519PubKey();
    const forged = good.replace("ssh-ed25519 ", "ssh-rsa ");   // declared rsa, embedded ed25519
    expect(() => validateSshPublicKey(forged)).toThrow(/type mismatch|malformed|base64/i);
  });
});

describe("acceptFedKey authorized_keys line", () => {
  it("writes an EXACT restricted line: 'restrict,port-forwarding <type> <blob> chimera-fed:<engineId>'", () => {
    const home = mkdtempSync(join(tmpdir(), "chm-d6ak-"));
    const { line } = acceptFedKey({ home, engineId: "studio", publicKey: ed25519PubKey() });
    const { blob } = validateSshPublicKey(ed25519PubKey());
    expect(line).toBe(`${FED_AUTHORIZED_KEYS_OPTIONS} ssh-ed25519 ${blob} chimera-fed:studio`);
    expect(FED_AUTHORIZED_KEYS_OPTIONS).toBe("restrict,port-forwarding");
    const file = readFileSync(join(home, "authorized_keys"), "utf8");
    expect(file.trim()).toBe(line);
  });

  it("is idempotent: re-accepting an engine REPLACES its line, never duplicates", () => {
    const home = mkdtempSync(join(tmpdir(), "chm-d6ak2-"));
    acceptFedKey({ home, engineId: "studio", publicKey: ed25519PubKey(Buffer.alloc(32, 1)) });
    acceptFedKey({ home, engineId: "studio", publicKey: ed25519PubKey(Buffer.alloc(32, 2)) });   // re-accept, new key
    const lines = readFileSync(join(home, "authorized_keys"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);                                   // exactly one line for studio
    expect(lines[0]).toContain("chimera-fed:studio");
    const { blob } = validateSshPublicKey(ed25519PubKey(Buffer.alloc(32, 2)));
    expect(lines[0]).toContain(blob);                               // the LATEST key
  });

  it("keeps OTHER engines' lines when replacing one", () => {
    const home = mkdtempSync(join(tmpdir(), "chm-d6ak3-"));
    acceptFedKey({ home, engineId: "alpha", publicKey: ed25519PubKey(Buffer.alloc(32, 1)) });
    acceptFedKey({ home, engineId: "beta", publicKey: ed25519PubKey(Buffer.alloc(32, 2)) });
    acceptFedKey({ home, engineId: "alpha", publicKey: ed25519PubKey(Buffer.alloc(32, 3)) });   // replace alpha only
    const lines = readFileSync(join(home, "authorized_keys"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines.filter((l) => l.includes("chimera-fed:alpha")).length).toBe(1);
    expect(lines.filter((l) => l.includes("chimera-fed:beta")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Engine RPC surface: fed.network / .up / setAuthKey / sshkey.ensure / accept
// ---------------------------------------------------------------------------
function makeEngine(routes: Record<string, ExecReply>, opts?: { keychain?: InMemoryKeychain; calls?: string[][] }) {
  const home = makeHome();
  const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
  const keychain = opts?.keychain ?? new InMemoryKeychain();
  // netPathExists: () => false — the off-PATH tailscale-binary fallback must stay hermetic and
  // NOT see whatever the test/CI machine happens to have installed at a known absolute path.
  const engine = new Engine({ home, backends, keychain, netExec: fakeNetExec(routes, opts?.calls), netPathExists: () => false });
  return { engine, home, keychain };
}

describe("Engine D6 RPCs", () => {
  it("fed.network returns the probed status; installed:false without tailscale", async () => {
    const { engine } = makeEngine({ "tailscale status --json": { code: 1, errno: "ENOENT" } });
    expect(await engine.handle("fed.network", {})).toMatchObject({ installed: false, loggedIn: false });
  });

  it("fed.network.up surfaces the auth URL", async () => {
    const { engine } = makeEngine({
      "tailscale up": { stderr: "visit https://login.tailscale.com/a/xyz" },
      "tailscale status --json": { stdout: STATUS_NEEDS_LOGIN, code: 1 },
    });
    expect(await engine.handle("fed.network.up", {})).toEqual({ authUrl: "https://login.tailscale.com/a/xyz" });
  });

  it("fed.tailscale.setAuthKey stores to the Keychain and returns no key", async () => {
    const keychain = new InMemoryKeychain();
    const { engine } = makeEngine({}, { keychain });
    const res = await engine.handle("fed.tailscale.setAuthKey", { key: "tskey-auth-STOREME1234567890" });
    expect(res).toEqual({ ok: true });
    expect(await keychain.get(TAILSCALE_AUTHKEY_SERVICE)).toBe("tskey-auth-STOREME1234567890");
    expect(JSON.stringify(res)).not.toMatch(/tskey-/);
  });

  it("fed.sshkey.ensure generates via the ssh-keygen seam and returns the pubkey; idempotent", async () => {
    const calls: string[][] = [];
    const pub = ed25519PubKey();
    // Fake ssh-keygen: writes the key files the way the real one would (0600 private + .pub).
    const routes: Record<string, ExecReply> = {
      "ssh-keygen": (args) => {
        const f = args[args.indexOf("-f") + 1]!;
        writeFileSync(f, "PRIVATE", { mode: 0o600 });
        writeFileSync(`${f}.pub`, `${pub}\n`);
        return { code: 0 };
      },
    };
    const { engine, home } = makeEngine(routes, { calls });
    const r1 = await engine.handle("fed.sshkey.ensure", {}) as { publicKey: string };
    expect(r1.publicKey).toBe(pub);
    expect(existsSync(join(home, "fed_ssh_key"))).toBe(true);
    const r2 = await engine.handle("fed.sshkey.ensure", {}) as { publicKey: string };
    expect(r2.publicKey).toBe(pub);
    expect(calls.filter((c) => c[0] === "ssh-keygen").length).toBe(1);   // only generated ONCE
  });

  it("fed.accept binds a restricted line for a valid key; rejects a malformed one", async () => {
    const { engine, home } = makeEngine({});
    const res = await engine.handle("fed.accept", { engineId: "peerx", publicKey: ed25519PubKey() }) as { line: string };
    expect(res.line.startsWith("restrict,port-forwarding ")).toBe(true);
    expect(readFileSync(join(home, "authorized_keys"), "utf8")).toContain("chimera-fed:peerx");
    await expect(engine.handle("fed.accept", { engineId: "peerx", publicKey: "garbage" })).rejects.toMatchObject({ code: "protocol" });
  });
});

// ---------------------------------------------------------------------------
// Redaction sweep — NO tailscale key in ANY D6 response OR event/log
// ---------------------------------------------------------------------------
describe("redaction sweep — no secret in any D6 RPC response or event", () => {
  it("serializes every D6 response + the event log and asserts /tskey-/ never matches", async () => {
    const TSKEY = "tskey-auth-liveSWEEP1234567890abcdef";
    const home = makeHome();
    const keychain = new InMemoryKeychain();
    const calls: string[][] = [];
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const routes: Record<string, ExecReply> = {
      // logged-out so autoJoin attempts a join; the join FAILS with the key echoed back.
      "tailscale status --json": { stdout: STATUS_NEEDS_LOGIN, code: 1 },
      "tailscale up --auth-key": { stderr: `invalid key ${TSKEY}`, code: 1 },
      "tailscale up": { stderr: "visit https://login.tailscale.com/a/abc" },
      "ssh-keygen": (args) => {
        const f = args[args.indexOf("-f") + 1]!;
        writeFileSync(f, "PRIVATE", { mode: 0o600 });
        writeFileSync(`${f}.pub`, ed25519PubKey() + "\n");
        return { code: 0 };
      },
    };
    const engine = new Engine({ home, backends, keychain, netExec: fakeNetExec(routes, calls), netPathExists: () => false });
    const captured: unknown[] = [];
    const events: NormalizedEvent[] = [];
    engine.events.subscribe((e) => events.push(e));
    const cap = async (m: string, p: unknown) => { try { captured.push(await engine.handle(m, p)); } catch (e) { captured.push(e); } };

    await cap("fed.tailscale.setAuthKey", { key: TSKEY });   // key in params, NEVER in response
    await cap("fed.network", {});
    await cap("fed.network.up", {});
    await cap("fed.sshkey.ensure", {});
    await cap("fed.accept", { engineId: "peerx", publicKey: ed25519PubKey() });
    await engine.autoJoinNetwork();                          // fails, emits network_error (scrubbed)

    const blob = JSON.stringify(captured) + JSON.stringify(events);
    expect(blob).not.toContain(TSKEY);
    expect(blob).not.toMatch(/tskey-/);
    // sanity: the failure path actually ran (a network_error was emitted)
    expect(events.some((e) => e.kind === "network_error")).toBe(true);
  });
});
