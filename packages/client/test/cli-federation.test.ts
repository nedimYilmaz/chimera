import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { encodeFrame, decodeFrames, type RpcRequest } from "@chimera/protocol";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ stdout: string; code: number }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", CLI, ...args], { env: env as Record<string, string> },
      (err, stdout) => resolve({ stdout, code: err ? 1 : 0 }));
  });
// `federation init` prints the JSON pairing block followed by a plain-text "# tip: ..."
// line — parse just the JSON portion (up to the trailing comment) rather than the whole stdout.
const parsePairingBlock = (stdout: string): { engineId: string; publicKey: string; federationSocket: string; pasteIntoPeerConfig: Record<string, unknown> } =>
  JSON.parse(stdout.slice(0, stdout.indexOf("\n# tip")));

describe("chimera federation init", () => {
  it("creates the engine key and prints the pairing block", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-cli-fed-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"], engine: { id: "mbp" },
    }));
    const { stdout, code } = await run(["federation", "init"], { ...process.env, CHIMERA_HOME: home });
    expect(code).toBe(0);
    expect(existsSync(join(home, "engine_key"))).toBe(true);
    expect(stdout).toContain("mbp");                                    // engineId echoed
    expect(stdout).toContain("publicKey");                              // pairing block
    expect(stdout).toContain("federation.sock");
    const parsed = parsePairingBlock(stdout);
    expect(parsed.engineId).toBe("mbp");
    expect(parsed.federationSocket).toBe(join(home, "federation.sock"));
    expect(parsed.pasteIntoPeerConfig).toMatchObject({ engineId: "mbp", publicKey: parsed.publicKey, allowSpawn: false, accounts: [] });
    // secrets never printed: the PRIVATE key material must never appear on stdout
    const privateKeyPem = readFileSync(join(home, "engine_key"), "utf8");
    expect(stdout).not.toContain(privateKeyPem.trim());
    expect(stdout).not.toContain("PRIVATE KEY");

    const keyBytesBefore = readFileSync(join(home, "engine_key"));
    const again = await run(["federation", "init"], { ...process.env, CHIMERA_HOME: home });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("publicKey");                        // idempotent — same key, no regeneration
    const keyBytesAfter = readFileSync(join(home, "engine_key"));
    expect(keyBytesAfter.equals(keyBytesBefore)).toBe(true);             // engine_key file itself is byte-identical, not just "some key"
    expect(parsePairingBlock(again.stdout).publicKey).toBe(parsed.publicKey);   // and the reported publicKey is the SAME key, not a freshly generated one
  }, 20_000);

  it("prints the unset-engineId warning when config.json has no engine.id", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-cli-fed-noeng-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }], autoOrder: ["main"],
    }));
    const { stdout, code } = await run(["federation", "init"], { ...process.env, CHIMERA_HOME: home });
    expect(code).toBe(0);
    expect(existsSync(join(home, "engine_key"))).toBe(true);
    expect(stdout).toContain("<unset - add engine.id to config.json>");
  }, 20_000);

  it("falls back to the unset-engineId warning when config.json is missing entirely", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-cli-fed-nocfg-"));
    const { stdout, code } = await run(["federation", "init"], { ...process.env, CHIMERA_HOME: home });
    expect(code).toBe(0);
    expect(existsSync(join(home, "engine_key"))).toBe(true);
    expect(stdout).toContain("<unset - add engine.id to config.json>");
  }, 20_000);

  it("falls back to the unset-engineId warning when config.json is malformed JSON (catch, not crash)", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-cli-fed-badcfg-"));
    writeFileSync(join(home, "config.json"), "{ not valid json");
    const { stdout, code } = await run(["federation", "init"], { ...process.env, CHIMERA_HOME: home });
    expect(code).toBe(0);
    expect(existsSync(join(home, "engine_key"))).toBe(true);
    expect(stdout).toContain("<unset - add engine.id to config.json>");
  }, 20_000);
});

describe("chimera federation — usage errors", () => {
  it("exits 1 with a usage message when no subcommand is given", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-cli-fed-usage-"));
    const { code } = await run(["federation"], { ...process.env, CHIMERA_HOME: home });
    expect(code).toBe(1);
    expect(existsSync(join(home, "engine_key"))).toBe(false);   // no key-gen side effect on a bad invocation
  }, 20_000);

  it("exits 1 with a usage message for an unknown subcommand", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-cli-fed-usage2-"));
    const { code } = await run(["federation", "bogus"], { ...process.env, CHIMERA_HOME: home });
    expect(code).toBe(1);
  }, 20_000);
});

// ---------- fake daemon for exact-wire coverage of `federation status` (mirrors cli.test.ts's
// startFakeDaemon: a real chimerad round-trip can't hand back a canned peers[] array without a
// full two-engine federation rig, which Tasks 8-12 already exercise end-to-end — this is a
// minimal stand-in that answers daemon.hello + daemon.status directly, exercising only the
// rendering branches this task's CLI code owns).
async function startFakeDaemon(
  respond: (req: RpcRequest) => { result?: unknown; error?: { code: string; message: string } },
): Promise<{ home: string; close: () => Promise<void> }> {
  const fakeHome = mkdtempSync(join(tmpdir(), "chimera-cli-fed-status-fake-"));
  const socketPath = join(fakeHome, "daemon.sock");
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        const req = f as RpcRequest;
        if (req.type !== "request") continue;
        if (req.method === "daemon.hello") {
          sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
          continue;
        }
        const r = respond(req);
        sock.write(encodeFrame(r.error
          ? { id: req.id, type: "response", ok: false, error: r.error }
          : { id: req.id, type: "response", ok: true, result: r.result }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    home: fakeHome,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

describe("chimera federation status", () => {
  it("unfederated engine (peers: []) prints the engine id and 'no peers configured'", async () => {
    const fake = await startFakeDaemon(() => ({ result: { engineId: "local", peers: [] } }));
    try {
      const { stdout, code } = await run(["federation", "status"], { ...process.env, CHIMERA_HOME: fake.home });
      expect(code).toBe(0);
      expect(stdout).toContain("engine: local");
      expect(stdout).toContain("no peers configured");
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("prints one tab-separated line per peer and omits the 'no peers configured' line", async () => {
    const fake = await startFakeDaemon(() => ({
      result: { engineId: "mbp", peers: [
        { engineId: "studio", state: "connected", outboxPending: 0 },
        { engineId: "vm", state: "connecting", outboxPending: 3 },
      ] },
    }));
    try {
      const { stdout, code } = await run(["federation", "status"], { ...process.env, CHIMERA_HOME: fake.home });
      expect(code).toBe(0);
      expect(stdout).toContain("engine: mbp");
      expect(stdout).not.toContain("no peers configured");
      expect(stdout).toContain("studio\tconnected\toutbox:0");
      expect(stdout).toContain("vm\tconnecting\toutbox:3");
    } finally {
      await fake.close();
    }
  }, 20_000);
});
