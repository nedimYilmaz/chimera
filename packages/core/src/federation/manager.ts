import { parseAgentAddress, type EngineCard, type PeerConfig } from "@chimera/protocol";
import { PeerLink, PeerUnreachableError, type LinkState } from "./link.js";
import { PeerOutbox } from "./outbox.js";
import type { EngineIdentity } from "./identity.js";

// A peer's last-known host-tool summary, cached from its peer.status exchanges (D4 rule: a peer
// can never trigger LOCAL process execution — we only ever carry the last completed scan it sent).
// Shape mirrors the local host.tools reply ({host, tools}) so the app renders remote ⇅ rows 1:1.
export type PeerHostTools = { host: string; tools: unknown[] } | null;
export type PeerStatusSnapshot = {
  engineId: string;
  state: LinkState;
  card: EngineCard | null;
  outboxPending: number;
  agents: Record<string, number> | null;   // last-known per-state counts (null before any exchange)
  hostTools: PeerHostTools;                 // last-known host-tool summary (null before any exchange)
};

export class FederationManager {
  private links = new Map<string, PeerLink>();
  private outbox: PeerOutbox;
  private records = new Map<string, unknown>();          // qualifiedId -> last-known AgentRecord (bounded below)
  private flushing = new Set<string>();
  private started = false;
  // D8/F08: last peer.status we successfully received per peer — persists across a partition so the
  // local peer.status RPC (and the app's ⇅ host-tools carriage) can render the last-known snapshot.
  private peerStatus = new Map<string, { agents: Record<string, number> | null; hostTools: PeerHostTools }>();

  constructor(private opts: {
    home: string; engineId: string; identity: EngineIdentity; card: EngineCard;
    peers: PeerConfig[]; reconnectBaseMs?: number; heartbeatMs?: number;
    // D14/F18: fired when a peer's link transitions INTO "partitioned" (PeerLink.setState only
    // calls onStateChange on an actual state change, so this never fires from the initial
    // "connecting" boot — but a still-dead peer's repeated failed reconnects cycle
    // connecting→partitioned and re-fire it each time; that's a live signal, not a poll,
    // and the notify rule's own throttle window is what collapses a flapping peer into one
    // delivery) — absent ⇒ no-op, every existing caller/test unaffected.
    onPartitioned?: (engineId: string) => void;
  }) {
    this.outbox = new PeerOutbox(opts.home);
    for (const peer of opts.peers) this.createLink(peer);
  }

  private createLink(peer: PeerConfig): void {
    this.links.set(peer.engineId, new PeerLink({
      peer, identity: this.opts.identity, card: this.opts.card,
      reconnectBaseMs: this.opts.reconnectBaseMs, heartbeatMs: this.opts.heartbeatMs,
      onStateChange: (s) => {
        if (s === "connected") void this.flush(peer.engineId);
        else if (s === "partitioned") this.opts.onPartitioned?.(peer.engineId);
      },
    }));
  }

  start(): void {
    this.started = true;
    for (const link of this.links.values()) link.start();
  }

  // ---------- D7/D8 live peer diff-apply hooks (config.d overlay → link add/teardown) ----------
  // Transport identity of a peer: only these fields require a link rebuild. A grant (allowSpawn/
  // accounts/maxConcurrent) changes NONE of them — that policy is read live from engine config on
  // the responder side, so a grant needs no link churn at all (running agents untouched).
  private static transportKey(p: PeerConfig): string {
    return JSON.stringify({ publicKey: p.publicKey, socketPath: p.socketPath, ssh: p.ssh ?? null });
  }

  /** A newly-pinned peer (pairing/join or a manual config add): create + start its outbound link. */
  addPeer(peer: PeerConfig): void {
    if (this.links.has(peer.engineId)) return;
    this.createLink(peer);
    if (this.started) this.links.get(peer.engineId)!.start();
  }

  /** A removed peer: tear the link down (running agents are the executor's — never touched here). */
  removePeer(engineId: string): void {
    const link = this.links.get(engineId);
    if (!link) return;
    void link.stop();
    this.links.delete(engineId);
    this.peerStatus.delete(engineId);
    // A5: drop this peer's cached AgentRecords too. agent.list's merge reads the record cache and
    // cachedRecords() gates on link liveness, so a leftover record for an unpinned engine would
    // otherwise surface as a phantom row until the 1000-entry LRU eventually evicts it. Clearing
    // here also frees the memory immediately rather than leaking it until eviction.
    for (const qualifiedId of [...this.records.keys()]) {
      if (parseAgentAddress(qualifiedId).engineId === engineId) this.records.delete(qualifiedId);
    }
  }

  /** A changed peer: rebuild the link ONLY when its transport changed; a policy-only (grant) change
   *  is a no-op (the link stays up, the responder reads the new grant from config on the next call). */
  updatePeer(peer: PeerConfig): void {
    const existing = this.links.get(peer.engineId);
    if (!existing) { this.addPeer(peer); return; }
    if (FederationManager.transportKey(existing.peerConfig) === FederationManager.transportKey(peer)) return;
    this.removePeer(peer.engineId);
    this.addPeer(peer);
  }

  private link(engineId: string): PeerLink {
    const link = this.links.get(engineId);
    if (!link) throw { code: "protocol", message: `unknown peer engine "${engineId}" — not in federation.peers` };
    return link;
  }

  async call<T = unknown>(engineId: string, method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    return this.link(engineId).request<T>(method, params, timeoutMs);
  }

  /** Try now; park in the per-peer outbox on unreachability. ONLY for idempotent forwards (mailbox.forward). */
  async forwardOrPark(engineId: string, method: string, params: unknown, entryId?: string): Promise<"sent" | "parked"> {
    this.link(engineId);                                  // unknown peer is a config error, not a parking case
    try {
      await this.call(engineId, method, params);
      return "sent";
    } catch (err) {
      if (err instanceof PeerUnreachableError) {
        this.outbox.enqueue(engineId, { ...(entryId ? { id: entryId } : {}), method, params });
        return "parked";
      }
      throw err;                                          // real peer-side errors surface (e.g. protocol)
    }
  }

  private async flush(engineId: string): Promise<void> {
    if (this.flushing.has(engineId)) return;
    this.flushing.add(engineId);
    try {
      for (const entry of this.outbox.pending(engineId)) {
        await this.call(engineId, entry.method, entry.params);   // deduped:true responses are successes
        this.outbox.ack(engineId, entry.id);                     // ack per entry -> crash-safe resume from watermark
      }
    } catch {
      /* partitioned again mid-flush — the next connected transition resumes from the watermark */
    } finally {
      this.flushing.delete(engineId);
    }
  }

  cacheRecord(qualifiedId: string, record: unknown): void {
    this.records.set(qualifiedId, record);
    if (this.records.size > 1000) {                       // bounded: evict oldest insertion
      const first = this.records.keys().next().value as string;
      this.records.delete(first);
    }
  }
  cachedRecord(qualifiedId: string): unknown | undefined { return this.records.get(qualifiedId); }
  /** Drop a cached record (A5: a killed remote agent must not be resurrected by agent.list —
   *  the generic qualified-id forward never refreshes the cache after agent.kill, so the caller
   *  evicts here explicitly). No-op if the id was never cached. */
  evictRecord(qualifiedId: string): void { this.records.delete(qualifiedId); }

  // A5: every cached peer AgentRecord for a STILL-PINNED peer, each tagged with the engineId
  // parsed from its qualified id ("<engine>/<localId>"). Feeds agent.list's initial-window merge
  // so a fresh remote spawn shows its ⇅ @engine row BEFORE any peer-relayed event lands (the whole
  // gap). The link-liveness gate (this.links.has) keeps a record whose peer was unpinned out of
  // agent.list even if a stray entry outlived removePeer's sweep — a partitioned-but-configured
  // peer still has a link, so its last-known rows correctly persist across a transient outage.
  // Records are the peer's OWN scrubbed spawn/status replies (D5: account NAMES only, never
  // credentials — the executing side redacts resultText before it ever crosses the link).
  cachedRecords(): Array<{ engineId: string; record: unknown }> {
    const out: Array<{ engineId: string; record: unknown }> = [];
    for (const [qualifiedId, record] of this.records.entries()) {
      const { engineId } = parseAgentAddress(qualifiedId);
      if (engineId && this.links.has(engineId)) out.push({ engineId, record });
    }
    return out;
  }

  peersStatus(): Array<{ engineId: string; state: LinkState; card: EngineCard | null; outboxPending: number }> {
    return [...this.links.entries()].map(([engineId, link]) => ({
      engineId, state: link.state, card: link.peerCard, outboxPending: this.outbox.pending(engineId).length,
    }));
  }

  // ---------- F08: peer.status carriage (host-tools) for the LOCAL peer.status RPC ----------
  // Refresh each CONNECTED peer's status (peer.status is in PEER_METHODS) and cache its host-tool
  // summary; return every peer's last-known snapshot. A peer being polled here only ever returns
  // the last COMPLETED local scan on its side (D4) — it never triggers remote process execution.
  async peerStatuses(): Promise<PeerStatusSnapshot[]> {
    await Promise.all([...this.links.entries()].map(async ([engineId, link]) => {
      if (link.state !== "connected") return;
      try {
        const res = await link.request<{ agents?: Record<string, number>; hostTools?: PeerHostTools }>("peer.status", {}, 5000);
        this.peerStatus.set(engineId, { agents: res.agents ?? null, hostTools: res.hostTools ?? null });
      } catch { /* unreachable mid-poll: keep the last-known snapshot */ }
    }));
    return [...this.links.entries()].map(([engineId, link]) => {
      const cached = this.peerStatus.get(engineId);
      return {
        engineId, state: link.state, card: link.peerCard,
        outboxPending: this.outbox.pending(engineId).length,
        agents: cached?.agents ?? null, hostTools: cached?.hostTools ?? null,
      };
    });
  }

  async stop(): Promise<void> { for (const link of this.links.values()) await link.stop(); }
}
