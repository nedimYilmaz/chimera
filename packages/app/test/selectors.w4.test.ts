import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "@chimera/ui-state";
import { deriveEditDiff, formatToolInput, mergeEchoTimestamps, toolPathHint } from "../src/state/selectors";
import { tokenizeInline } from "../src/components/Markdown";

// W4 — tool-detail derivations + echo-timestamp merge + markdown tokenizer.

describe("formatToolInput (TUI-015: never truncated)", () => {
  it("renders a string input VERBATIM and an object as pretty/raw JSON", () => {
    expect(formatToolInput("git push origin main --force-with-lease", true))
      .toBe("git push origin main --force-with-lease");
    const obj = { file_path: "a.ts", offset: 2870 };
    expect(formatToolInput(obj, true)).toBe(JSON.stringify(obj, null, 2));
    expect(formatToolInput(obj, false)).toBe(JSON.stringify(obj));
    expect(formatToolInput(undefined, true)).toBe("");
  });
});

describe("toolPathHint", () => {
  it("prefers file_path/path/command in order; '' when nothing usable", () => {
    expect(toolPathHint({ file_path: "packages/tui/src/App.tsx" })).toBe("packages/tui/src/App.tsx");
    expect(toolPathHint({ command: "vitest run" })).toBe("vitest run");
    expect(toolPathHint("raw")).toBe("raw");
    expect(toolPathHint({ nope: 1 })).toBe("");
  });
});

describe("deriveEditDiff (coverage B4: first hunk, ±2)", () => {
  it("derives the first changed lines from old_string/new_string", () => {
    const diff = deriveEditDiff({
      file_path: "packages/tui/src/transcriptWindow.ts",
      old_string: "const shift = rowOffset;\nkeep me",
      new_string: "const shift = Math.min(rowOffset, Math.max(0, content - region));\nkeep me",
    });
    expect(diff).toEqual({
      file: "transcriptWindow.ts",
      minus: ["const shift = rowOffset;"],
      plus: ["const shift = Math.min(rowOffset, Math.max(0, content - region));"],
    });
  });
  it("clips to 2 lines each side and nulls non-Edit inputs / no-op edits", () => {
    const diff = deriveEditDiff({ old_string: "a\nb\nc\nd", new_string: "x\ny\nz\nw" });
    expect(diff!.minus).toEqual(["a", "b"]);
    expect(diff!.plus).toEqual(["x", "y"]);
    expect(deriveEditDiff({ command: "ls" })).toBeNull();
    expect(deriveEditDiff({ old_string: "same", new_string: "same" })).toBeNull();
  });
});

describe("mergeEchoTimestamps (the W3 'local echo has no timestamp' gap)", () => {
  it("assigns Date.now() stamps to from-less user turns IN ORDER, leaving attributed items alone", () => {
    const transcript: TranscriptItem[] = [
      { role: "user", text: "first" },                          // local echo
      { role: "assistant", text: "reply", streaming: false },
      { role: "user", text: "delivered", from: "other" },       // delivered — event-attributed
      { role: "user", text: "second" },                         // local echo
    ];
    const base: Array<number | undefined> = [undefined, 500, 600, undefined];
    expect(mergeEchoTimestamps(base, transcript, [100, 200])).toEqual([100, 500, 600, 200]);
    // fewer stamps than echoes → later echoes stay undefined
    expect(mergeEchoTimestamps(base, transcript, [100])).toEqual([100, 500, 600, undefined]);
    // never mutates the input
    expect(base[0]).toBeUndefined();
  });
});

describe("Markdown tokenizer (no html, links as text)", () => {
  it("splits bold / inline code / links", () => {
    expect(tokenizeInline("fix **now** via `git push` see [docs](https://x.y)")).toEqual([
      { kind: "text", text: "fix " },
      { kind: "bold", toks: [{ kind: "text", text: "now" }] },
      { kind: "text", text: " via " },
      { kind: "code", text: "git push" },
      { kind: "text", text: " see " },
      { kind: "link", text: "docs", url: "https://x.y" },
    ]);
  });
  it("passes html through as inert text (sanitized by construction)", () => {
    expect(tokenizeInline("<img onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img onerror=alert(1)>" }]);
  });

  // INLINE-SPANS-DO-NOT-NEST — this minimal tokenizer had the same flat-bold
  // defect as ui-state's markdown.ts: a link inside ** used to be swallowed
  // whole as raw text instead of rendering as a link.
  it("nests a link span inside bold instead of swallowing it as raw text", () => {
    const url = "https://github.com/acmecorp/acmecorp-gitops/pull/357";
    expect(tokenizeInline(`**[${url}](${url})**`)).toEqual([
      { kind: "bold", toks: [{ kind: "link", text: url, url }] },
    ]);
  });
});
