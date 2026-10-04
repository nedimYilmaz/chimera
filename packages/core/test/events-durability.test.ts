import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { realDurableWriteDeps, type DurableWriteDeps } from "@chimera/core/durable-write";

// R2-DURABLE-LOG: covers EventLog's batched-fsync append path — the write is always synchronous
// (every existing events*.test.ts keeps passing unmodified, proving this), only the FSYNC
// (durability against an unclean shutdown) is mode-dependent.

function fsyncCountingDeps(): { deps: DurableWriteDeps; fsyncCalls: number[] } {
  const fsyncCalls: number[] = [];
  let n = 0;
  const deps: DurableWriteDeps = {
    ...realDurableWriteDeps,
    fsyncSync: (fd: number) => { n++; fsyncCalls.push(fd); return realDurableWriteDeps.fsyncSync(fd); },
  };
  return { deps, fsyncCalls };
}

function fakeTimer(): { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void; fire: () => void; armed: () => boolean; clearedCount: () => number } {
  let pending: (() => void) | null = null;
  let cleared = 0;
  return {
    setTimer: (fn) => { pending = fn; return { id: 1 }; },
    clearTimer: () => { pending = null; cleared++; },
    fire: () => { const fn = pending; pending = null; fn?.(); },
    armed: () => pending !== null,
    clearedCount: () => cleared,
  };
}

describe("EventLog durability", () => {
  it("fsync-always mode calls fsyncSync on every single append", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-dur-"));
    const { deps, fsyncCalls } = fsyncCountingDeps();
    const log = new EventLog(dir, { durability: { mode: "fsync-always", groupCommitMs: 25, groupCommitMaxBatch: 200 }, ioDeps: deps });
    log.append({ agentId: "a1", kind: "status", data: {} });
    log.append({ agentId: "a1", kind: "status", data: {} });
    log.append({ agentId: "a1", kind: "status", data: {} });
    expect(fsyncCalls.length).toBe(3);
  });

  it("group-commit mode does not fsync until the batch threshold or the timer fires", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-dur-"));
    const { deps, fsyncCalls } = fsyncCountingDeps();
    const timer = fakeTimer();
    const log = new EventLog(dir, {
      durability: { mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 5 },
      ioDeps: deps, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    log.append({ agentId: "a1", kind: "status", data: {} });
    log.append({ agentId: "a1", kind: "status", data: {} });
    expect(fsyncCalls.length).toBe(0);   // no fsync yet — under the batch threshold, timer not fired
    expect(timer.armed()).toBe(true);    // a flush IS armed, just not fired

    timer.fire();
    expect(fsyncCalls.length).toBe(1);   // the whole pending batch flushed in exactly one fsync
  });

  it("group-commit mode force-flushes at groupCommitMaxBatch without waiting for the timer", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-dur-"));
    const { deps, fsyncCalls } = fsyncCountingDeps();
    const timer = fakeTimer();
    const log = new EventLog(dir, {
      durability: { mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 3 },
      ioDeps: deps, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    log.append({ agentId: "a1", kind: "status", data: {} });
    log.append({ agentId: "a1", kind: "status", data: {} });
    expect(fsyncCalls.length).toBe(0);
    log.append({ agentId: "a1", kind: "status", data: {} });   // hits the batch cap
    expect(fsyncCalls.length).toBe(1);
    expect(timer.armed()).toBe(false);   // the forced flush also clears any armed timer
  });

  it("a crash between append (write) and fsync recovers the appended event on restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-dur-"));
    const timer = fakeTimer();
    let throwOnce = true;
    const deps: DurableWriteDeps = {
      ...realDurableWriteDeps,
      fsyncSync: (fd: number) => {
        if (throwOnce) { throwOnce = false; throw new Error("simulated crash before fsync completes"); }
        return realDurableWriteDeps.fsyncSync(fd);
      },
    };
    const log = new EventLog(dir, {
      durability: { mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 200 },
      ioDeps: deps, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.append({ agentId: "a1", kind: "status", data: { i: 1 } });
    timer.fire();   // the deferred fsync throws — flush() swallows/logs it, doesn't corrupt state
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    // the write itself already landed on disk regardless of the fsync outcome
    const lines = readFileSync(join(dir, "events", "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);

    // a fresh EventLog over the same directory recovers it fully (seq/tail correct)
    const resumed = new EventLog(dir);
    expect(resumed.tail("a1", 1)[0]!.seq).toBe(1);
    const next = resumed.append({ agentId: "a1", kind: "status", data: { i: 2 } });
    expect(next.seq).toBe(2);
  });

  it("flushDurable() fsyncs synchronously and clears the pending timer", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-dur-"));
    const { deps, fsyncCalls } = fsyncCountingDeps();
    const timer = fakeTimer();
    const log = new EventLog(dir, {
      durability: { mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 200 },
      ioDeps: deps, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    log.append({ agentId: "a1", kind: "status", data: {} });
    expect(fsyncCalls.length).toBe(0);
    expect(timer.armed()).toBe(true);

    log.flushDurable();
    expect(fsyncCalls.length).toBe(1);
    expect(timer.clearedCount()).toBe(1);
    expect(timer.armed()).toBe(false);

    log.flushDurable();   // idempotent — nothing pending, no extra fsync
    expect(fsyncCalls.length).toBe(1);
  });

  it("group-commit preserves seq order under a rapid append burst, independent of fsync batching", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-ev-dur-"));
    const timer = fakeTimer();
    const log = new EventLog(dir, {
      durability: { mode: "group-commit", groupCommitMs: 25, groupCommitMaxBatch: 1000 },
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    const seqs: number[] = [];
    for (let i = 0; i < 50; i++) seqs.push(log.append({ agentId: "a1", kind: "status", data: { i } }).seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(log.tail("a1", 50).map((e) => e.seq)).toEqual(seqs);
  });
});
