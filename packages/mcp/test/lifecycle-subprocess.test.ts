import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../bin/chimera-mcp.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/lifecycle-child.mjs", import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate: () => boolean, detail: () => string = () => "condition timed out") {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(detail());
    await delay(10);
  }
}

type Frame = { id: string; method: string; params: unknown };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } } };

async function harness(mode: "server" | "legacy" | "explicit" | "stuck" = "server", halfOpen = false) {
  const home = await mkdtemp(join(tmpdir(), "mcp-lifetime-"));
  const peers: Socket[] = [], requests: Frame[] = [], ended: Socket[] = [], closed: Socket[] = [];
  let onRequest: ((peer: Socket, frame: Frame) => boolean) | undefined;
  const reply = (peer: Socket, frame: Frame, result: unknown = {}) => peer.write(JSON.stringify({ type: "response", id: frame.id, ok: true, result }) + "\n");
  // Matches the real daemon's default allowHalfOpen:false. Optional half-open mode
  // demonstrates why FIN-only client.close cannot promise exit against every peer.
  const daemon = createServer({ allowHalfOpen: halfOpen }, peer => {
    peers.push(peer);
    peer.on("error", () => {});
    peer.on("end", () => ended.push(peer));
    peer.on("close", () => closed.push(peer));
    let input = "";
    peer.on("data", chunk => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const frame = JSON.parse(input.slice(0, newline)) as Frame;
        input = input.slice(newline + 1);
        requests.push(frame);
        if (onRequest?.(peer, frame)) continue;
        reply(peer, frame, frame.method === "mcpstore.list" ? [] : { live: true });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { daemon.once("error", reject); daemon.listen(join(home, "daemon.sock"), resolve); });
  const child = spawn(process.execPath, mode === "server" ? [entrypoint] : [fixture, mode], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", CHIMERA_HOME: home },
  });
  child.stdin.on("error", () => {});
  let stderr = "", stdout = "", exit: { code: number | null; signal: string | null } | undefined;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("exit", (code, signal) => { exit = { code, signal }; });
  let childClosed = false;
  child.on("close", () => { childClosed = true; });
  const waitClosed = (milliseconds: number): Promise<boolean> => new Promise(resolve => {
    if (childClosed) { resolve(true); return; }
    const onClose = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("close", onClose); resolve(false); }, milliseconds);
    child.once("close", onClose);
  });
  const diagnostic = () => `exit=${JSON.stringify(exit)} stderr=${stderr} stdout=${stdout}`;
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const hasResponse = (id: number) => stdout.split("\n").some(line => { try { return JSON.parse(line).id === id; } catch { return false; } });
  const ready = async () => {
    send(initialize);
    await until(() => hasResponse(1), diagnostic);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  const waitExit = async (code = 0) => {
    await until(() => !!exit, diagnostic);
    expect(exit, diagnostic()).toEqual({ code, signal: null });
  };
  let cleanupPromise: Promise<{ escalated: boolean }> | undefined;
  const cleanup = (): Promise<{ escalated: boolean }> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let escalated = false;
      try {
        child.stdin.end();
        for (const peer of peers) peer.destroy();
        if (!await waitClosed(1500)) {
          // A failed assertion must not strand our synthetic process. The ChildProcess
          // object pins the only kill target; no PID scan or live daemon is involved.
          escalated = true;
          child.kill("SIGKILL");
          if (!await waitClosed(1500)) throw new Error(`fixture child did not close: ${diagnostic()}`);
        }
      } finally {
        try {
          for (const peer of peers) peer.destroy();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("fixture server close timed out")), 1500);
            daemon.close(() => { clearTimeout(timer); resolve(); });
          });
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      }
      return { escalated };
    })();
    return cleanupPromise;
  };
  return {
    child, peers, requests, ended, closed, reply, send, ready, hasResponse, waitExit, diagnostic,
    set onRequest(fn: typeof onRequest) { onRequest = fn; },
    get exit() { return exit; }, get stderr() { return stderr; },
    get childClosed() { return childClosed; },
    get serverListening() { return daemon.listening; },
    home, cleanup,
  };
}

describe("real MCP subprocess lifecycle", () => {
  it("cleans a failed stuck fixture with bounded owned-child fallback and removes its server/home", async () => {
    const f = await harness("stuck");
    try {
      await until(() => f.stderr.includes("ready"), f.diagnostic);
      let result: { escalated: boolean } | undefined;
      await expect((async () => {
        try { throw new Error("synthetic assertion failure"); }
        finally { result = await f.cleanup(); }
      })()).rejects.toThrow("synthetic assertion failure");
      expect(result).toEqual({ escalated: true });
      expect(f.exit).toEqual({ code: null, signal: "SIGKILL" });
      expect(f.childClosed).toBe(true);
      expect(f.serverListening).toBe(false);
      expect(f.closed).toHaveLength(1);
      await expect(access(f.home)).rejects.toMatchObject({ code: "ENOENT" });
      // Cleanup is idempotent even after its child, server and directory are gone.
      expect(await f.cleanup()).toEqual(result);
    } finally { await f.cleanup(); }
  });

  it("reproduces the pre-fix EOF hang with a referenced daemon socket", async () => {
    const f = await harness("legacy");
    try {
      await f.ready();
      f.child.stdin.end();
      await delay(250);
      expect(f.exit).toBeUndefined();
      expect(f.ended).toHaveLength(0);
      expect(f.peers).toHaveLength(1);
      f.peers[0].end();
      await f.waitExit();
    } finally { await f.cleanup(); }
  });

  it("keeps normal stdio usable, then EOF returns daemon FIN and exits naturally", async () => {
    const f = await harness();
    try {
      await f.ready();
      f.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "daemon_status", arguments: {} } });
      await until(() => f.hasResponse(2), f.diagnostic);
      expect(f.requests.some(frame => frame.method === "daemon.status")).toBe(true);
      expect(f.ended).toHaveLength(0);
      expect(f.exit).toBeUndefined();
      f.child.stdin.end();
      await f.waitExit();
      await until(() => f.closed.length === 1);
      expect(f.ended).toHaveLength(1);
      expect(f.peers).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it("backpressures early initialize/tool bytes during factory startup and drains them intact", async () => {
    const f = await harness();
    let held: { peer: Socket; frame: Frame } | undefined;
    try {
      f.onRequest = (peer, frame) => {
        if (frame.method !== "mcpstore.list") return false;
        held = { peer, frame }; return true;
      };
      await until(() => !!held, f.diagnostic);
      const query = "begin☃" + "x".repeat(2 * 1024 * 1024) + "終end";
      const bytes = [initialize,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { query, scope: "*" } } },
      ].map(value => JSON.stringify(value) + "\n").join("");
      let written = false;
      expect(f.child.stdin.write(bytes, () => { written = true; })).toBe(false);
      await delay(100);
      expect(written).toBe(false);
      expect(f.hasResponse(1)).toBe(false);
      expect(f.requests.map(frame => frame.method)).toEqual(["daemon.hello", "mcpstore.list"]);
      f.reply(held!.peer, held!.frame, []);
      await until(() => written && f.hasResponse(1) && f.hasResponse(2), f.diagnostic);
      const dispatched = f.requests.find(frame => frame.method === "memory.search");
      expect((dispatched?.params as { query?: string })?.query).toBe(query);
      f.child.stdin.end();
      await f.waitExit();
      await until(() => f.closed.length === 1);
      expect(f.ended).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it("EOF while factory mcpstore.list is pending closes its owned client and exits without a reply or redial", async () => {
    const f = await harness();
    let held: { peer: Socket; frame: Frame } | undefined;
    try {
      f.onRequest = (peer, frame) => {
        if (frame.method !== "mcpstore.list") return false;
        held = { peer, frame }; return true;
      };
      await until(() => !!held, f.diagnostic);
      f.send(initialize);
      f.child.stdin.end();
      // No daemon response is sent: peer FIN settles the pending client request.
      await f.waitExit();
      await until(() => f.closed.length === 1);
      expect(f.ended).toEqual([held!.peer]);
      expect(f.requests.map(frame => frame.method)).toEqual(["daemon.hello", "mcpstore.list"]);
      expect(f.hasResponse(1)).toBe(false);
      expect(f.stderr).toBe("");
    } finally { await f.cleanup(); }
  });

  it("reports SDK frame-buffer overflow and closes rather than silently dropping input", async () => {
    const f = await harness();
    try {
      await f.ready();
      f.child.stdin.write("x".repeat(11 * 1024 * 1024));
      await f.waitExit(1);
      await until(() => f.closed.length === 1);
      expect(f.stderr).toContain("stdio transport failed:");
      expect(f.stderr).toContain("ReadBuffer exceeded maximum size");
      expect(f.ended).toHaveLength(1);
      expect(f.requests.map(frame => frame.method)).toEqual(["daemon.hello", "mcpstore.list"]);
    } finally { await f.cleanup(); }
  });

  it("explicit protocol close releases the daemon socket with stdin still open", async () => {
    const f = await harness("explicit");
    try {
      await until(() => f.stderr.includes("ready"), f.diagnostic);
      f.child.stdin.write("\n");
      await f.waitExit();
      expect(f.child.stdin.writableEnded).toBe(false);
      await until(() => f.closed.length === 1);
      expect(f.ended).toHaveLength(1);
    } finally { await f.cleanup(); }
  }, 15000);

  it("preserves fatal startup exit when hello fails without returning an owned client", async () => {
    const f = await harness();
    try {
      f.onRequest = (peer, frame) => {
        peer.write(JSON.stringify({ type: "response", id: frame.id, ok: false, error: { code: "protocol", message: "test hello rejected" } }) + "\n");
        return true;
      };
      await f.waitExit(1);
      await until(() => f.closed.length === 1);
      expect(f.stderr).toContain("could not connect to (or start) chimerad");
      expect(f.requests.map(frame => frame.method)).toEqual(["daemon.hello"]);
    } finally { await f.cleanup(); }
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("%s releases both peers and exits with %i", async (signal, code) => {
    const f = await harness();
    try {
      await f.ready();
      f.child.kill(signal);
      await f.waitExit(code);
      await until(() => f.closed.length === 1);
      expect(f.ended).toHaveLength(1);
    } finally { await f.cleanup(); }
  });

  it.each(["startup", "reconnect"])("EOF during %s closes the late real client without further requests", async phase => {
    const f = await harness();
    let held: { peer: Socket; frame: Frame } | undefined;
    try {
      if (phase === "reconnect") await f.ready();
      f.onRequest = (peer, frame) => {
        if (frame.method !== "daemon.hello") return false;
        held = { peer, frame }; return true;
      };
      if (phase === "reconnect") {
        f.peers[0].end();
        await until(() => f.closed.length === 1);
        f.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "daemon_status", arguments: {} } });
      }
      await until(() => !!held, f.diagnostic);
      f.child.stdin.end();
      await delay(100);
      // Connect has not returned an owned client yet: EOF alone cannot cancel its hello.
      expect(f.exit).toBeUndefined();
      const count = f.requests.length;
      f.reply(held!.peer, held!.frame);
      await f.waitExit();
      await until(() => f.closed.length === f.peers.length);
      expect(f.ended).toContain(held!.peer);
      expect(f.requests).toHaveLength(count);
    } finally { await f.cleanup(); }
  });

  it("does not hide FIN-only close's noncooperative-peer limit", async () => {
    const f = await harness("server", true);
    try {
      await f.ready();
      f.child.stdin.end();
      await until(() => f.ended.length === 1);
      await delay(150);
      expect(f.exit).toBeUndefined();
      expect(f.closed).toHaveLength(0);
      f.peers[0].end();
      await f.waitExit();
    } finally { await f.cleanup(); }
  });
});
