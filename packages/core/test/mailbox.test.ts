import { describe, it, expect } from "vitest";
import { mkdtempSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxStore } from "@chimera/core/mailbox";
import { realDurableWriteDeps, type DurableWriteDeps } from "@chimera/core/durable-write";

describe("MailboxStore", () => {
  it("enqueues FIFO, drains once, and survives restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    mb.enqueue("main", { from: "worker1", kind: "child_result", text: "done A" });
    mb.enqueue("main", { from: "tui", kind: "user_message", text: "hurry up" });
    expect(mb.pending("main").map((m) => m.text)).toEqual(["done A", "hurry up"]);
    expect(mb.pending("main")[0]!.engineId).toBe("local");   // origin provenance, defaulted

    const forwarded = mb.enqueue("main2", { from: "peer", kind: "user_message", text: "x", id: "fixed-id", ts: 42, engineId: "engineB" });
    expect(forwarded).toMatchObject({ id: "fixed-id", ts: 42, engineId: "engineB" });   // sender-supplied identity wins

    const drained = mb.drain("main");
    expect(drained.length).toBe(2);
    expect(mb.pending("main")).toEqual([]);

    mb.enqueue("main", { from: "worker2", kind: "child_result", text: "done B" });
    const mb2 = new MailboxStore(dir);                 // simulated restart
    expect(mb2.pending("main").map((m) => m.text)).toEqual(["done B"]);
    expect(mb2.pending("other")).toEqual([]);
  });

  it("survives a torn final line from a crash mid-append (returns the well-formed messages)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    mb.enqueue("main", { from: "w", kind: "child_result", text: "good" });
    // simulate a crash mid-appendFileSync leaving a truncated final JSON line
    appendFileSync(join(dir, "mailboxes", "main.jsonl"), '{"id":"torn","ts":1,"from":"w","kin');
    expect(() => mb.pending("main")).not.toThrow();
    expect(mb.pending("main").map((m) => m.text)).toEqual(["good"]);   // torn line skipped, good message kept
    expect(mb.drain("main").map((m) => m.text)).toEqual(["good"]);
  });

  it("drain on an empty mailbox returns [] and writes no .ack (would corrupt later pending)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    expect(mb.drain("main")).toEqual([]);
    expect(existsSync(join(dir, "mailboxes", "main.ack"))).toBe(false);
    mb.enqueue("main", { from: "w", kind: "signal", text: "later" });
    expect(mb.pending("main").map((m) => m.text)).toEqual(["later"]);   // still deliverable
  });

  it("returns all messages when the ack watermark id is absent from the log (stale ack)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    mb.enqueue("main", { from: "w", kind: "signal", text: "a" });
    mb.enqueue("main", { from: "w", kind: "signal", text: "b" });
    // an .ack referencing an id not present in the current jsonl (e.g. rotated log)
    appendFileSync(join(dir, "mailboxes", "main.ack"), "not-a-real-id");
    expect(mb.pending("main").map((m) => m.text)).toEqual(["a", "b"]);   // idx === -1 fallback → all
  });

  it("confines a path-unsafe agentId to the mailboxes/ dir (encodeURIComponent guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    const evil = "../../etc/passwd";
    mb.enqueue(evil, { from: "w", kind: "signal", text: "contained" });
    expect(mb.pending(evil).map((m) => m.text)).toEqual(["contained"]);   // round-trips
    // every file created lives directly under mailboxes/ — nothing escaped
    const files = readdirSync(join(dir, "mailboxes"));
    expect(files).toContain(encodeURIComponent(evil) + ".jsonl");
    // the security property is no path SEPARATOR in the filename (so it can't escape
    // mailboxes/); the literal ".." chars are harmless once "/" is percent-encoded
    expect(files.every((f) => !f.includes("/") && !f.includes("\\"))).toBe(true);
  });

  it("keeps each agent's messages isolated (positive check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    mb.enqueue("a1", { from: "w", kind: "signal", text: "for-a1" });
    mb.enqueue("a2", { from: "w", kind: "signal", text: "for-a2" });
    expect(mb.pending("a1").map((m) => m.text)).toEqual(["for-a1"]);
    expect(mb.pending("a2").map((m) => m.text)).toEqual(["for-a2"]);
  });

  it("stamps a UUID id and a fresh ts by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const before = Date.now();
    const m = new MailboxStore(dir).enqueue("main", { from: "w", kind: "signal", text: "x" });
    expect(m.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(m.ts).toBeGreaterThanOrEqual(before);
  });
});

// R2-DURABLE-LOG: enqueue() goes through the same DurableAppendLog primitive as EventLog (see
// events-durability.test.ts for the full fsync-cadence policy coverage) — this is a smoke test
// that MailboxStore actually wires it, not a re-test of the batching policy itself.
describe("MailboxStore durability", () => {
  it("enqueue's fsync cadence follows the configured durability mode (fsync-always)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-dur-"));
    let fsyncCalls = 0;
    const deps: DurableWriteDeps = { ...realDurableWriteDeps, fsyncSync: (fd) => { fsyncCalls++; return realDurableWriteDeps.fsyncSync(fd); } };
    const mb = new MailboxStore(dir, { durability: { mode: "fsync-always", groupCommitMs: 25, groupCommitMaxBatch: 200 }, ioDeps: deps });
    mb.enqueue("main", { from: "w", kind: "signal", text: "a" });
    mb.enqueue("main", { from: "w", kind: "signal", text: "b" });
    expect(fsyncCalls).toBe(2);
  });

  it("flushDurable() flushes every open per-agent mailbox log", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-dur-"));
    let fsyncCalls = 0;
    const deps: DurableWriteDeps = { ...realDurableWriteDeps, fsyncSync: (fd) => { fsyncCalls++; return realDurableWriteDeps.fsyncSync(fd); } };
    let pending: (() => void)[] = [];
    const mb = new MailboxStore(dir, {
      durability: { mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 200 },
      ioDeps: deps,
      setTimer: (fn) => { pending.push(fn); return pending.length; },
      clearTimer: () => {},
    });
    mb.enqueue("a1", { from: "w", kind: "signal", text: "for-a1" });
    mb.enqueue("a2", { from: "w", kind: "signal", text: "for-a2" });
    expect(fsyncCalls).toBe(0);   // group-commit, timers not fired yet

    mb.flushDurable();
    expect(fsyncCalls).toBe(2);   // both per-agent logs (a1, a2) flushed
  });
});

// IMAGE.PASTE (TUI #7): additive `images?: Image[]` field, persisted inline (base64)
// in the JSONL, surviving the same enqueue/pending/drain/restart round trip as every
// other field.
describe("MailboxStore: images field (IMAGE.PASTE)", () => {
  it("round-trips an images array through enqueue/pending/drain and survives restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    const img = { mediaType: "image/png", data: "aGVsbG8=" } as const;
    mb.enqueue("main", { from: "tui", kind: "user_message", text: "look", images: [img] });
    expect(mb.pending("main")[0]!.images).toEqual([img]);
    expect(mb.drain("main")[0]!.images).toEqual([img]);
    const mb2 = new MailboxStore(dir);                 // simulated restart
    expect(mb2.pending("main")).toEqual([]);            // already drained/acked before restart
  });

  it("leaves `images` absent entirely when the caller omits it (no stray key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    mb.enqueue("main", { from: "w", kind: "signal", text: "no image" });
    const msg = mb.pending("main")[0]!;
    expect(msg.images).toBeUndefined();
    expect("images" in msg).toBe(false);
  });

  it("preserves multiple images in their original order", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-mb-"));
    const mb = new MailboxStore(dir);
    const a = { mediaType: "image/jpeg", data: "AAA" } as const;
    const b = { mediaType: "image/gif", data: "BBB" } as const;
    mb.enqueue("main", { from: "w", kind: "user_message", text: "two pics", images: [a, b] });
    expect(mb.pending("main")[0]!.images).toEqual([a, b]);
  });
});
