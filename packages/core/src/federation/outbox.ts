import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type OutboxEntry = { id: string; ts: number; method: string; params: unknown };

/** Store-and-forward parking lot for peer-bound calls (synthesis §3.4): same JSONL+watermark pattern as MailboxStore. */
export class PeerOutbox {
  private dir: string;
  constructor(baseDir: string) {
    this.dir = join(baseDir, "outbox");
    mkdirSync(this.dir, { recursive: true });
  }
  // encodeURIComponent leaves ids like UUIDs untouched and makes '.', '/', and
  // other path-hostile characters in engineId filename-safe (mirrors MailboxStore).
  private file(engineId: string) { return join(this.dir, `${encodeURIComponent(engineId)}.jsonl`); }
  private ackFile(engineId: string) { return join(this.dir, `${encodeURIComponent(engineId)}.ack`); }

  // id/ts default here, but a caller-supplied value wins — this keeps a mailbox
  // message's identity stable across park->replay so the receiver's dedup works.
  enqueue(engineId: string, e: { method: string; params: unknown } & Partial<Pick<OutboxEntry, "id" | "ts">>): OutboxEntry {
    const full: OutboxEntry = { id: e.id ?? randomUUID(), ts: e.ts ?? Date.now(), method: e.method, params: e.params };
    appendFileSync(this.file(engineId), JSON.stringify(full) + "\n");
    return full;
  }

  pending(engineId: string): OutboxEntry[] {
    if (!existsSync(this.file(engineId))) return [];
    const all: OutboxEntry[] = [];
    for (const l of readFileSync(this.file(engineId), "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        all.push(JSON.parse(l) as OutboxEntry);
      } catch {
        // torn/partial line from a crash mid-appendFileSync: the entry was never
        // durably written, so skip it and keep every well-formed entry around it
        // rather than letting a torn last line wedge the whole peer's queue.
      }
    }
    const ack = existsSync(this.ackFile(engineId)) ? readFileSync(this.ackFile(engineId), "utf8").trim() : "";
    if (!ack) return all;
    const idx = all.findIndex((e) => e.id === ack);
    return idx === -1 ? all : all.slice(idx + 1);
  }

  // Watermark: drops everything up to and including upToId (partial flush of a
  // per-peer FIFO). If upToId matches nothing in the log, pending() falls back
  // to returning everything (see idx === -1 above) rather than silently acking.
  ack(engineId: string, upToId: string): void {
    writeFileSync(this.ackFile(engineId), upToId);
  }

  peersWithPending(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => decodeURIComponent(f.slice(0, -".jsonl".length)))
      .filter((engineId) => this.pending(engineId).length > 0);
  }
}
