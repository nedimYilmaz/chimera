import { createConnection, createServer, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { PROTOCOL_VERSION, decodeFrames, encodeFrame, type RpcRequest } from "@chimera/protocol";
import type { Engine } from "@chimera/core/engine";
import { log, logError } from "./logger.js";

// Per-connection ceiling on bytes written but not yet read by the client. Node keeps an unread
// string write queue in the V8 heap and neither responses nor events apply backpressure, so a
// stalled client used to grow it until the daemon died of heap exhaustion (four OOM crashes, all
// in the response encode). Measured normal peak for the desktop app: 56 MB. Dropping the
// connection is safe: clients reconnect with backoff and re-subscribe.
const MAX_QUEUED_BYTES = 256 * 1024 * 1024;
// Match both desktop and SDK clients' 32 MiB frame ceiling.
// A bounded error lets history readers ask for fewer events on the same socket.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export async function startRpcServer(opts: { socketPath: string; engine: Engine; onStop?: () => void; maxQueuedBytes?: number }) {
  const maxQueuedBytes = opts.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const writeBounded = (sock: Socket, frame: string): void => {
    if (sock.destroyed) return;
    sock.write(frame);
    if (sock.writableLength > maxQueuedBytes) {
      log("warn", "rpc", "dropping a client that stopped reading", { queuedBytes: sock.writableLength, maxQueuedBytes });
      sock.destroy();
    }
  };
  const namedPipe = opts.socketPath.startsWith("\\\\.\\pipe\\");
  if (!namedPipe && existsSync(opts.socketPath)) {
    const before = lstatSync(opts.socketPath);
    if (!before.isSocket()) throw new Error("Refusing to replace a non-socket file at the daemon endpoint");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(opts.socketPath);
      probe.setTimeout(1000);
      probe.once("connect", () => { probe.destroy(); reject(new Error("A daemon is already listening at this endpoint")); });
      // Boot work can hold the loop past this timeout right after the probe connects. libuv then
      // runs the expired timer BEFORE the pending phase that delivers a stale socket's immediate
      // ECONNREFUSED, so deciding here crash-looped every restart after an unclean exit. A
      // setImmediate lands after that pending phase; only a probe still undecided then is a hang.
      probe.once("timeout", () => setImmediate(() => {
        if (probe.destroyed) return;
        probe.destroy();
        reject(new Error("Cannot establish whether the existing daemon endpoint is stale"));
      }));
      probe.once("error", (err: NodeJS.ErrnoException) => {
        probe.destroy();
        if (err.code === "ECONNREFUSED" || err.code === "ENOENT") resolve();
        else reject(err);
      });
    });
    if (existsSync(opts.socketPath)) {
      const after = lstatSync(opts.socketPath);
      if (!after.isSocket() || before.dev !== after.dev || before.ino !== after.ino) throw new Error("Daemon endpoint changed while checking ownership");
      unlinkSync(opts.socketPath);
    }
  }

  const sockets = new Set<Socket>();   // track live connections so close() can force them shut

  // EVENT-FANOUT-ONE-ENCODE: every subscriber used to hold its OWN engine.events.subscribe
  // closure, so one event was JSON-encoded once PER CONNECTION — measured at 11 live sockets on
  // an operator's machine, that is eleven identical stringifies of the same object, on the one
  // thread that also has to answer every RPC. The daemon's main thread spent more time in event
  // encode + socket write than in anything else, and RPC replies queue behind whatever it is
  // doing, which is what "all the RPCs are slow" actually was.
  //
  // One registry, one engine subscription, one encode per event no matter how many sockets want
  // it. The per-connection semantics are unchanged: a re-subscribe REPLACES that connection's
  // filter (never merges), and a closed connection stops receiving immediately.
  const subscribers = new Map<Socket, string | null>();   // socket -> agentId filter (null = all)
  let unsubEngine: (() => void) | null = null;

  const startFanout = (): void => {
    if (unsubEngine) return;
    unsubEngine = opts.engine.events.subscribe((e) => {
      // Encoded LAZILY and at most once: a filtered-out event costs nothing, and an event every
      // subscriber wants still only pays for one stringify.
      let frame: string | null = null;
      for (const [sock, filter] of subscribers) {
        if (filter !== null && e.agentId !== filter) continue;
        frame ??= encodeFrame({ type: "event", event: e });
        writeBounded(sock, frame);
      }
    });
  };

  const handleConnection = (sock: Socket) => {
    sockets.add(sock);
    let buf = "";
    // StringDecoder buffers an incomplete multi-byte UTF-8 sequence split across
    // socket chunk boundaries instead of emitting replacement chars per chunk.
    const decoder = new StringDecoder("utf8");
    const unsub = (): void => { subscribers.delete(sock); };
    const respond = (id: string, ok: boolean, body: unknown) => {
      const frame = encodeFrame(ok ? { id, type: "response", ok, result: body }
                                  : { id, type: "response", ok, error: body as { code: string; message: string } });
      if (Buffer.byteLength(frame, "utf8") > MAX_RESPONSE_BYTES) {
        writeBounded(sock, encodeFrame({ id, type: "response", ok: false, error: {
          code: "response-too-large",
          message: "Response exceeds 32 MiB; request a smaller page or narrower range.",
        } }));
        return;
      }
      writeBounded(sock, frame);
    };

    sock.on("data", (chunk) => {
      buf += decoder.write(chunk);
      // Bound an unterminated frame before parsing; a local misbehaving client
      // must not exhaust the daemon's memory with an endless stream.
      if (Buffer.byteLength(buf, "utf8") > 32 * 1024 * 1024) { sock.destroy(); return; }
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const frame of frames) void dispatch(frame as RpcRequest);
    });
    // F21/D17: a disconnected client's declared capabilities (e.g. "ui.components")
    // must stop counting toward Engine.hasClientCap — release on every path a
    // connection can end, mirroring the existing unsub?.() cleanup.
    sock.on("close", () => { sockets.delete(sock); unsub(); opts.engine.releaseClientCaps(sock); });
    sock.on("error", () => { sockets.delete(sock); unsub(); opts.engine.releaseClientCaps(sock); });

    const dispatch = async (req: RpcRequest) => {
      if (req.type !== "request" || typeof req.id !== "string" || typeof req.method !== "string") return;
      switch (req.method) {
        case "daemon.hello": {
          // Unknown hello params (engineId, features, ...) are IGNORED — Phase 5
          // negotiates by feature flags without changing the frame shape.
          const v = (req.params as { protocolVersion?: number })?.protocolVersion;
          if (v !== PROTOCOL_VERSION)
            return respond(req.id, false, { code: "protocol", message: `protocol ${v} != daemon ${PROTOCOL_VERSION}; restart the daemon` });
          return respond(req.id, true, { ok: true, protocolVersion: PROTOCOL_VERSION, engineId: "local", features: [] });
        }
        case "subscribe": {
          // F21/D17: `clientCaps` is OPTIONAL and additive-only from the wire's point of
          // view — a re-subscribe that omits it (e.g. just changing the agentId filter)
          // leaves this connection's prior declaration untouched rather than clearing it.
          // Present ⇒ REPLACES the prior set (matches how `unsub` above always replaces
          // the event filter on re-subscribe, never merges).
          const { agentId, clientCaps } = (req.params as { agentId?: string; clientCaps?: string[] }) ?? {};
          if ((agentId !== undefined && typeof agentId !== "string") ||
              (clientCaps !== undefined && (!Array.isArray(clientCaps) || clientCaps.length > 256 || clientCaps.some(cap => typeof cap !== "string")))) {
            return respond(req.id, false, { code: "invalid_params", message: "subscribe requires a string agentId and an array of string clientCaps" });
          }
          subscribers.set(sock, agentId ?? null);   // REPLACES this connection's filter, as before
          startFanout();
          if (clientCaps) opts.engine.declareClientCaps(sock, clientCaps);
          return respond(req.id, true, { ok: true });
        }
        case "daemon.stop": {
          // Flush the ack to the OS *before* onStop tears the socket down. onStop
          // runs shutdown()->close()->socket.destroy() with no event-loop turn when
          // no agents are running; a plain respond() + synchronous onStop() would
          // reset this connection mid-write and the requester would never see the
          // {ok:true}. The write callback fires only once the bytes reach the kernel.
          sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true } }), () => opts.onStop?.());
          return;
        }
        default:
          try {
            // PERF-SPLIT-RTT: the app measures its status-ping round trip with performance.now()
            // around an await IN THE RENDERER, so a saturated renderer inflates the same number a
            // slow daemon would — "rtt 3007ms" cannot say which. These two stamps split it:
            //
            //   serverHandleMs    — how long the ENGINE took. Renderer stall cannot touch it.
            //   socketQueuedBytes — bytes already queued on this connection when the response was
            //                       written. Events and responses share one socket with no
            //                       backpressure, so this is the direct measure of a response
            //                       sitting behind an event burst; near-zero rules that out.
            //
            // Only on daemon.status (the ping the app already times) and additive, so no other
            // caller's shape changes. Whatever remains after subtracting these two from the app's
            // rtt is the renderer's own.
            const startedAt = performance.now();
            // Same-OS-user local client trust, not authenticated human intent.
            // MCP carries callerAgentId and remains on the agent-authority path.
            const result = await opts.engine.handle(req.method, req.params ?? {}, { trustedLocalClient: true });
            if (req.method === "daemon.status" && result !== null && typeof result === "object" && !Array.isArray(result)) {
              const stamped = result as Record<string, unknown>;
              stamped["serverHandleMs"] = Math.round((performance.now() - startedAt) * 10) / 10;
              stamped["socketQueuedBytes"] = sock.writableLength;
            }
            respond(req.id, true, result);
          } catch (err) {
            logError("rpc", `${req.method} handler threw`, err);
            // Engine.handle() already normalizes thrown errors into a plain {code,message}
            // object, but respond()/encodeFrame just JSON.stringify the body — if anything
            // ever throws a raw Error here instead, its .message is a non-enumerable own
            // property and silently disappears on the wire. Extract defensively so a caller
            // never sees a bare {"code":"..."} with no explanation (AUDIT-1).
            const e = err as { code?: unknown; message?: unknown };
            respond(req.id, false, {
              code: typeof e?.code === "string" ? e.code : "unknown",
              message: typeof e?.message === "string" && e.message.length > 0 ? e.message : String(err),
            });
          }
      }
    };
  };

  const server = createServer(handleConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: opts.socketPath, readableAll: false, writableAll: false }, resolve);
  });
  if (!namedPipe) chmodSync(opts.socketPath, 0o600);
  return {
    close: () => new Promise<void>((resolve) => {
      // EVENT-FANOUT-ONE-ENCODE: the shared subscription outlives any single connection, so it
      // is released HERE rather than on socket close. Without this a stopped server would keep
      // an engine listener alive — invisible in production (the process exits) but a real leak
      // across the many servers a test file starts.
      unsubEngine?.(); unsubEngine = null; subscribers.clear();
      // force-close live connections (a long-lived subscribe client never closes
      // on its own) so server.close() can't hang the daemon's shutdown forever
      for (const s of sockets) s.destroy();
      // Node owns cleanup of the socket it bound. A second manual unlink could
      // delete a replacement file/endpoint created after its close completed.
      server.close(() => resolve());
    }),
  };
}
