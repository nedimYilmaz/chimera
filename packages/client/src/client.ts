import { createConnection, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { chimeraHome, daemonEndpoint } from "@chimera/core/paths";
import {
  PROTOCOL_VERSION, decodeFrames, encodeFrame,
  type NormalizedEvent, type RpcFrame, type RpcResponse,
} from "@chimera/protocol";
import {
  buildFamilyClient, validateRpcResponse,
  type FamilyClient, type RpcCallOpts, type RpcMethod, type RpcRequestInputFor, type RpcResponseFor,
} from "@chimera/protocol/contract";

// plain-node launcher: resolves tsx from the chimera repo, works from any caller cwd
const DAEMON_BIN = fileURLToPath(new URL("../../daemon/bin/chimerad.js", import.meta.url));

function tryConnect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const onErr = (e: unknown) => reject(e);
    sock.once("connect", () => { sock.removeListener("error", onErr); resolve(sock); }); // hand a clean socket to the class handler
    sock.once("error", onErr);
  });
}

export class ChimeraClient {
  private buf = "";
  // StringDecoder buffers an incomplete multi-byte UTF-8 sequence split across
  // socket chunk boundaries instead of emitting replacement chars per chunk
  // (mirrors the daemon's server.ts fix for the same class of bug).
  private decoder = new StringDecoder("utf8");
  private nextId = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private eventSubs = new Set<(e: NormalizedEvent) => void>();
  private _closed = false;

  // lets a long-lived caller (e.g. the MCP server's call() helper) check
  // staleness BEFORE issuing a request, not just react to a rejected one —
  // a request written to an already-dead socket never resolves (the
  // error/close listeners below have already fired once and pending is empty).
  get closed(): boolean { return this._closed; }

  private constructor(private sock: Socket) {
    // TYPED-CLIENT-SDK: attach per-family method groups (client.queue.push(...), etc.) at
    // runtime — the `ChimeraClient extends FamilyClient` declaration merge below is what lets TS
    // see these statically; nothing enforces that at the type level, so this call is load-bearing.
    Object.assign(this, buildFamilyClient((method, params, opts) => this.call(method, params, opts)));
    sock.on("data", (chunk) => {
      this.buf += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buf, "utf8") > 32 * 1024 * 1024) { this.sock.destroy(); return; }
      const { frames, rest } = decodeFrames(this.buf);
      this.buf = rest;
      for (const f of frames) this.onFrame(f);
    });
    // If the daemon dies mid-call, settle every in-flight request with a STABLE
    // error shape — consumers get one {code:"disconnected"} whether the socket
    // died via an error (ECONNRESET/EPIPE) or a clean close — instead of hanging
    // the caller forever (mirrors server.ts's per-connection cleanup).
    const fail = (cause?: unknown) => {
      this._closed = true;
      const err = { code: "disconnected", message: "chimerad connection closed", cause };
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };
    sock.on("error", fail);
    sock.on("close", () => fail());
  }

  private onFrame(frame: RpcFrame): void {
    if (frame.type === "event") { for (const cb of this.eventSubs) cb(frame.event); return; }
    if (frame.type !== "response") return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    const r = frame as RpcResponse;
    r.ok ? p.resolve(r.result) : p.reject(r.error);
  }

  static async connect(
    opts: { home?: string; autostart?: boolean; env?: NodeJS.ProcessEnv; exitWithParent?: boolean } = {},
  ): Promise<ChimeraClient> {
    const env = opts.env ?? process.env;
    const home = opts.home ?? chimeraHome(env);
    const socketPath = daemonEndpoint(home);
    let sock: Socket;
    try {
      sock = await tryConnect(socketPath);
    } catch {
      if (opts.autostart === false) throw new Error(`chimerad not reachable at ${socketPath}`);
      mkdirSync(home, { recursive: true });
      const log = openSync(join(home, "daemon.log"), "a");        // spec §3: daemon diagnostics survive
      // ORPHANED-DAEMON-LEAK: every REAL caller (cli.ts, mcp/server.ts) omits `home` and resolves
      // the operator's persistent ~/.chimera — that daemon must keep running after this short-lived
      // process exits, so it stays detached+unref'd with no lifetime tie by default. An explicit
      // `home` (every test/e2e call site: always a one-off mkdtempSync tmpdir) means the caller owns
      // an isolated, throwaway daemon that must NOT outlive this process — without a tie, an
      // assertion throwing before an explicit daemon.stop, or this process being hard-killed
      // (worktree teardown, CI timeout), orphans it forever (ppid 1, alive for days; this is exactly
      // how 49 test-spawned chimerad processes leaked across worktrees). `exitWithParent` stays
      // explicitly overridable in both directions.
      const exitWithParent = opts.exitWithParent ?? opts.home !== undefined;
      const child = spawn(process.execPath, [DAEMON_BIN], {
        detached: true, stdio: ["ignore", log, log],
        env: { ...env, CHIMERA_HOME: home, ...(exitWithParent ? { CHIMERA_PARENT_PID: String(process.pid) } : {}) },
      });
      child.unref();
      closeSync(log);                                             // the detached child keeps its own dup; don't leak our fd

      sock = await (async () => {
        // 20s, not 5s: a cold boot must tsx-transpile the daemon's whole module graph
        // (backends/claude.ts, backends/codex.ts, ...) before it writes even its first log
        // line -- measured 4ms solo but >1.6s under concurrent-boot CPU contention on a
        // shared multi-agent host, and this host runs a live fleet by design (see CLAUDE.md).
        // Directly reproduced a same-invocation flake at 5s (empty daemon.log at the deadline,
        // then two immediate successes with nothing else changed) diagnosing this exact bug.
        const deadline = Date.now() + 20000;
        for (;;) {
          try { return await tryConnect(socketPath); }
          catch { if (Date.now() > deadline) throw new Error(`chimerad did not come up at ${socketPath}`); }
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
    }
    const client = new ChimeraClient(sock);
    await client.request("daemon.hello", { protocolVersion: PROTOCOL_VERSION });
    return client;
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    // A write to an already-dead socket doesn't reliably re-fire the 'error'/'close'
    // listeners that drive fail() (see the `closed` getter's comment above), so without
    // this guard the returned promise never settles -- it just hangs forever. Every
    // caller used to have to remember to check `.closed` first (only server.ts did);
    // now request() itself refuses instead of writing into the void.
    if (this._closed) {
      return Promise.reject<T>({ code: "disconnected", message: "chimerad connection closed" });
    }
    const id = String(++this.nextId);
    this.sock.write(encodeFrame({ id, type: "request", method, params }));
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  // FEATURE-8: the typed counterpart of request() for methods on @chimera/protocol/contract's
  // RPC_CONTRACT — `method` is checked against the known method names, and `params`/the
  // resolved value against that method's declared request/response schemas, at COMPILE time.
  // Just a typed wrapper over request() (no new runtime behavior BY DEFAULT): the daemon already
  // validates params server-side and this call trusts the wire, same as request() always has.
  // TYPED-CLIENT-SDK: `opts.validateResponse` is opt-in runtime response validation on top of
  // that — off by default, so existing callers (cli.ts's queue.* block) are unaffected.
  call<M extends RpcMethod>(method: M, params: RpcRequestInputFor<M>, opts?: RpcCallOpts): Promise<RpcResponseFor<M>> {
    const result = this.request<RpcResponseFor<M>>(method, params);
    return opts?.validateResponse ? result.then((value) => validateRpcResponse(method, value)) : result;
  }

  // F21/D17: `clientCaps` is OPTIONAL — a plain CLI caller (this class's only current
  // consumer, cli.ts) never passes it, so its subscribe stays byte-identical; a future
  // UI-capable caller can declare CLIENT_CAP_UI_COMPONENTS to opt fresh spawns into the
  // output-component vocabulary cheatsheet (see @chimera/core's supervisor.ts).
  async subscribe(filter: { agentId?: string; clientCaps?: string[] }, cb: (e: NormalizedEvent) => void): Promise<() => void> {
    this.eventSubs.add(cb);
    await this.request("subscribe", filter);
    return () => this.eventSubs.delete(cb);
  }

  close(): void { this.sock.end(); }   // graceful FIN; the daemon sees 'close' and unsubscribes. Node releases the fd once the peer closes.
}

// TYPED-CLIENT-SDK: declaration merge — this is what lets TS see client.queue.push(...) etc.
// statically. The actual properties are attached at runtime by the constructor's
// Object.assign(this, buildFamilyClient(...)) call above; nothing here enforces that the two
// stay in sync, so don't move/remove the constructor call without removing this too.
export interface ChimeraClient extends FamilyClient {}
