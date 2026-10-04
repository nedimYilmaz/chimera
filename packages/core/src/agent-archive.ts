import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRecord } from "./supervisor.js";

// MEMORY-BOUNDED-DISK-COMPLETE: one JSON file per archived AgentRecord, written the moment a
// terminal (done/failed/killed) record ages out of AgentSupervisor's in-memory hot set — see
// supervisor.ts's archiveColdTerminalAgents/lightenAgentRecord. Mirrors EventLog's "disk-
// complete, only a bounded slice resident" precedent, but keyed for O(1) random access by
// agentId (one file, not a growing array) since the only read pattern is "give me agent X's
// full record", never a range scan. Unlike queues.ts's MAX_TERMINAL_PER_QUEUE (which DELETES
// the oldest terminal task once the cap is hit, from disk too), archiving here is unconditional
// and permanent — nothing written through this store is ever evicted, so a terminal agent's
// full record (prompt/instructions/resultText) survives for as long as the daemon's home dir
// does, independent of how long ago it finished or how many agents have run since.
export class AgentArchiveStore {
  private dir: string;

  constructor(home: string) {
    this.dir = join(home, "agents");
    mkdirSync(this.dir, { recursive: true });
  }

  private path(agentId: string): string {
    return join(this.dir, `${agentId}.json`);
  }

  // Full record, atomic write (temp-then-rename — mirrors queues.ts's save()/writeFileDurable
  // precedent so a crash mid-write can never leave a torn file behind). Idempotent: archiving
  // the same agentId twice (e.g. a rehydrated record ages back out) just overwrites with the
  // same content.
  write(record: AgentRecord): void {
    const p = this.path(record.agentId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, p);
  }

  // Tolerant read: a missing or corrupt/torn archive file degrades to `undefined` rather than
  // throwing — same convention as queues.json/usage.jsonl's corrupt-file handling elsewhere in
  // this package. The caller (supervisor.ts's rehydrate) falls back to the in-memory light
  // shell it already has, so a lost archive file degrades to "identity fields only", never a
  // crash.
  // PURGE-TERMINAL-SESSIONS: drop one agent's archived record. Idempotent — purging an agent
  // that was never archived (it stayed hot in memory) is a no-op, not an error, so the caller
  // can sweep a whole terminal set without first asking which half is on disk.
  remove(agentId: string): void {
    try { rmSync(this.path(agentId), { force: true }); } catch { /* already gone */ }
  }

  read(agentId: string): AgentRecord | undefined {
    const p = this.path(agentId);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as AgentRecord;
    } catch {
      return undefined;
    }
  }

  has(agentId: string): boolean {
    return existsSync(this.path(agentId));
  }
}
