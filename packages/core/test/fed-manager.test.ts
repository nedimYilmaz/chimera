import { describe, it, expect } from "vitest";
import { rmSync } from "node:fs";
import type { PeerConfig } from "@chimera/protocol";
import { FederationManager } from "@chimera/core/federation/manager";
import { PeerUnreachableError } from "@chimera/core/federation/link";
import { makeIdentity, cardFor, startFakePeer, tmpHome } from "./fed-helpers.js";

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); }
};

describe("FederationManager", () => {
  it("routes calls per peer, reports status, and rejects unknown engines", async () => {
    const me = makeIdentity(), them = makeIdentity();
    const fake = await startFakePeer({
      engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]),
      respond: (method) => ({ via: method }),
    });
    const peer: PeerConfig = { engineId: "studio", publicKey: them.identity.publicKey, socketPath: fake.socketPath, allowSpawn: false, accounts: [], maxConcurrent: 4 };
    const fm = new FederationManager({ home: tmpHome("fm"), engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [peer], reconnectBaseMs: 10, heartbeatMs: 200 });
    fm.start();
    await until(() => fm.peersStatus()[0]!.state === "connected");
    expect(await fm.call("studio", "peer.status", {})).toEqual({ via: "peer.status" });
    await expect(fm.call("ghost", "peer.status", {})).rejects.toMatchObject({ code: "protocol" });
    expect(fm.peersStatus()[0]).toMatchObject({ engineId: "studio", state: "connected", outboxPending: 0 });
    fm.cacheRecord("studio/a1", { agentId: "studio/a1", state: "running" });
    expect(fm.cachedRecord("studio/a1")).toMatchObject({ state: "running" });
    await fm.stop();
    await fake.close();
  });

  // D14/F18: the "peer partitioned" default notify rule watches this signal. It's driven by
  // PeerLink's own state-change guard (only fires on an ACTUAL transition), so the initial
  // "connecting" boot never fires it — but a dead peer's repeated failed reconnect attempts
  // cycle connecting→partitioned over and over, each a genuine transition, so onPartitioned
  // fires again each time (throttling a chatty peer is exactly the notify rule's job).
  it("fires onPartitioned for the peer when a connected link drops (never for the initial connect)", async () => {
    const me = makeIdentity(), them = makeIdentity();
    const home = tmpHome("fm-partitioned");
    const fake = await startFakePeer({ engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]) });
    const peer: PeerConfig = { engineId: "studio", publicKey: them.identity.publicKey, socketPath: fake.socketPath, allowSpawn: false, accounts: [], maxConcurrent: 4 };
    const partitioned: string[] = [];
    const fm = new FederationManager({
      home, engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [peer],
      reconnectBaseMs: 10, heartbeatMs: 50, onPartitioned: (engineId) => partitioned.push(engineId),
    });
    fm.start();
    await until(() => fm.peersStatus()[0]!.state === "connected");
    expect(partitioned).toEqual([]);   // connecting → connected never fires onPartitioned

    await fake.close();
    await until(() => fm.peersStatus()[0]!.state === "partitioned");
    expect(partitioned.length).toBeGreaterThanOrEqual(1);
    expect(partitioned.every((id) => id === "studio")).toBe(true);
    await fm.stop();
  });

  it("parks mailbox.forward while partitioned and replays FIFO on reconnect", async () => {
    const me = makeIdentity(), them = makeIdentity();
    const home = tmpHome("fm2");
    const fake1 = await startFakePeer({ engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]) });
    const peer: PeerConfig = { engineId: "studio", publicKey: them.identity.publicKey, socketPath: fake1.socketPath, allowSpawn: false, accounts: [], maxConcurrent: 4 };
    const fm = new FederationManager({ home, engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [peer], reconnectBaseMs: 10, heartbeatMs: 50 });
    fm.start();
    await until(() => fm.peersStatus()[0]!.state === "connected");
    expect(await fm.forwardOrPark("studio", "mailbox.forward", { n: 0 }, "m-0")).toBe("sent");

    await fake1.close();                                               // partition
    await until(() => fm.peersStatus()[0]!.state === "partitioned");
    expect(await fm.forwardOrPark("studio", "mailbox.forward", { n: 1 }, "m-1")).toBe("parked");
    expect(await fm.forwardOrPark("studio", "mailbox.forward", { n: 2 }, "m-2")).toBe("parked");
    expect(fm.peersStatus()[0]!.outboxPending).toBe(2);
    await expect(fm.call("studio", "peer.status", {})).rejects.toBeInstanceOf(PeerUnreachableError);

    const fake2 = await startFakePeer({ engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]) });
    const { renameSync } = await import("node:fs");
    rmSync(fake1.socketPath, { force: true });
    renameSync(fake2.socketPath, fake1.socketPath);                    // reborn peer at the same forwarded path
    await until(() => fm.peersStatus()[0]!.state === "connected");
    await until(() => fm.peersStatus()[0]!.outboxPending === 0);       // replay drained
    const forwarded = fake2.received.filter((r) => r.method === "mailbox.forward").map((r) => (r.params as { n: number }).n);
    expect(forwarded).toEqual([1, 2]);                                 // FIFO preserved
    await fm.stop();
    await fake2.close();
  }, 20_000);

  // --- Extra coverage: branches/edges beyond the two brief-mandated tests above ---

  it("rejects call() and forwardOrPark() immediately when no peers are configured (empty peers array)", async () => {
    const me = makeIdentity();
    const fm = new FederationManager({ home: tmpHome("fm-empty"), engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [] });
    fm.start();                                                         // zero-iteration loop body: nothing to start
    expect(fm.peersStatus()).toEqual([]);
    await expect(fm.call("ghost", "peer.status")).rejects.toMatchObject({ code: "protocol" });          // default params={}
    await expect(fm.forwardOrPark("ghost", "mailbox.forward", { n: 1 })).rejects.toMatchObject({ code: "protocol" });
    await fm.stop();                                                    // zero-iteration loop body: nothing to stop
  });

  it("forwardOrPark re-throws a real peer-side error (non-unreachable) without parking it", async () => {
    expect.assertions(2);
    const me = makeIdentity(), them = makeIdentity();
    const fake = await startFakePeer({
      engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]),
      respond: (method) => { if (method === "mailbox.forward") throw { code: "app-error", message: "receiver rejected" }; return { ok: true }; },
    });
    const peer: PeerConfig = { engineId: "studio", publicKey: them.identity.publicKey, socketPath: fake.socketPath, allowSpawn: false, accounts: [], maxConcurrent: 4 };
    const fm = new FederationManager({ home: tmpHome("fm-apperr"), engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [peer], reconnectBaseMs: 10, heartbeatMs: 200 });
    fm.start();
    await until(() => fm.peersStatus()[0]!.state === "connected");
    try {
      await fm.forwardOrPark("studio", "mailbox.forward", { n: 1 });    // no entryId — not the parking path
      expect.fail("expected forwardOrPark to reject");
    } catch (err) {
      expect(err).toMatchObject({ code: "app-error" });
    }
    expect(fm.peersStatus()[0]!.outboxPending).toBe(0);                 // never parked — a real error, not a partition
    await fm.stop();
    await fake.close();
  });

  it("forwardOrPark parks with an outbox-generated id when entryId is omitted", async () => {
    const me = makeIdentity(), them = makeIdentity();
    const fake = await startFakePeer({ engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]) });
    const peer: PeerConfig = { engineId: "studio", publicKey: them.identity.publicKey, socketPath: fake.socketPath, allowSpawn: false, accounts: [], maxConcurrent: 4 };
    const fm = new FederationManager({ home: tmpHome("fm-noid"), engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [peer], reconnectBaseMs: 10, heartbeatMs: 200 });
    fm.start();
    await until(() => fm.peersStatus()[0]!.state === "connected");
    await fake.close();
    await until(() => fm.peersStatus()[0]!.state === "partitioned");
    expect(await fm.forwardOrPark("studio", "mailbox.forward", { n: 1 })).toBe("parked");   // no entryId supplied
    expect(fm.peersStatus()[0]!.outboxPending).toBe(1);
    await fm.stop();
  });

  it("flush() swallows a real peer-side error mid-replay, leaving the entry pending for the next attempt", async () => {
    const me = makeIdentity(), them = makeIdentity();
    const home = tmpHome("fm-flusherr");
    const fake1 = await startFakePeer({ engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]) });
    const peer: PeerConfig = { engineId: "studio", publicKey: them.identity.publicKey, socketPath: fake1.socketPath, allowSpawn: false, accounts: [], maxConcurrent: 4 };
    const fm = new FederationManager({ home, engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [peer], reconnectBaseMs: 10, heartbeatMs: 50 });
    fm.start();
    await until(() => fm.peersStatus()[0]!.state === "connected");
    await fake1.close();
    await until(() => fm.peersStatus()[0]!.state === "partitioned");
    expect(await fm.forwardOrPark("studio", "mailbox.forward", { n: 9 }, "m-9")).toBe("parked");

    const fake2 = await startFakePeer({
      engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]),
      respond: (method) => { if (method === "mailbox.forward") throw { code: "app-error", message: "still rejecting" }; return { ok: true }; },
    });
    const { renameSync } = await import("node:fs");
    rmSync(fake1.socketPath, { force: true });
    renameSync(fake2.socketPath, fake1.socketPath);
    await until(() => fm.peersStatus()[0]!.state === "connected");
    await until(() => fake2.received.some((r) => r.method === "mailbox.forward"));   // flush attempted the replay
    expect(fm.peersStatus()[0]!.outboxPending).toBe(1);     // never acked — still pending, not silently dropped
    await fm.stop();
    await fake2.close();
  }, 20_000);

  it("flush() re-entrancy guard short-circuits a concurrent call for the same engineId", async () => {
    const me = makeIdentity(), them = makeIdentity();
    const home = tmpHome("fm-reentrant");
    const fake = await startFakePeer({ engineId: "studio", identity: them.identity, peerKeys: new Map([["mbp", me.identity.publicKey]]) });
    const peer: PeerConfig = { engineId: "studio", publicKey: them.identity.publicKey, socketPath: fake.socketPath, allowSpawn: false, accounts: [], maxConcurrent: 4 };
    const fm = new FederationManager({ home, engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [peer], reconnectBaseMs: 10, heartbeatMs: 200 });
    fm.start();
    await until(() => fm.peersStatus()[0]!.state === "connected");
    await fake.close();
    await until(() => fm.peersStatus()[0]!.state === "partitioned");
    await fm.forwardOrPark("studio", "mailbox.forward", { n: 1 }, "m-1");
    expect(fm.peersStatus()[0]!.outboxPending).toBe(1);

    const flushing = (fm as unknown as { flushing: Set<string> }).flushing;
    flushing.add("studio");                                             // simulate an in-flight flush for "studio"
    await (fm as unknown as { flush: (id: string) => Promise<void> }).flush("studio");
    expect(fm.peersStatus()[0]!.outboxPending).toBe(1);                  // guard short-circuited: nothing replayed/acked
    flushing.delete("studio");
    await fm.stop();
  });

  it("cacheRecord bounds the records map at 1000 entries, evicting the oldest insertion first", () => {
    const me = makeIdentity();
    const fm = new FederationManager({ home: tmpHome("fm-cache"), engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [] });
    for (let i = 0; i < 1000; i++) fm.cacheRecord(`studio/a${i}`, { i });
    expect(fm.cachedRecord("studio/a0")).toMatchObject({ i: 0 });        // exactly 1000 entries: no eviction yet
    expect(fm.cachedRecord("studio/a999")).toMatchObject({ i: 999 });

    fm.cacheRecord("studio/a1000", { i: 1000 });                        // 1001st insert crosses the bound
    expect(fm.cachedRecord("studio/a0")).toBeUndefined();                // oldest evicted
    expect(fm.cachedRecord("studio/a1")).toMatchObject({ i: 1 });        // second-oldest survives
    expect(fm.cachedRecord("studio/a1000")).toMatchObject({ i: 1000 });  // newest present
  });

  it("cachedRecord returns undefined for a qualifiedId that was never cached", () => {
    const me = makeIdentity();
    const fm = new FederationManager({ home: tmpHome("fm-cache-miss"), engineId: "mbp", identity: me.identity, card: cardFor("mbp"), peers: [] });
    expect(fm.cachedRecord("nope/nope")).toBeUndefined();
  });
});
