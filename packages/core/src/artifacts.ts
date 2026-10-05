import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactIdSchema, ArtifactRecordSchema, type ArtifactKind, type ArtifactRecord } from "@chimera/protocol";
import type { EventLog } from "./events.js";

export class UnknownArtifactError extends Error { code = "protocol" as const; name = "UnknownArtifactError"; }
export class OversizeArtifactError extends Error { code = "protocol" as const; name = "OversizeArtifactError"; }
export class ArtifactSourceNotFoundError extends Error { code = "protocol" as const; name = "ArtifactSourceNotFoundError"; }

// F17 done-when: "an oversize registration is refused with an agent-visible error" — the
// cap is checked (and the source file left untouched) BEFORE any snapshot copy is made.
export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
// F17: "gc keeps 200 / 30d" — BOTH bounds are enforced (an artifact survives only if it
// is within the newest 200 AND younger than 30 days), mirroring MemoryStore's count prune
// plus EventLog's segment age/count dual bound.
const GC_MAX_RECORDS = 200;
const GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type ArtifactAddInput = {
  kind: ArtifactKind;
  path?: string;
  url?: string;
  label: string;
  agentId: string | null;
  taskId: string | null;
  // F16.1 Phase 2 (WF-4/G5): the caller's workflow step cursor AT registration time —
  // resolved server-side (engine.ts, from scheduler.taskFor + queues.getTask), never
  // client-supplied. undefined for a call with no bound taskId.
  stepIndex?: number;
};

// F16.1 Phase 2 (WF-4/G5): "task" (default) accepts any artifact registered anywhere in
// the task's lifetime; "step" additionally requires a matching stepIndex. `kind` (when
// given) pins the artifact's registered kind.
export type ArtifactExistsQuery = { artifactId?: string; scope?: "task" | "step"; stepIndex?: number; kind?: ArtifactKind };

export type ArtifactListFilter = { taskId?: string; agentId?: string };

// D13 (artifact registry, coverage C15): ${home}/artifacts.json holds the metadata
// (mirrors WorkflowStore/MemoryStore's temp+rename discipline); file-kind snapshots live
// one-per-artifact at ${home}/artifacts/<id> (spec's exact "~/.chimera/artifacts/<id>"
// layout) so a later edit/delete of the SOURCE repo file never touches what was
// registered. Persists across agent close and daemon restart (same on-disk-first
// discipline as every other coordination store — nothing here is in-memory-only).
export class ArtifactStore {
  private records = new Map<string, ArtifactRecord>();   // insertion order preserved -> gc()'s oldest-first eviction
  private file: string;
  private contentDir: string;

  constructor(dir: string, private events: EventLog, private now: () => number = Date.now) {
    this.contentDir = join(dir, "artifacts");
    mkdirSync(this.contentDir, { recursive: true });
    this.file = join(dir, "artifacts.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as { records: unknown[] };
        for (const r of raw.records) { const rec = ArtifactRecordSchema.parse(r); this.records.set(rec.id, rec); }
      } catch (err) {
        // Quarantine invalid metadata before its ids can become snapshot paths
        // for reads or garbage collection.
        this.records.clear();
        const quarantined = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, quarantined);
        console.warn(`chimerad: corrupt coordination state in ${this.file}: ${(err as Error).message} — quarantined to ${quarantined}, booting with an empty artifact store`);
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;   // write-to-temp-then-rename: no torn writes on power loss
    writeFileSync(tmp, JSON.stringify({ records: [...this.records.values()] }, null, 2));
    renameSync(tmp, this.file);
  }

  private snapshotPath(id: string): string { return join(this.contentDir, ArtifactIdSchema.parse(id)); }

  private evict(id: string): void {
    const rec = this.records.get(id);
    if (!rec) return;
    this.records.delete(id);
    if (rec.kind !== "link") { try { unlinkSync(this.snapshotPath(id)); } catch { /* already gone */ } }
  }

  private gc(): void {
    const cutoff = this.now() - GC_MAX_AGE_MS;
    for (const [id, rec] of [...this.records]) if (rec.createdAt < cutoff) this.evict(id);
    const overflow = this.records.size - GC_MAX_RECORDS;
    if (overflow > 0) for (const id of [...this.records.keys()].slice(0, overflow)) this.evict(id);   // Map -> oldest first
  }

  add(input: ArtifactAddInput): ArtifactRecord {
    const id = randomUUID();
    let sizeBytes: number | null = null;
    if (input.kind === "link") {
      if (!input.url) throw new UnknownArtifactError('artifact kind "link" requires a url');
    } else {
      if (!input.path) throw new UnknownArtifactError(`artifact kind "${input.kind}" requires a path`);
      if (!existsSync(input.path)) throw new ArtifactSourceNotFoundError(`artifact source not found: "${input.path}"`);
      const stat = statSync(input.path);
      if (stat.size > ARTIFACT_MAX_BYTES) {
        throw new OversizeArtifactError(
          `artifact "${input.label}" is ${stat.size} bytes, over the ${ARTIFACT_MAX_BYTES}-byte cap — not registered`,
        );
      }
      sizeBytes = stat.size;
      copyFileSync(input.path, this.snapshotPath(id));
    }
    const record = ArtifactRecordSchema.parse({
      id, kind: input.kind, label: input.label, agentId: input.agentId, taskId: input.taskId,
      createdAt: this.now(), sizeBytes,
      path: input.kind === "link" ? null : input.path,
      url: input.kind === "link" ? input.url : null,
      stepIndex: input.stepIndex,
    });
    this.records.set(id, record);
    this.gc();
    this.save();
    this.events.append({
      agentId: `artifact:${id}`, kind: "artifact_added",
      data: { id, artifactId: id, kind: record.kind, label: record.label, agentId: record.agentId, taskId: record.taskId,
        stepIndex: record.stepIndex, sizeBytes: record.sizeBytes, location: record.path ?? record.url },
    });
    return record;
  }

  get(id: string): ArtifactRecord {
    const rec = this.records.get(id);
    if (!rec) throw new UnknownArtifactError(`unknown artifact "${id}"`);
    return rec;
  }

  // Dynamic Planner: reads back the snapshotted bytes of a non-"link" artifact (the plan
  // gate needs the actual JSON content, not just existence/metadata).
  readContent(id: string, maxBytes?: number): string {
    const rec = this.get(id);
    if (rec.kind === "link") throw new UnknownArtifactError(`artifact "${id}" is a "link" kind with no snapshotted content`);
    if (maxBytes !== undefined && statSync(this.snapshotPath(id)).size > maxBytes) throw new OversizeArtifactError("artifact snapshot exceeds requested byte bound");
    return readFileSync(this.snapshotPath(id), "utf8");
  }

  list(filter?: ArtifactListFilter): ArtifactRecord[] {
    let out = [...this.records.values()];
    if (filter?.taskId !== undefined) out = out.filter((r) => r.taskId === filter.taskId);
    if (filter?.agentId !== undefined) out = out.filter((r) => r.agentId === filter.agentId);
    return out;
  }

  // D12/D13 bridge: the workflow `artifact` gate (WorkflowGateSchema, WorkflowGate.spec)
  // checks "does an artifact matching spec exist for this task" — a pinned artifactId
  // requires THAT specific artifact registered against this taskId; omitted means "any
  // artifact at all registered for this task" passes. F16.1 Phase 2 (WF-4/G5):
  // scope:"step" additionally requires the artifact's stepIndex to match the query's
  // (the CURRENT step at gate-eval time); an optional kind pin further narrows the match.
  existsForTask(taskId: string, query: ArtifactExistsQuery = {}): boolean {
    return this.findLatestForTask(taskId, query, { allowLink: true }) !== null;
  }

  // Bounded loops (iterate-until gate): resolves the SPECIFIC artifact record an
  // artifactValue route condition compares against — the MOST RECENTLY REGISTERED match
  // (list() preserves insertion order; a re-registered "current value" artifact each loop
  // round supersedes the prior one). A "link" kind has nothing snapshotted to read — excluded
  // by default; opts.allowLink lets existsForTask above reuse this exact matching logic for
  // its own (link-inclusive) existence check without changing its behavior.
  findLatestForTask(taskId: string, query: ArtifactExistsQuery = {}, opts: { allowLink?: boolean } = {}): ArtifactRecord | null {
    const { artifactId, scope = "task", stepIndex, kind } = query;
    const matches = (rec: ArtifactRecord): boolean => {
      if (!opts.allowLink && rec.kind === "link") return false;
      if (scope === "step" && rec.stepIndex !== stepIndex) return false;
      if (kind && rec.kind !== kind) return false;
      return true;
    };
    if (artifactId) {
      const rec = this.records.get(artifactId);
      return rec && rec.taskId === taskId && matches(rec) ? rec : null;
    }
    const all = this.list({ taskId }).filter(matches);
    return all.length ? all[all.length - 1]! : null;
  }
}
