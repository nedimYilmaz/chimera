import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../src/artifacts.js";
import { EventLog } from "../src/events.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

function fixture(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-art-security-"));
  dirs.push(dir);
  const victim = join(dir, "synthetic-secret.txt");
  writeFileSync(victim, "synthetic secret: preserve me");
  writeFileSync(join(dir, "artifacts.json"), JSON.stringify({ records: [{
    id, kind: "file", label: "untrusted persisted record", agentId: null, taskId: null,
    createdAt: 0, sizeBytes: 1, path: "unused", url: null,
  }] }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const events = new EventLog(dir);
  return { dir, victim, store: new ArtifactStore(dir, events, () => 40 * 24 * 60 * 60 * 1000) };
}

describe("SEC-003 persisted artifact path containment", () => {
  it("rejects traversal records before readContent can read outside artifacts", () => {
    const { store } = fixture("../synthetic-secret.txt");
    expect(() => store.readContent("../synthetic-secret.txt")).toThrow();
    expect(store.list()).toEqual([]);
  });

  it("never lets garbage collection delete an outside file named by a record", () => {
    const { store, victim } = fixture("../synthetic-secret.txt");
    store.add({ kind: "link", label: "trigger GC", url: "https://example.com", agentId: null, taskId: null });
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("synthetic secret: preserve me");
  });

  it.each(["..", "a/b", "a\\b", "/tmp/synthetic", "C:\\synthetic", "a\u0000b"])("quarantines unsafe persisted id %j", (id) => {
    expect(fixture(id).store.list()).toEqual([]);
  });
});
