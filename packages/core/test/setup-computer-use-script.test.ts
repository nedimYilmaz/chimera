// scripts/setup-computer-use.ts is a CLI: it is exercised as a real child process against a
// temporary CHIMERA_HOME and, where it talks to the daemon, a loopback fake speaking the
// newline-framed RPC protocol -- so no real daemon or user home is ever touched.
import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, decodeFrames, type RpcRequest } from "@chimera/protocol";
import { daemonEndpoint } from "@chimera/core/paths";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/setup-computer-use.ts");

let cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = []; });

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "chimera-cu-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const file = (name: string) => { const p = join(home, name); writeFileSync(p, ""); return p; };
  return { home, laya: file("python"), cli: file("cli.js"), driver: file("driver") };
}

function run(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CHIMERA_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("CHIMERA_") && key !== "CHIMERA_HOME") delete env[key];
  return new Promise(resolve => {
    execFile(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: ROOT, env, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function fakeDaemon(home: string, existing: unknown[]) {
  const calls: RpcRequest[] = [];
  const server: Server = createServer(sock => {
    let buf = "";
    sock.on("data", chunk => {
      const { frames, rest } = decodeFrames(buf + chunk.toString("utf8")); buf = rest;
      for (const frame of frames) {
        const req = frame as RpcRequest;
        calls.push(req);
        const result = req.method === "daemon.hello" ? { ok: true, protocolVersion: 1 }
          : req.method === "mcpstore.list" ? existing
          : { ok: true };
        sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(daemonEndpoint(home), resolve); });
  cleanup.push(() => new Promise<void>(r => server.close(() => r())));
  return calls;
}

describe("scripts/setup-computer-use", () => {
  it("--write-config writes the parsed browser-only entries to prepared.json with mode 0600", async () => {
    const s = sandbox();
    const result = await run(s.home, ["--laya-python", s.laya, "--playwright-cli", s.cli, "--write-config"]);
    expect(result.code).toBe(0);
    const prepared = join(s.home, "computer-use", "prepared.json");
    const { entries } = JSON.parse(readFileSync(prepared, "utf8")) as { entries: Array<{ name: string; command: string }> };
    expect(entries.map(e => e.name)).toEqual(["laya", "chimera-browser"]);
    expect(entries[0]!.command).toBe(s.laya);
    expect(statSync(prepared).mode & 0o777).toBe(0o600);
  });

  it("--write-config with a desktop driver prepares all three entries", async () => {
    const s = sandbox();
    const result = await run(s.home, ["--laya-python", s.laya, "--playwright-cli", s.cli, "--desktop-driver", s.driver, "--write-config"]);
    expect(result.code).toBe(0);
    const prepared = join(s.home, "computer-use", "prepared.json");
    const { entries } = JSON.parse(readFileSync(prepared, "utf8")) as { entries: Array<{ name: string }> };
    expect(entries.map(e => e.name)).toEqual(["laya", "chimera-browser", "chimera-desktop"]);
    expect(statSync(prepared).mode & 0o777).toBe(0o600);
  });

  it("exits non-zero with the usage text when --laya-python is missing", async () => {
    const s = sandbox();
    const result = await run(s.home, ["--playwright-cli", s.cli, "--write-config"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Usage: node --import tsx scripts/setup-computer-use.ts");
  });

  it("aborts without adding anything when an existing registry entry differs", async () => {
    const s = sandbox();
    const calls = await fakeDaemon(s.home, [{ name: "laya", command: "/elsewhere/python" }]);
    const result = await run(s.home, ["--laya-python", s.laya, "--playwright-cli", s.cli]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Existing laya configuration differs; it was preserved");
    expect(calls.map(c => c.method)).toContain("mcpstore.list");
    expect(calls.some(c => c.method === "mcpstore.add")).toBe(false);
  });

  it("aborts without adding anything and preserves a differing desktop.json byte-for-byte", async () => {
    const s = sandbox();
    const calls = await fakeDaemon(s.home, []);
    const desktop = join(s.home, "computer-use", "desktop.json");
    mkdirSync(join(s.home, "computer-use"), { recursive: true });
    const original = '{ "driverPath": "/someone/else", "socketPath": "/elsewhere.sock" }\n';
    writeFileSync(desktop, original);
    const result = await run(s.home, ["--laya-python", s.laya, "--playwright-cli", s.cli, "--desktop-driver", s.driver]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Existing desktop host configuration differs");
    expect(readFileSync(desktop, "utf8")).toBe(original);
    expect(calls.map(c => c.method)).toContain("mcpstore.list");
    expect(calls.some(c => c.method === "mcpstore.add")).toBe(false);
  });
});
