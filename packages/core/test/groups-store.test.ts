import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupStore, GroupCapError, GroupNotFoundError } from "@chimera/core/groups";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "chimera-groups-"));
}

describe("GroupStore", () => {
  it("creates a group, slugifies its id, and persists across a fresh instance", () => {
    const d = dir();
    const store = new GroupStore(d);
    const g = store.create({ name: "Sprint 42!", now: 1000 });
    expect(g.id).toBe("sprint-42");
    expect(g.name).toBe("Sprint 42!");
    expect(g.createdAt).toBe(1000);
    expect(g.order).toBe(0);

    const reloaded = new GroupStore(d);
    expect(reloaded.list()).toEqual([g]);
  });

  it("dedupes a slug collision with a numeric suffix", () => {
    const store = new GroupStore(dir());
    const a = store.create({ name: "daily", now: 1 });
    const b = store.create({ name: "daily", now: 2 });
    expect(a.id).toBe("daily");
    expect(b.id).toBe("daily-2");
  });

  it("assigns increasing order and lists sorted by it", () => {
    const store = new GroupStore(dir());
    store.create({ name: "first", now: 1 });
    store.create({ name: "second", now: 2 });
    const list = store.list();
    expect(list.map((g) => g.name)).toEqual(["first", "second"]);
  });

  it("defaults color to undefined when not given, and honors an explicit one", () => {
    const store = new GroupStore(dir());
    const noColor = store.create({ name: "no color", now: 1 });
    expect(noColor.color).toBeUndefined();
    const withColor = store.create({ name: "colored", now: 2, color: "amber" });
    expect(withColor.color).toBe("amber");
  });

  it("update: renames and recolors an existing group", () => {
    const store = new GroupStore(dir());
    const g = store.create({ name: "old name", now: 1 });
    const updated = store.update(g.id, { name: "new name", color: "teal" });
    expect(updated.name).toBe("new name");
    expect(updated.color).toBe("teal");
    expect(store.get(g.id)?.name).toBe("new name");
  });

  it("update: throws GroupNotFoundError for an unknown id", () => {
    const store = new GroupStore(dir());
    expect(() => store.update("nope", { name: "x" })).toThrow(GroupNotFoundError);
  });

  it("delete: idempotent — removing a nonexistent id is a silent no-op", () => {
    const store = new GroupStore(dir());
    expect(() => store.delete("never-existed")).not.toThrow();
  });

  it("delete: removes the group from the registry (never touches any agent record — GroupStore holds no reference to one)", () => {
    const store = new GroupStore(dir());
    const g = store.create({ name: "temp", now: 1 });
    store.delete(g.id);
    expect(store.get(g.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("caps at 64 groups — the 65th create throws GroupCapError", () => {
    const store = new GroupStore(dir());
    for (let i = 0; i < 64; i++) store.create({ name: `g${i}`, now: i });
    expect(() => store.create({ name: "one too many", now: 1000 })).toThrow(GroupCapError);
  });

  it("a missing groups.json degrades to an empty registry, never throws", () => {
    const store = new GroupStore(join(dir(), "nonexistent-subdir"));
    expect(store.list()).toEqual([]);
  });

  it("a corrupt groups.json degrades to an empty registry, never throws", () => {
    const d = dir();
    writeFileSync(join(d, "groups.json"), "{ not valid json at all ]]]");
    const store = new GroupStore(d);
    expect(store.list()).toEqual([]);
    // and it's still fully usable afterward — a corrupt file doesn't wedge future writes.
    const g = store.create({ name: "recovered", now: 1 });
    expect(g.id).toBe("recovered");
  });

  it("a groups.json holding something other than an array degrades to an empty registry", () => {
    const d = dir();
    writeFileSync(join(d, "groups.json"), JSON.stringify({ not: "an array" }));
    const store = new GroupStore(d);
    expect(store.list()).toEqual([]);
  });
});
