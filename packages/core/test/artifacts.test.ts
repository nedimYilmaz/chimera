import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { EventLog } from "@chimera/core/events";
import { ArtifactStore, UnknownArtifactError, OversizeArtifactError, ArtifactSourceNotFoundError, ARTIFACT_MAX_BYTES } from "@chimera/core/artifacts";

function makeStore(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-art-"));
  const events = new EventLog(dir);
  return { dir, events, store: new ArtifactStore(dir, events, now) };
}

function writeSourceFile(dir: string, name: string, bytes: number): string {
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(bytes, "x"));
  return p;
}

describe("ArtifactStore (D13)", () => {
  it("registers a file artifact, snapshotting it under <home>/artifacts/<id>", () => {
    const { dir, store } = makeStore();
    const src = writeSourceFile(dir, "report.md", 42);
    const rec = store.add({ kind: "report", path: src, label: "review report", agentId: "agent-1", taskId: "task-1" });
    expect(rec).toMatchObject({ kind: "report", label: "review report", agentId: "agent-1", taskId: "task-1", sizeBytes: 42, path: src, url: null });
    expect(existsSync(join(dir, "artifacts", rec.id))).toBe(true);
    expect(store.get(rec.id)).toEqual(rec);
  });

  it("registers a link artifact with no snapshot", () => {
    const { dir, store } = makeStore();
    const rec = store.add({ kind: "link", url: "https://example.com/x", label: "external doc", agentId: null, taskId: null });
    expect(rec).toMatchObject({ kind: "link", url: "https://example.com/x", path: null, sizeBytes: null });
    expect(existsSync(join(dir, "artifacts", rec.id))).toBe(false);
  });

  it("persists an optional stepIndex; absent when not given", () => {
    const { store } = makeStore();
    const withStep = store.add({ kind: "link", url: "https://x/1", label: "a", agentId: null, taskId: "t", stepIndex: 2 });
    expect(withStep.stepIndex).toBe(2);
    const withoutStep = store.add({ kind: "link", url: "https://x/2", label: "b", agentId: null, taskId: "t" });
    expect(withoutStep.stepIndex).toBeUndefined();
  });

  it("refuses an oversize artifact — nothing is written, error is agent-visible", () => {
    const { dir, store } = makeStore();
    const src = writeSourceFile(dir, "huge.bin", ARTIFACT_MAX_BYTES + 1);
    expect(() => store.add({ kind: "file", path: src, label: "too big", agentId: "a", taskId: null }))
      .toThrow(OversizeArtifactError);
    expect(store.list()).toEqual([]);
    expect(readdirSync(join(dir, "artifacts"))).toEqual([]);
  });

  it("throws a clear error when the source file doesn't exist", () => {
    const { dir, store } = makeStore();
    expect(() => store.add({ kind: "file", path: join(dir, "ghost.txt"), label: "x", agentId: null, taskId: null }))
      .toThrow(ArtifactSourceNotFoundError);
  });

  it("get() throws UnknownArtifactError for an unregistered id", () => {
    const { store } = makeStore();
    expect(() => store.get("ghost")).toThrow(UnknownArtifactError);
  });

  it("list() filters by taskId and agentId", () => {
    const { store } = makeStore();
    const a = store.add({ kind: "link", url: "https://x/1", label: "a", agentId: "agent-1", taskId: "task-1" });
    const b = store.add({ kind: "link", url: "https://x/2", label: "b", agentId: "agent-2", taskId: "task-1" });
    const c = store.add({ kind: "link", url: "https://x/3", label: "c", agentId: "agent-1", taskId: "task-2" });
    expect(store.list({ taskId: "task-1" }).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.list({ agentId: "agent-1" }).map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
    expect(store.list({ taskId: "task-1", agentId: "agent-1" }).map((r) => r.id)).toEqual([a.id]);
  });

  it("existsForTask: unpinned passes on ANY artifact for the task, pinned requires the exact id", () => {
    const { store } = makeStore();
    const rec = store.add({ kind: "link", url: "https://x", label: "a", agentId: null, taskId: "task-1" });
    expect(store.existsForTask("task-1")).toBe(true);
    expect(store.existsForTask("task-2")).toBe(false);
    expect(store.existsForTask("task-1", { artifactId: rec.id })).toBe(true);
    expect(store.existsForTask("task-1", { artifactId: "some-other-id" })).toBe(false);
    expect(store.existsForTask("task-2", { artifactId: rec.id })).toBe(false);   // right id, wrong task
  });

  it("emits artifact_added on add", () => {
    const { store, events } = makeStore();
    const seen: unknown[] = [];
    events.subscribe((e) => { if (e.kind === "artifact_added") seen.push(e.data); });
    const rec = store.add({ kind: "link", url: "https://x", label: "a", agentId: "ag", taskId: "t" });
    expect(seen).toEqual([{
      id: rec.id,
      artifactId: rec.id,
      kind: "link",
      label: "a",
      agentId: "ag",
      taskId: "t",
      stepIndex: undefined,
      sizeBytes: null,
      location: "https://x",
    }]);
  });

  it("persists across a reopen (restart-recovery precedent) — metadata AND the snapshot file", () => {
    const { dir, events } = makeStore();
    const store1 = new ArtifactStore(dir, events);
    const src = writeSourceFile(dir, "report.md", 10);
    const rec = store1.add({ kind: "report", path: src, label: "r", agentId: "a", taskId: "t" });

    const store2 = new ArtifactStore(dir, events);   // simulates a daemon restart over the same home
    expect(store2.get(rec.id)).toEqual(rec);
    expect(existsSync(join(dir, "artifacts", rec.id))).toBe(true);
  });

  it("quarantines a corrupt artifacts.json instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-art-corrupt-"));
    const events = new EventLog(dir);
    writeFileSync(join(dir, "artifacts.json"), "{not json");
    const store = new ArtifactStore(dir, events);
    expect(store.list()).toEqual([]);
    const quarantined = readdirSync(dir).filter((f) => f.startsWith("artifacts.json.corrupt-"));
    expect(quarantined.length).toBe(1);
  });

  it("an artifacts.json persisted before F16.1 Phase 2 (records with no stepIndex key at all) parses unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-art-legacy-"));
    const events = new EventLog(dir);
    const legacy = {
      records: [{ id: "a1", kind: "link", label: "l", agentId: null, taskId: "t", createdAt: 1700000000000, sizeBytes: null, path: null, url: "https://x" }],
    };
    writeFileSync(join(dir, "artifacts.json"), JSON.stringify(legacy, null, 2));
    const store = new ArtifactStore(dir, events);
    const rec = store.get("a1");
    expect(rec.stepIndex).toBeUndefined();
    expect(store.existsForTask("t")).toBe(true);                       // unscoped query still matches
    expect(store.existsForTask("t", { scope: "step", stepIndex: 0 })).toBe(false);   // no stepIndex on record -> never matches a step-scoped query
  });

  it("existsForTask honors an optional kind pin alongside scope", () => {
    const { store } = makeStore();
    store.add({ kind: "link", url: "https://x/1", label: "a", agentId: null, taskId: "task-1" });
    expect(store.existsForTask("task-1", { kind: "link" })).toBe(true);
    expect(store.existsForTask("task-1", { kind: "report" })).toBe(false);
  });

  it("gc: evicts artifacts older than 30 days, snapshot file included", () => {
    let now = 1_000_000;
    const { dir, store } = makeStore(() => now);
    const src = writeSourceFile(dir, "old.md", 5);
    const old = store.add({ kind: "report", path: src, label: "old", agentId: null, taskId: null });
    expect(existsSync(join(dir, "artifacts", old.id))).toBe(true);

    now += 31 * 24 * 60 * 60 * 1000;   // 31 days later
    const src2 = writeSourceFile(dir, "new.md", 5);
    store.add({ kind: "report", path: src2, label: "new", agentId: null, taskId: null });   // triggers gc()

    expect(store.list().map((r) => r.label)).toEqual(["new"]);
    expect(existsSync(join(dir, "artifacts", old.id))).toBe(false);
  });

  it("gc: keeps only the newest 200 records", () => {
    let now = 0;
    const { store } = makeStore(() => now++);
    for (let i = 0; i < 205; i++) {
      store.add({ kind: "link", url: `https://x/${i}`, label: `l${i}`, agentId: null, taskId: null });
    }
    const remaining = store.list();
    expect(remaining.length).toBe(200);
    expect(remaining.map((r) => r.label)).not.toContain("l0");
    expect(remaining.map((r) => r.label)).toContain("l204");
  });
});
it("bounds context reads against actual snapshot size, including metadata/content mismatch", () => {
  const { dir, store } = makeStore(); const src = writeSourceFile(dir, "bounded.txt", 10);
  const rec = store.add({ kind: "file", path: src, label: "bounded", agentId: "a", taskId: null });
  expect(store.readContent(rec.id, 10)).toBe("x".repeat(10));
  writeFileSync(join(dir, "artifacts", rec.id), "x".repeat(32769));
  expect(() => store.readContent(rec.id, 32768)).toThrow(OversizeArtifactError);
});
