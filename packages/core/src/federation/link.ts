import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encodeFrame, type EngineCard, type PeerConfig, type RpcResponse } from "@chimera/protocol";
import { InitiatorHandshake } from "./handshake.js";
import type { EngineIdentity } from "./identity.js";

export class PeerUnreachableError extends Error {
  code = "peer-unreachable" as const;
}
export type LinkState = "connecting" | "connected" | "partitioned";
export type PeerLinkOpts = {
  peer: PeerConfig; identity: EngineIdentity; card: EngineCard;
  reconnectBaseMs?: number;   // default 1000, doubles to max 60000, ±20% jitter (tests pass 10)
  heartbeatMs?: number;       // default 15000 — peer.ping; a failed ping partitions the link (tests pass 50)
  onStateChange?: (state: LinkState) => void;
};

// Peer RESPONSE frames are UNTRUSTED input (Phase-5 deferred MUST): every established-phase
// frame is schema-validated before being treated as a correlated RPC response. An invalid
// frame is SKIPPED (a no-op) — never sock.destroy()'d — so a single garbage frame from a
// misbehaving/compromised peer can't force a reconnect storm; the correlated request's own
// timeout will fire PeerUnreachableError instead. Mirrors daemon federation.ts's established-
// phase handling of malformed frames.
const RpcResp = z.object({
  id: z.string().min(1),
  type: z.literal("response"),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

/**
 * Local defensive line-decoder for untrusted peer ingress. Mirrors daemon federation.ts's
 * decodePeerFrames: the shared @chimera/protocol decodeFrames does a bare JSON.parse that
 * THROWS on one complete-but-malformed line, which would otherwise force a sock.destroy() ->
 * reconnect over a single bad frame (a trivial DoS/reconnect-storm vector). Here a torn/
 * garbage complete line is just skipped — never fatal. The shared decodeFrames is untouched.
 */
function decodePeerFrames(buf: string): { frames: unknown[]; rest: string } {
  const frames: unknown[] = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl === -1) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // torn/garbage complete line — skip it, never wedge or kill the link
    }
  }
  return { frames, rest };
}

/**
 * PeerLink (spec §3.9): the INITIATOR side of a federated link. Dials `peer.socketPath`
 * (SSH forwarding, if any, is invisible here), runs InitiatorHandshake, then serves fail-fast
 * `request()` calls over the established RPC channel. `request()` NEVER queues — queuing while
 * partitioned is the outbox's job (and only for mailbox.forward). Socket close/error/heartbeat-
 * failure -> partitioned, every in-flight request rejected, and a jittered-backoff reconnect
 * loop takes over; a clean handshake resets backoff to base and republishes "connected".
 */
export class PeerLink {
  state: LinkState = "connecting";
  peerCard: EngineCard | null = null;
  private sock: Socket | null = null;
  private buf = "";
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private backoffMs: number;
  private stopped = false;
  private started = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private opts: PeerLinkOpts) {
    this.backoffMs = opts.reconnectBaseMs ?? 1000;
  }

  /** The static peer config this link dials — the FederationManager reads its transport fields
   *  to decide whether a config change needs a link rebuild (D7/D8 live diff-apply). */
  get peerConfig() { return this.opts.peer; }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private setState(s: LinkState) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const hs = new InitiatorHandshake(
      { identity: this.opts.identity, card: this.opts.card, peerKeys: new Map([[this.opts.peer.engineId, this.opts.peer.publicKey]]) },
      this.opts.peer.engineId,
    );
    let phase: "challenge" | "welcome" | "established" = "challenge";
    const sock = createConnection(this.opts.peer.socketPath);
    this.sock = sock;
    this.buf = "";
    // StringDecoder buffers an incomplete multi-byte UTF-8 sequence split across socket chunk
    // boundaries instead of emitting replacement chars per chunk. Fresh instance PER CONNECTION
    // (connect() reruns on every reconnect) so no stale partial-sequence state leaks across links.
    const decoder = new StringDecoder("utf8");
    sock.on("connect", () => sock.write(encodeFrame(hs.hello() as never)));
    sock.on("data", (chunk) => {
      this.buf += decoder.write(chunk);
      const { frames, rest } = decodePeerFrames(this.buf);
      this.buf = rest;
      for (const f of frames) {
        if (phase === "challenge") {
          try { sock.write(encodeFrame(hs.onChallenge(f) as never)); phase = "welcome"; }
          catch { return sock.destroy(); }             // forged proof / malformed challenge / FedError -> destroy -> reconnect
        } else if (phase === "welcome") {
          try {
            this.peerCard = hs.onWelcome(f);
            phase = "established";
            this.backoffMs = this.opts.reconnectBaseMs ?? 1000;   // clean handshake resets backoff
            this.setState("connected");
            this.startHeartbeat();
          } catch { return sock.destroy(); }             // malformed welcome / FedError -> destroy -> reconnect
        } else {
          // established: peer RESPONSE frames are UNTRUSTED — validate, SKIP (never destroy) on failure.
          const parsed = RpcResp.safeParse(f);
          if (!parsed.success) continue;
          this.onResponse(parsed.data as RpcResponse);
        }
      }
    });
    // Node always fires BOTH 'error' (e.g. ECONNRESET/ECONNREFUSED) and 'close' for one broken
    // socket. Without this per-socket dedup guard, onDisconnect() runs TWICE for the same
    // disconnection: the first call schedules the next backoff-reconnect timer, and the second
    // call's own timer sweep (`this.timers.splice(0)`) would immediately cancel that
    // freshly-scheduled timer (its guard sees state already "partitioned" and returns without
    // rescheduling) — silently wedging the link in "partitioned" with no pending reconnect.
    let down = false;
    const onDown = () => { if (down) return; down = true; this.onDisconnect(); };
    sock.on("error", onDown);
    sock.on("close", onDown);
  }

  private startHeartbeat(): void {
    const ms = this.opts.heartbeatMs ?? 15_000;
    const t = setInterval(() => {
      this.request("peer.ping", {}, ms).catch(() => this.sock?.destroy());   // dead tunnel vs dead daemon (synthesis §3.9)
    }, ms);
    this.timers.push(t);
  }

  private onDisconnect(): void {
    for (const t of this.timers.splice(0)) clearInterval(t);
    for (const { reject } of this.pending.values()) reject(new PeerUnreachableError(`peer "${this.opts.peer.engineId}" disconnected`));
    this.pending.clear();
    this.buf = "";
    if (this.stopped || this.state === "partitioned") return;   // guard against double-schedule (error+close both fire)
    this.setState("partitioned");
    const delay = this.backoffMs * (0.8 + Math.random() * 0.4);       // ±20% jitter
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    const t = setTimeout(() => { if (!this.stopped) this.connect(); }, delay);
    this.timers.push(t as unknown as NodeJS.Timeout);
  }

  private onResponse(frame: RpcResponse): void {
    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    // error is optional on the wire; an untrusted peer can send {ok:false} with no body.
    // Always reject with a well-formed {code,message} so downstream `err.code` checks
    // (FederationManager) never throw on `undefined.code`.
    if (frame.ok) waiter.resolve(frame.result);
    else waiter.reject(frame.error ?? { code: "protocol", message: "peer returned an error response with no error body" });
  }

  async request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (this.state !== "connected" || !this.sock)
      throw new PeerUnreachableError(`peer "${this.opts.peer.engineId}" is ${this.state}`);
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PeerUnreachableError(`peer "${this.opts.peer.engineId}" timed out on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock!.write(encodeFrame({ id, type: "request", method, params }));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearInterval(t);
    this.sock?.destroy();
    this.sock = null;
  }
}
