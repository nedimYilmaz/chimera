import { describe, it, expect } from "vitest";
import { MemoryRecordSchema, type MemoryRecord } from "@chimera/protocol";
import { MemoryLinkIndex, parseLinks } from "@chimera/core/memory-links";

// MEM-1: the [[wiki-link]] parser + derived index (PLAN-MEMORY.md §3).

let seq = 0;
function rec(partial: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  const now = 1_000 + seq++;   // monotonic so "most-recently-updated" is deterministic without wall-clock
  return MemoryRecordSchema.parse({ author: "ag", createdAt: now, updatedAt: now, ...partial });
}

describe("parseLinks", () => {
  it("extracts a plain [[target]]", () => {
    expect(parseLinks("see [[GATE-WAIT-DEATH]] for details").map((l) => l.target)).toEqual(["GATE-WAIT-DEATH"]);
  });

  it("strips the alias display text from [[target|display]]", () => {
    expect(parseLinks("read [[b9d1813e|the supersede note]] now").map((l) => l.target)).toEqual(["b9d1813e"]);
  });

  it("keeps adjacent links separate (no greedy over-match)", () => {
    expect(parseLinks("[[a]] [[b]]").map((l) => l.target)).toEqual(["a", "b"]);
  });

  it("trims whitespace inside the brackets", () => {
    expect(parseLinks("[[  spaced title  ]]").map((l) => l.target)).toEqual(["spaced title"]);
  });

  it("skips empty / whitespace-only targets", () => {
    expect(parseLinks("[[]] and [[   ]] and [[|x]]")).toEqual([]);
  });

  it("caps at 64 links per note", () => {
    const many = Array.from({ length: 100 }, (_, i) => `[[t${i}]]`).join(" ");
    expect(parseLinks(many).length).toBe(64);
  });

  it("records the mention span for snippet extraction", () => {
    const [l] = parseLinks("xx [[t]] yy");
    expect("xx [[t]] yy".slice(l.start, l.end)).toBe("[[t]]");
  });
});

describe("MemoryLinkIndex resolution (§3 precedence)", () => {
  it("resolves an exact id, id-prefix (≥8 hex), and case-insensitive title — in that order", () => {
    const target = rec({ id: "abc1234567deadbeef", title: "Retry Doctrine", text: "target" });
    const byExact = rec({ id: "l1", text: "link [[abc1234567deadbeef]]" });
    const byPrefix = rec({ id: "l2", text: "link [[abc12345]]" });        // 8-hex prefix of target.id
    const byTitle = rec({ id: "l3", text: "link [[retry doctrine]]" });   // case-insensitive title
    const records = [target, byExact, byPrefix, byTitle];
    const idx = new MemoryLinkIndex();
    idx.rebuild(records);

    for (const linker of [byExact, byPrefix, byTitle]) {
      const [link] = idx.resolveLinks(linker, records);
      expect(link.resolvedId).toBe(target.id);
      expect(link.resolvedTitle).toBe("Retry Doctrine");
    }
  });

  it("title collision resolves to the most-recently-updated record", () => {
    const older = rec({ id: "old", title: "Dup", text: "older" });
    const newer = rec({ id: "new", title: "Dup", text: "newer" });   // higher updatedAt (seq)
    const linker = rec({ id: "lk", text: "[[Dup]]" });
    const records = [older, newer, linker];
    const idx = new MemoryLinkIndex();
    idx.rebuild(records);
    expect(idx.resolveLinks(linker, records)[0].resolvedId).toBe("new");
  });

  it("classifies a dangling title-link as a GHOST (resolvedTitle set, resolvedId null)", () => {
    const linker = rec({ id: "lk", text: "todo: write [[Token economy protocol]]" });
    const idx = new MemoryLinkIndex();
    idx.rebuild([linker]);
    const [link] = idx.resolveLinks(linker, [linker]);
    expect(link).toMatchObject({ resolvedId: null, resolvedTitle: "Token economy protocol" });
  });

  it("classifies a dangling id-form link as MISSING (both null)", () => {
    const linker = rec({ id: "lk", text: "supersedes [[deadbeef12]]" });   // 10-hex, no such record
    const idx = new MemoryLinkIndex();
    idx.rebuild([linker]);
    const [link] = idx.resolveLinks(linker, [linker]);
    expect(link).toMatchObject({ resolvedId: null, resolvedTitle: null });
  });

  it("does not resolve an ambiguous id-prefix", () => {
    const a = rec({ id: "abcd1234ffff0000", text: "a" });
    const b = rec({ id: "abcd1234eeee1111", text: "b" });   // shares the 8-hex prefix with a
    const linker = rec({ id: "lk", text: "[[abcd1234]]" });
    const records = [a, b, linker];
    const idx = new MemoryLinkIndex();
    idx.rebuild(records);
    // ambiguous prefix + no title match ⇒ missing (id-form)
    expect(idx.resolveLinks(linker, records)[0]).toMatchObject({ resolvedId: null, resolvedTitle: null });
  });
});

describe("MemoryLinkIndex backlinks", () => {
  it("collects inbound links with ±80-char snippets, one per mention", () => {
    const target = rec({ id: "t1", title: "Hub", text: "hub note" });
    const linker = rec({ id: "l1", text: "context before [[Hub]] and again later [[Hub]] end" });
    const records = [target, linker];
    const idx = new MemoryLinkIndex();
    idx.rebuild(records);
    const backs = idx.backlinks("t1", records);
    expect(backs.length).toBe(2);               // two mentions ⇒ two navigable backlinks
    expect(backs[0]).toMatchObject({ id: "l1", title: null, kind: "note" });
    expect(backs[0].snippet).toContain("[[Hub]]");
  });
});
