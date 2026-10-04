import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerOutbox } from "@chimera/core/federation/outbox";

const newDir = (prefix = "chimera-ob-") => mkdtempSync(join(tmpdir(), prefix));

describe("PeerOutbox", () => {
  it("parks per-peer FIFO, acks a watermark, survives restart", () => {
    const dir = newDir();
    const ob = new PeerOutbox(dir);
    const e1 = ob.enqueue("studio", { method: "mailbox.forward", params: { n: 1 } });
    ob.enqueue("studio", { method: "mailbox.forward", params: { n: 2 } });
    ob.enqueue("attic.mini", { method: "mailbox.forward", params: { n: 9 } });   // '.'-in-id must be filename-safe

    expect(ob.pending("studio").map((e) => (e.params as { n: number }).n)).toEqual([1, 2]);
    expect(ob.pending("attic.mini").length).toBe(1);
    expect(ob.peersWithPending().sort()).toEqual(["attic.mini", "studio"]);

    ob.ack("studio", e1.id);                                    // partial flush: only the first replayed so far
    expect(ob.pending("studio").map((e) => (e.params as { n: number }).n)).toEqual([2]);

    const ob2 = new PeerOutbox(dir);                            // simulated daemon restart
    expect(ob2.pending("studio").map((e) => (e.params as { n: number }).n)).toEqual([2]);

    ob2.ack("studio", ob2.pending("studio")[0]!.id);
    expect(ob2.pending("studio")).toEqual([]);
    expect(ob2.peersWithPending()).toEqual(["attic.mini"]);
  });

  it("preserves a caller-supplied entry id (mailbox identity across park->replay)", () => {
    const ob = new PeerOutbox(newDir("chimera-ob2-"));
    const e = ob.enqueue("studio", { id: "msg-fixed-1", method: "mailbox.forward", params: {} });
    expect(e.id).toBe("msg-fixed-1");
    expect(ob.pending("studio")[0]!.id).toBe("msg-fixed-1");
  });

  // ---- additional coverage: every branch/edge beyond the brief's baseline cases ----

  describe("enqueue — id/ts minting vs passthrough", () => {
    it("mints a fresh id and a plausible ts when both are omitted", () => {
      const ob = new PeerOutbox(newDir());
      const before = Date.now();
      const e1 = ob.enqueue("studio", { method: "m", params: 1 });
      const e2 = ob.enqueue("studio", { method: "m", params: 2 });
      const after = Date.now();
      expect(e1.id).not.toBe(e2.id);                             // fresh id minted per call
      expect(typeof e1.ts).toBe("number");
      expect(e1.ts).toBeGreaterThanOrEqual(before);
      expect(e1.ts).toBeLessThanOrEqual(after);
    });

    it("preserves a caller-supplied ts even when id is omitted", () => {
      const ob = new PeerOutbox(newDir());
      const fixedTs = 12345;
      const e = ob.enqueue("studio", { method: "m", params: {}, ts: fixedTs });
      expect(e.ts).toBe(fixedTs);
      expect(e.id.length).toBeGreaterThan(0);                    // still minted since id omitted
    });

    it("preserves both caller-supplied id and ts together", () => {
      const ob = new PeerOutbox(newDir());
      const e = ob.enqueue("studio", { id: "fixed-id", ts: 999, method: "m", params: {} });
      expect(e).toEqual({ id: "fixed-id", ts: 999, method: "m", params: {} });
    });
  });

  describe("pending — no data / ack edge cases", () => {
    it("returns [] for a peer that has never enqueued anything", () => {
      const ob = new PeerOutbox(newDir());
      expect(ob.pending("never-seen")).toEqual([]);
    });

    it("does not discard entries when the ack watermark id does not match anything in the log (idx === -1 safety)", () => {
      const ob = new PeerOutbox(newDir());
      ob.enqueue("studio", { method: "m", params: 1 });
      ob.ack("studio", "some-bogus-id-that-was-never-enqueued");
      expect(ob.pending("studio").length).toBe(1);                // nothing dropped
    });

    it("ack written before any enqueue does not later wipe out a real entry with a different id", () => {
      const ob = new PeerOutbox(newDir());
      ob.ack("studio", "bogus-watermark");                        // ack file created, no jsonl yet
      const e = ob.enqueue("studio", { method: "m", params: 1 });
      expect(ob.pending("studio")).toEqual([e]);                  // ack doesn't match e.id -> idx===-1 -> kept
    });

    it("ack on the last entry drains the peer to empty", () => {
      const ob = new PeerOutbox(newDir());
      const e1 = ob.enqueue("studio", { method: "m", params: 1 });
      ob.ack("studio", e1.id);
      expect(ob.pending("studio")).toEqual([]);
    });

    it("acking the same id twice is idempotent (no crash, same remaining set)", () => {
      const ob = new PeerOutbox(newDir());
      const e1 = ob.enqueue("studio", { method: "m", params: 1 });
      ob.enqueue("studio", { method: "m", params: 2 });
      ob.ack("studio", e1.id);
      const first = ob.pending("studio");
      ob.ack("studio", e1.id);                                    // ack again with the same watermark
      expect(ob.pending("studio")).toEqual(first);
    });

    it("entries enqueued after an ack remain pending on subsequent reads", () => {
      const ob = new PeerOutbox(newDir());
      const e1 = ob.enqueue("studio", { method: "m", params: 1 });
      ob.ack("studio", e1.id);
      const e2 = ob.enqueue("studio", { method: "m", params: 2 });
      expect(ob.pending("studio")).toEqual([e2]);
    });

    it("treats a blank/whitespace-only .ack file as no watermark", () => {
      const dir = newDir();
      const ob = new PeerOutbox(dir);
      const e1 = ob.enqueue("studio", { method: "m", params: 1 });
      writeFileSync(join(dir, "outbox", `${encodeURIComponent("studio")}.ack`), "   \n");
      expect(ob.pending("studio")).toEqual([e1]);
    });

    it("skips torn/blank lines in the JSONL file without wedging the rest of the queue", () => {
      const dir = newDir();
      const ob = new PeerOutbox(dir);
      const e1 = ob.enqueue("studio", { method: "m", params: 1 });
      const file = join(dir, "outbox", `${encodeURIComponent("studio")}.jsonl`);
      // simulate a crash mid-append: blank line + a torn (truncated) JSON line, then a further valid line
      appendFileSync(file, "\n");
      appendFileSync(file, '{"id":"torn","ts":1,"method":"m","par\n');
      const e3 = { id: "e3", ts: 2, method: "m", params: 3 };
      appendFileSync(file, JSON.stringify(e3) + "\n");

      const result = ob.pending("studio");
      expect(result).toEqual([e1, e3]);                           // torn/blank skipped, well-formed entries kept in order
    });
  });

  describe("peersWithPending", () => {
    it("returns [] for a fresh outbox with no enqueues", () => {
      const ob = new PeerOutbox(newDir());
      expect(ob.peersWithPending()).toEqual([]);
    });

    it("excludes a peer whose only entries are fully acked", () => {
      const ob = new PeerOutbox(newDir());
      const e1 = ob.enqueue("acked-peer", { method: "m", params: 1 });
      ob.enqueue("pending-peer", { method: "m", params: 2 });
      ob.ack("acked-peer", e1.id);
      expect(ob.peersWithPending()).toEqual(["pending-peer"]);
    });

    it("decodes filename-hostile engineIds (slashes, spaces, '#', '?') back correctly", () => {
      const ob = new PeerOutbox(newDir());
      const weirdId = "peer/with space#and?chars";
      ob.enqueue(weirdId, { method: "m", params: 1 });
      expect(ob.peersWithPending()).toEqual([weirdId]);
      expect(ob.pending(weirdId).length).toBe(1);
    });

    it("ignores non-.jsonl files sitting in the outbox directory", () => {
      const dir = newDir();
      const ob = new PeerOutbox(dir);
      ob.enqueue("studio", { method: "m", params: 1 });
      // a stray file that isn't a peer queue at all
      writeFileSync(join(dir, "outbox", "README.txt"), "not a peer queue");
      expect(ob.peersWithPending()).toEqual(["studio"]);
    });
  });

  describe("restart persistence", () => {
    it("a fresh PeerOutbox on the same baseDir sees prior unacked entries via peersWithPending", () => {
      const dir = newDir();
      new PeerOutbox(dir).enqueue("studio", { method: "m", params: 1 });
      const ob2 = new PeerOutbox(dir);
      expect(ob2.peersWithPending()).toEqual(["studio"]);
    });

    it("constructing PeerOutbox creates the outbox directory even when baseDir did not pre-exist as that subpath", () => {
      const dir = newDir();
      const nested = join(dir, "nested", "baseDir");
      const ob = new PeerOutbox(nested);
      expect(ob.pending("studio")).toEqual([]);                   // does not throw despite baseDir being freshly created
    });
  });
});
