import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { InMemoryKeychain } from "@chimera/core/keychain";
import {
  validateSshPublicKey, acceptFedKey, FED_AUTHORIZED_KEYS_OPTIONS,
  type NetExecFn, type NetExecResult,
} from "@chimera/core/network";

// ---------------------------------------------------------------------------
// Fakes: a scriptable NetExecFn keyed on the command line; a stub keychain lives in
// InMemoryKeychain. NO real ssh-keygen process ever runs (D0 token-free).
// ---------------------------------------------------------------------------
type ExecReply = Partial<NetExecResult> | ((args: string[]) => Partial<NetExecResult>);
function fakeNetExec(routes: Record<string, ExecReply>, calls?: string[][]): NetExecFn {
  return async (cmd, args) => {
    calls?.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    // Match command prefixes so the fake can handle generated key paths.
    const match = Object.keys(routes).filter((k) => key.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const r = match ? routes[match]! : {};
    const resolved = typeof r === "function" ? r(args) : r;
    return { stdout: "", stderr: "", code: 0, ...resolved };
  };
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chm-d6-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    engine: { id: "studio" },
  }));
  return home;
}

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
// Engine RPC surface: fed.sshkey.ensure / fed.accept
// ---------------------------------------------------------------------------
function makeEngine(routes: Record<string, ExecReply>, opts?: { keychain?: InMemoryKeychain; calls?: string[][] }) {
  const home = makeHome();
  const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
  const keychain = opts?.keychain ?? new InMemoryKeychain();
  const engine = new Engine({ home, backends, keychain, netExec: fakeNetExec(routes, opts?.calls) });
  return { engine, home, keychain };
}

describe("Engine D6 RPCs", () => {
  it.each(["fed.network", "fed.network.up", "fed.tailscale.setAuthKey"])("rejects retired RPC %s without running a command", async (method) => {
    const calls: string[][] = [];
    const { engine } = makeEngine({}, { calls });
    await expect(engine.handle(method, {})).rejects.toMatchObject({ code: "protocol", message: `unknown method "${method}"` });
    expect(calls).toEqual([]);
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
