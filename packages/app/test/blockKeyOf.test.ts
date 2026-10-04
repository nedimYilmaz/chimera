import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@chimera/ui-state";

// TranscriptSegment transitively imports ../state/store -> rpc/bridge, which
// fires real Tauri listen()/invoke() calls as an import-time DEV side effect
// (same problem TranscriptPanel.test.tsx hits) — stub it so this file only
// exercises the pure blockKeyOf/nextBlockKeyOrigin/groupTranscriptBlocks
// functions.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

import { blockKeyOf, nextBlockKeyOrigin } from "../src/components/TranscriptSegment";
import { groupTranscriptBlocks } from "../src/state/selectors";

// TRANSCRIPT-SCROLL-JUMP: blockKeyOf's React key must stay STABLE for every
// pre-existing block across BOTH a tail append (new output streaming in) and
// a head prepend (prependHistory adding older rows to the front) — a changed
// key unmounts/remounts the block, which loses both the native CSS scroll
// anchor (needs the SAME DOM node to stay put) and the content-visibility
// height cache. nextBlockKeyOrigin is the pure step function that keeps
// `block.index + origin` invariant across renders; these are its unit tests,
// decoupled from any DOM rendering or React hook machinery.

function turn(text: string): TranscriptItem {
  return { role: "assistant", text, streaming: false };
}

function keyOf(items: readonly TranscriptItem[], origin: number, text: string): string {
  const block = groupTranscriptBlocks(items).find((b) => (b as { item?: { text: string } }).item?.text === text);
  if (!block) throw new Error(`no block for "${text}"`);
  return blockKeyOf(block, origin);
}

describe("nextBlockKeyOrigin — append (new output streaming in)", () => {
  it("appending a new item leaves every pre-existing block's key UNCHANGED", () => {
    const before: TranscriptItem[] = [turn("a"), turn("b"), turn("c")];
    const origin0 = nextBlockKeyOrigin([], 0, before); // initial mount

    const after: TranscriptItem[] = [...before, turn("d")]; // append
    const origin1 = nextBlockKeyOrigin(before, origin0, after);

    for (const text of ["a", "b", "c"]) {
      expect(keyOf(after, origin1, text)).toBe(keyOf(before, origin0, text));
    }
    // the new block gets a key nothing pre-existing used.
    const existingKeys = new Set(["a", "b", "c"].map((t) => keyOf(before, origin0, t)));
    expect(existingKeys.has(keyOf(after, origin1, "d"))).toBe(false);
  });

  it("repeated streaming appends (the reported flicker trigger) never disturb earlier blocks", () => {
    let items: TranscriptItem[] = [turn("a")];
    let origin = nextBlockKeyOrigin([], 0, items);
    const keyA = keyOf(items, origin, "a");

    for (const t of ["b", "c", "d", "e"]) {
      const prev = items;
      const prevOrigin = origin;
      items = [...items, turn(t)];
      origin = nextBlockKeyOrigin(prev, prevOrigin, items);
      expect(keyOf(items, origin, "a")).toBe(keyA); // "a" never moves, however many turns stream in after it
    }
  });
});

describe("nextBlockKeyOrigin — prepend (prependHistory adding older rows)", () => {
  it("every pre-existing block's key is UNCHANGED after older rows are prepended", () => {
    const before: TranscriptItem[] = [turn("a"), turn("b"), turn("c")];
    const origin0 = nextBlockKeyOrigin([], 0, before);

    const after: TranscriptItem[] = [turn("older-1"), turn("older-2"), ...before]; // prepend K=2
    const origin1 = nextBlockKeyOrigin(before, origin0, after);

    for (const text of ["a", "b", "c"]) {
      expect(keyOf(after, origin1, text)).toBe(keyOf(before, origin0, text));
    }
  });

  it("the newly-prepended blocks get keys DISJOINT from every pre-existing block's key", () => {
    const before: TranscriptItem[] = [turn("a"), turn("b")];
    const origin0 = nextBlockKeyOrigin([], 0, before);
    const beforeKeys = new Set(["a", "b"].map((t) => keyOf(before, origin0, t)));

    const after: TranscriptItem[] = [turn("older-1"), ...before];
    const origin1 = nextBlockKeyOrigin(before, origin0, after);

    expect(beforeKeys.has(keyOf(after, origin1, "older-1"))).toBe(false);
  });

  it("tool-run blocks (keyed by startIndex) are equally stable across a prepend", () => {
    const tool = (name: string): TranscriptItem => ({ role: "tool", toolName: name, status: "done" });
    const before: TranscriptItem[] = [turn("a"), tool("Bash"), tool("Read")];
    const origin0 = nextBlockKeyOrigin([], 0, before);
    const toolBlockBefore = groupTranscriptBlocks(before).find((b) => b.kind === "tools")!;
    const keyBefore = blockKeyOf(toolBlockBefore, origin0);

    const after: TranscriptItem[] = [turn("older"), ...before];
    const origin1 = nextBlockKeyOrigin(before, origin0, after);
    const toolBlockAfter = groupTranscriptBlocks(after).find((b) => b.kind === "tools")!;
    const keyAfter = blockKeyOf(toolBlockAfter, origin1);

    expect(keyAfter).toBe(keyBefore);
  });

  it("BOTH invariants hold across a prepend followed by an append (append doesn't reintroduce the prepend bug, and vice versa)", () => {
    const before: TranscriptItem[] = [turn("a"), turn("b")];
    const origin0 = nextBlockKeyOrigin([], 0, before);

    const prepended: TranscriptItem[] = [turn("older"), ...before];
    const origin1 = nextBlockKeyOrigin(before, origin0, prepended);

    const appended: TranscriptItem[] = [...prepended, turn("new")];
    const origin2 = nextBlockKeyOrigin(prepended, origin1, appended);

    expect(keyOf(appended, origin2, "a")).toBe(keyOf(before, origin0, "a"));
    expect(keyOf(appended, origin2, "b")).toBe(keyOf(before, origin0, "b"));
    expect(keyOf(appended, origin2, "older")).toBe(keyOf(prepended, origin1, "older"));
  });
});

describe("nextBlockKeyOrigin — in-place mutation (streaming delta / tool status flip)", () => {
  it("a same-length mutation at the TAIL (a streaming delta) keeps the origin — and the key — unchanged", () => {
    const before: TranscriptItem[] = [turn("a"), { role: "assistant", text: "hel", streaming: true }];
    const origin0 = nextBlockKeyOrigin([], 0, before);
    const keyBefore = keyOf(before, origin0, "a");

    // simulate the reducer's message_delta in-place replace: same length, new object at the tail.
    const mutated: TranscriptItem[] = [before[0]!, { role: "assistant", text: "hello", streaming: true }];
    const origin1 = nextBlockKeyOrigin(before, origin0, mutated);

    expect(origin1).toBe(origin0);
    expect(keyOf(mutated, origin1, "a")).toBe(keyBefore);
  });

  it("a same-length mutation at INDEX 0 (edge case) does not get misread as a prepend", () => {
    const tool = (status: "called" | "done"): TranscriptItem => ({ role: "tool", toolName: "Bash", status });
    const before: TranscriptItem[] = [tool("called"), turn("b")];
    const origin0 = nextBlockKeyOrigin([], 0, before);
    const keyBBefore = keyOf(before, origin0, "b");

    // the tool_result reducer case replaces transcript[0] in place (status called -> done),
    // same array length, front-most SLOT technically "changed" but nothing shifted position.
    const mutated: TranscriptItem[] = [tool("done"), before[1]!];
    const origin1 = nextBlockKeyOrigin(before, origin0, mutated);

    expect(origin1).toBe(origin0); // must NOT reset to 0 as if this were a prepend
    expect(keyOf(mutated, origin1, "b")).toBe(keyBBefore);
  });
});

describe("blockKeyOf — a forward-index key alone (no origin tracking) would NOT be stable across a prepend", () => {
  it("sanity check that the origin-tracking invariant is the point", () => {
    const before: TranscriptItem[] = [turn("a"), turn("b")];
    const blockA = groupTranscriptBlocks(before)[0]!; // "a", forward index 0
    const forwardIndexKey = `s${(blockA as { index: number }).index}`;

    const after: TranscriptItem[] = [turn("older-1"), ...before];
    const blockAAfter = groupTranscriptBlocks(after).find((b) => (b as { item: { text: string } }).item.text === "a")!;
    const forwardIndexKeyAfter = `s${(blockAAfter as { index: number }).index}`;

    expect(forwardIndexKeyAfter).not.toBe(forwardIndexKey); // proves the bare forward-index scheme breaks

    const origin0 = nextBlockKeyOrigin([], 0, before);
    const origin1 = nextBlockKeyOrigin(before, origin0, after);
    expect(blockKeyOf(blockAAfter, origin1)).toBe(blockKeyOf(blockA, origin0)); // the fix holds
  });
});
