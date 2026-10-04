import { describe, it, expect } from "vitest";
import {
  encodeQuoteBlock,
  MAX_TABLE_COLS,
  parseMessageBlocks,
  splitLeadingQuote,
  tokenizeInline,
  type MessageBlock,
} from "@chimera/ui-state";

// F12 — the shared markdown-subset parser. Focus: the STREAMING CONTRACT
// (raw-until-close, exactly-one format transition, no reflow), determinism,
// the >8-column clamp, and the chart fallbacks.

const types = (blocks: MessageBlock[]): string[] => blocks.map((b) => b.type);

describe("tokenizeInline", () => {
  it("splits bold / code / link, earliest match wins", () => {
    const spans = tokenizeInline("run `q-falcon` then **go** see [docs](http://x)");
    expect(spans).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "q-falcon" },
      { kind: "text", text: " then " },
      { kind: "bold", spans: [{ kind: "text", text: "go" }] },
      { kind: "text", text: " see " },
      { kind: "link", text: "docs", url: "http://x" },
    ]);
  });

  it("returns a single empty text span for empty input (never []).", () => {
    expect(tokenizeInline("")).toEqual([{ kind: "text", text: "" }]);
  });

  // INLINE-SPANS-DO-NOT-NEST — a bold-wrapped link used to be swallowed whole
  // as raw literal text (the user's exact reported string: a PR link wrapped
  // in ** rendered verbatim instead of as a link). Bold now re-tokenizes its
  // content, so a nested link is a real link span, not flat text.
  it("nests a link span inside bold instead of swallowing it as raw text", () => {
    const url = "https://github.com/acmecorp/acmecorp-gitops/pull/357";
    const spans = tokenizeInline(`**[${url}](${url})**`);
    expect(spans).toEqual([
      { kind: "bold", spans: [{ kind: "link", text: url, url }] },
    ]);
  });

  it("nests inline code inside bold", () => {
    expect(tokenizeInline("**see `git push` now**")).toEqual([
      {
        kind: "bold",
        spans: [
          { kind: "text", text: "see " },
          { kind: "code", text: "git push" },
          { kind: "text", text: " now" },
        ],
      },
    ]);
  });

  it("nests bold inside a list item's spans", () => {
    const blocks = parseMessageBlocks(`- **[a link](https://x.test)** in a list\n`, true);
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    expect(list.type).toBe("list");
    if (list.type !== "list") return;
    expect(list.items[0]![0]).toEqual({
      kind: "bold",
      spans: [{ kind: "link", text: "a link", url: "https://x.test" }],
    });
  });

  // Adversarial input: unbalanced markers, empty bold, and input that looks
  // deeply nested must never loop or throw — bold's content structurally can
  // never itself contain "**" (INLINE_RE's bold body is `[^*]+`), so the
  // recursion is bounded to exactly one extra level regardless of input.
  it("handles empty bold, unbalanced markers, and pathological nesting without looping", () => {
    // bold's body requires at least one char ([^*]+, no `*`), so "****" (zero
    // chars between the marker pairs) and a lone "**" never match at all —
    // both fall through as plain literal text, never a crash or empty bold.
    expect(tokenizeInline("****")).toEqual([{ kind: "text", text: "****" }]);
    expect(tokenizeInline("**")).toEqual([{ kind: "text", text: "**" }]);
    expect(tokenizeInline("**a**b**c**")).toEqual([
      { kind: "bold", spans: [{ kind: "text", text: "a" }] },
      { kind: "text", text: "b" },
      { kind: "bold", spans: [{ kind: "text", text: "c" }] },
    ]);
    // a naive "**" repeated many times must resolve in linear time, not hang
    const many = "**x**".repeat(200);
    expect(() => tokenizeInline(many)).not.toThrow();
  });

  // F22 (W24) — @mention: tokenizer matches SHAPE only (agent identity is a
  // renderer concern), both the bare adjective-animal form and the engine-
  // qualified "studio/name" form.
  it("tokenizes a bare @adjective-animal mention", () => {
    expect(tokenizeInline("ask @frosty-lynx to look")).toEqual([
      { kind: "text", text: "ask " },
      { kind: "mention", name: "frosty-lynx" },
      { kind: "text", text: " to look" },
    ]);
  });

  it("tokenizes an engine-qualified @studio/name mention", () => {
    expect(tokenizeInline("cc @acme/frosty-lynx")).toEqual([
      { kind: "text", text: "cc " },
      { kind: "mention", name: "acme/frosty-lynx" },
    ]);
  });

  it("tokenizes @main (no hyphen required)", () => {
    expect(tokenizeInline("@main take the wrapped-line clamp")).toEqual([
      { kind: "mention", name: "main" },
      { kind: "text", text: " take the wrapped-line clamp" },
    ]);
  });

  // MEM-5 — a `[[target]]` wiki-link: target drives resolution, text is the
  // display label (equal to the target when there's no alias).
  it("tokenizes a bare [[target]] wiki-link", () => {
    expect(tokenizeInline("see [[GATE-WAIT-DEATH]] for the recipe")).toEqual([
      { kind: "text", text: "see " },
      { kind: "wikilink", target: "GATE-WAIT-DEATH", text: "GATE-WAIT-DEATH" },
      { kind: "text", text: " for the recipe" },
    ]);
  });

  it("tokenizes the [[target|alias]] form (alias becomes the display text)", () => {
    expect(tokenizeInline("SUPERSEDES [[b9d1813e|the old plan]]")).toEqual([
      { kind: "text", text: "SUPERSEDES " },
      { kind: "wikilink", target: "b9d1813e", text: "the old plan" },
    ]);
  });

  it("falls back to the target when the alias is blank, and trims both", () => {
    expect(tokenizeInline("[[ ops/protocols | ]]")).toEqual([
      { kind: "wikilink", target: "ops/protocols", text: "ops/protocols" },
    ]);
  });

  it("leaves a real markdown link untouched (wiki-link never shadows it)", () => {
    expect(tokenizeInline("[docs](http://x) and [[Note]]")).toEqual([
      { kind: "link", text: "docs", url: "http://x" },
      { kind: "text", text: " and " },
      { kind: "wikilink", target: "Note", text: "Note" },
    ]);
  });
});

// BARE-URL-AUTOLINK — a plain `https://…` with no `[text](url)` wrapper.
describe("bare-URL autolink", () => {
  it("linkifies a bare https URL with the url as its own display text", () => {
    expect(tokenizeInline("see https://example.com/foo for details")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://example.com/foo", url: "https://example.com/foo" },
      { kind: "text", text: " for details" },
    ]);
  });

  it("trims a sentence's trailing period off the URL", () => {
    expect(tokenizeInline("see https://example.com/foo.")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://example.com/foo", url: "https://example.com/foo" },
      { kind: "text", text: "." },
    ]);
  });

  it("trims trailing comma/semicolon/colon/bang/question mark and a closing quote", () => {
    for (const [input, url] of [
      ["https://example.com,", "https://example.com"],
      ["https://example.com;", "https://example.com"],
      ["https://example.com:", "https://example.com"],
      ["https://example.com!", "https://example.com"],
      ["https://example.com?", "https://example.com"],
      ['"https://example.com"', "https://example.com"],
    ] as const) {
      const spans = tokenizeInline(input);
      const link = spans.find((s) => s.kind === "link");
      expect(link).toEqual({ kind: "link", text: url, url });
    }
  });

  it("keeps a URL's own balanced trailing paren (e.g. a wiki article title)", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(tokenizeInline(url)).toEqual([{ kind: "link", text: url, url }]);
  });

  it("keeps the balanced paren AND still trims a sentence's trailing period after it", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(tokenizeInline(`${url}.`)).toEqual([
      { kind: "link", text: url, url },
      { kind: "text", text: "." },
    ]);
  });

  it("does not swallow a prose paren wrapping the whole URL", () => {
    const url = "https://example.com";
    expect(tokenizeInline(`(see ${url})`)).toEqual([
      { kind: "text", text: "(see " },
      { kind: "link", text: url, url },
      { kind: "text", text: ")" },
    ]);
  });

  it("does not double-match a URL already inside [text](url)", () => {
    const url = "https://example.com/x";
    expect(tokenizeInline(`[docs](${url})`)).toEqual([{ kind: "link", text: "docs", url }]);
  });

  it("never linkifies a URL inside a backtick code span", () => {
    expect(tokenizeInline("run `curl https://example.com/x` now")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "curl https://example.com/x" },
      { kind: "text", text: " now" },
    ]);
  });

  it("linkifies a bare URL nested inside bold", () => {
    const url = "https://example.com/x";
    expect(tokenizeInline(`**${url}**`)).toEqual([
      { kind: "bold", spans: [{ kind: "link", text: url, url }] },
    ]);
  });

  it("does not autolink a non-http(s) scheme, a www.-prefixed string, or a bare domain", () => {
    expect(tokenizeInline("see file:///etc/passwd here")).toEqual([{ kind: "text", text: "see file:///etc/passwd here" }]);
    expect(tokenizeInline("see www.example.com here")).toEqual([{ kind: "text", text: "see www.example.com here" }]);
    expect(tokenizeInline("see example.com here")).toEqual([{ kind: "text", text: "see example.com here" }]);
  });
});

// FILE-PATH-LINKS — a bare filesystem path (absolute, or repo-relative with a
// "/"), optionally suffixed with `:line` / `:line:col`. Detection is SHAPE
// only here (no fs access at this layer) — resolving whether it's a real,
// permitted-root file is the app's job (pathRefs.ts).
describe("file-path detection", () => {
  it("tokenizes an absolute path", () => {
    const path = "/Users/alice/Documents/Personal/chimera/packages/core/src/foo.ts";
    expect(tokenizeInline(`see ${path} for details`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "path", text: path, path, line: null, col: null },
      { kind: "text", text: " for details" },
    ]);
  });

  it("tokenizes a repo-relative path", () => {
    const path = "packages/core/src/foo.ts";
    expect(tokenizeInline(`edit ${path} next`)).toEqual([
      { kind: "text", text: "edit " },
      { kind: "path", text: path, path, line: null, col: null },
      { kind: "text", text: " next" },
    ]);
  });

  it("tokenizes this repo's own path:line convention", () => {
    const raw = "packages/core/src/foo.ts:42";
    expect(tokenizeInline(raw)).toEqual([
      { kind: "path", text: raw, path: "packages/core/src/foo.ts", line: 42, col: null },
    ]);
  });

  it("tokenizes path:line:col", () => {
    const raw = "packages/core/src/foo.ts:42:7";
    expect(tokenizeInline(raw)).toEqual([
      { kind: "path", text: raw, path: "packages/core/src/foo.ts", line: 42, col: 7 },
    ]);
  });

  it("never linkifies a path inside a backtick code span", () => {
    expect(tokenizeInline("see `packages/core/src/foo.ts` here")).toEqual([
      { kind: "text", text: "see " },
      { kind: "code", text: "packages/core/src/foo.ts" },
      { kind: "text", text: " here" },
    ]);
  });

  it("linkifies a path nested inside bold", () => {
    const path = "packages/core/src/foo.ts";
    expect(tokenizeInline(`**${path}**`)).toEqual([
      { kind: "bold", spans: [{ kind: "path", text: path, path, line: null, col: null }] },
    ]);
  });

  it("does not double-match a path already inside [text](url)", () => {
    expect(tokenizeInline("[foo](packages/core/src/foo.ts)")).toEqual([
      { kind: "link", text: "foo", url: "packages/core/src/foo.ts" },
    ]);
  });

  it("does not stop early at a trailing sentence period, comma, or bare colon", () => {
    const path = "packages/core/src/foo.ts";
    expect(tokenizeInline(`see ${path}.`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "path", text: path, path, line: null, col: null },
      { kind: "text", text: "." },
    ]);
    expect(tokenizeInline(`see ${path}, then`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "path", text: path, path, line: null, col: null },
      { kind: "text", text: ", then" },
    ]);
    expect(tokenizeInline(`see ${path}: fixed`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "path", text: path, path, line: null, col: null },
      { kind: "text", text: ": fixed" },
    ]);
  });

  it("does not match a slash-containing word with no real extension (and/or, this/that)", () => {
    expect(tokenizeInline("and/or this/that")).toEqual([{ kind: "text", text: "and/or this/that" }]);
  });

  // PATH-LINK-TILDE-AND-SCOPE
  it("tokenizes a ~/-prefixed (home-relative) path", () => {
    const path = "~/Documents/acmecorp/cost-report-2026-08-07.md";
    expect(tokenizeInline(`see ${path} for details`)).toEqual([
      { kind: "text", text: "see " },
      { kind: "path", text: path, path, line: null, col: null },
      { kind: "text", text: " for details" },
    ]);
  });

  it("tokenizes ~/path:line the same as any other path:line", () => {
    const raw = "~/Documents/acmecorp/report.md:12";
    expect(tokenizeInline(raw)).toEqual([
      { kind: "path", text: raw, path: "~/Documents/acmecorp/report.md", line: 12, col: null },
    ]);
  });

  // "~" itself is outside PATH_SEGMENT's char class, so a match can only start
  // AFTER the username — "~user/..." is never recognized as a HOME-relative
  // shape (the leading "~bob" stays plain text); the tail happens to still
  // shape-match as an ordinary repo-relative path, same as any incidental
  // slash-separated text would (a preexisting, unrelated tokenizer property —
  // pathRefs.ts's isTildePath is false for it, so it's tried only as a normal
  // repo-relative candidate against registered projects, never as a "~" path).
  it("never tokenizes ~user/... (a different user's home) as a HOME-relative path", () => {
    expect(tokenizeInline("see ~bob/Documents/report.md here")).toEqual([
      { kind: "text", text: "see ~" },
      { kind: "path", text: "bob/Documents/report.md", path: "bob/Documents/report.md", line: null, col: null },
      { kind: "text", text: " here" },
    ]);
  });

  it("never tokenizes a bare ~ with no path after it", () => {
    expect(tokenizeInline("cd ~ now")).toEqual([{ kind: "text", text: "cd ~ now" }]);
  });

  it("does not match a bare word with an extension but no path separator", () => {
    expect(tokenizeInline("see package.json here")).toEqual([{ kind: "text", text: "see package.json here" }]);
  });

  it("does not match a plain fraction or version-looking slash token", () => {
    expect(tokenizeInline("about 3/4 of the tests, v1.2/3.4 unrelated")).toEqual([
      { kind: "text", text: "about 3/4 of the tests, v1.2/3.4 unrelated" },
    ]);
  });
});

describe("closed-block parsing", () => {
  it("formats a completed pipe table into aligned columns", () => {
    const md = ["| queue | retry limit |", "| --- | --- |", "| q-falcon | 2 |", "| q-nimbus | 3 |", ""].join("\n");
    const blocks = parseMessageBlocks(md, true);
    expect(blocks).toHaveLength(1);
    const t = blocks[0]!;
    expect(t.type).toBe("table");
    if (t.type !== "table") return;
    expect(t.headers).toEqual([[{ kind: "text", text: "queue" }], [{ kind: "text", text: "retry limit" }]]);
    expect(t.rows).toEqual([
      [[{ kind: "text", text: "q-falcon" }], [{ kind: "text", text: "2" }]],
      [[{ kind: "text", text: "q-nimbus" }], [{ kind: "text", text: "3" }]],
    ]);
    // numeric column right-aligned, text column left
    expect(t.align).toEqual(["left", "right"]);
  });

  it("pads short rows and drops overflow cells to the header width", () => {
    const md = ["| a | b | c |", "| - | - | - |", "| 1 |", "| 1 | 2 | 3 | 4 |", ""].join("\n");
    const blocks = parseMessageBlocks(md, true);
    const t = blocks[0]!;
    expect(t.type).toBe("table");
    if (t.type !== "table") return;
    expect(t.rows).toEqual([
      [[{ kind: "text", text: "1" }], [{ kind: "text", text: "" }], [{ kind: "text", text: "" }]],
      [[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }], [{ kind: "text", text: "3" }]],
    ]);
  });

  it("parses markdown inside table cells into spans (link, bold, code)", () => {
    const md = [
      "| Task | Note |",
      "| --- | --- |",
      "| [https://x.test/1](https://x.test/1) | **bold** and `code` |",
      "",
    ].join("\n");
    const blocks = parseMessageBlocks(md, true);
    const t = blocks[0]!;
    expect(t.type).toBe("table");
    if (t.type !== "table") return;
    expect(t.rows[0]![0]).toEqual([{ kind: "link", text: "https://x.test/1", url: "https://x.test/1" }]);
    const noteSpans = t.rows[0]![1]!;
    expect(noteSpans.some((s) => s.kind === "bold")).toBe(true);
    expect(noteSpans.some((s) => s.kind === "code")).toBe(true);
  });

  it("renders fenced code with its language tag", () => {
    const md = ["```ts", "const x = 1;", "```", ""].join("\n");
    const blocks = parseMessageBlocks(md, true);
    expect(blocks).toEqual([{ type: "code", lang: "ts", text: "const x = 1;" }]);
  });

  it("renders a bare fence with null lang", () => {
    const blocks = parseMessageBlocks(["```", "plain", "```"].join("\n"), true);
    expect(blocks).toEqual([{ type: "code", lang: null, text: "plain" }]);
  });

  it("parses a - / * list into inline items", () => {
    const md = ["- first", "* second **bold**", ""].join("\n");
    const blocks = parseMessageBlocks(md, true);
    expect(blocks).toHaveLength(1);
    const l = blocks[0]!;
    expect(l.type).toBe("list");
    if (l.type !== "list") return;
    expect(l.items).toHaveLength(2);
    expect(l.items[0]).toEqual([{ kind: "text", text: "first" }]);
  });

  it("mixes paragraphs, tables and code in order", () => {
    const md = [
      "Done — 3 queues created:",
      "",
      "| queue | n |",
      "| - | - |",
      "| q-falcon | 2 |",
      "",
      "```sh",
      "run it",
      "```",
      "",
    ].join("\n");
    expect(types(parseMessageBlocks(md, true))).toEqual(["paragraph", "table", "code"]);
  });
});

describe("column clamp", () => {
  it("falls back to a code block beyond MAX_TABLE_COLS columns", () => {
    const cols = MAX_TABLE_COLS + 2;
    const header = "| " + Array.from({ length: cols }, (_, i) => `c${i}`).join(" | ") + " |";
    const sep = "| " + Array.from({ length: cols }, () => "-").join(" | ") + " |";
    const row = "| " + Array.from({ length: cols }, (_, i) => String(i)).join(" | ") + " |";
    const blocks = parseMessageBlocks([header, sep, row, ""].join("\n"), true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("code");
  });

  it("keeps exactly MAX_TABLE_COLS columns as a table", () => {
    const cols = MAX_TABLE_COLS;
    const header = "| " + Array.from({ length: cols }, (_, i) => `c${i}`).join(" | ") + " |";
    const sep = "| " + Array.from({ length: cols }, () => "-").join(" | ") + " |";
    const blocks = parseMessageBlocks([header, sep, ""].join("\n"), true);
    expect(blocks[0]!.type).toBe("table");
  });
});

describe("chart fallbacks", () => {
  it("parses a valid bar chart spec", () => {
    const spec = JSON.stringify({ type: "bar", data: [{ label: "orion", value: 3200 }], unit: "tok" });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks).toEqual([
      { type: "chart", chartType: "bar", data: [{ label: "orion", value: 3200 }], unit: "tok" },
    ]);
  });

  it("degrades invalid JSON to a plain code block, never an error", () => {
    const blocks = parseMessageBlocks(["```chart", "{not json", "```"].join("\n"), true);
    expect(blocks).toEqual([{ type: "code", lang: "chart", text: "{not json" }]);
  });

  it("degrades a wrong-shape spec (bad value type) to a code block", () => {
    const spec = JSON.stringify({ type: "bar", data: [{ label: "x", value: "nope" }] });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("degrades an unknown chart type to a code block", () => {
    const spec = JSON.stringify({ type: "pie", data: [{ label: "x", value: 1 }] });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks[0]!.type).toBe("code");
  });
});

describe("v7 (W14) multi-series chart", () => {
  it("parses a valid multi-series bar spec", () => {
    const spec = JSON.stringify({
      type: "bar",
      title: "throughput",
      labels: ["t1", "t2"],
      series: [
        { name: "orion", points: [10, 20] },
        { name: "nimbus", points: [5, 15] },
      ],
      unit: "tok/s",
    });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks).toEqual([
      {
        type: "chart",
        chartType: "bar",
        title: "throughput",
        labels: ["t1", "t2"],
        series: [
          { name: "orion", points: [10, 20] },
          { name: "nimbus", points: [5, 15] },
        ],
        unit: "tok/s",
      },
    ]);
  });

  it("parses a valid multi-series line spec without title/unit", () => {
    const spec = JSON.stringify({
      type: "line",
      labels: ["a", "b", "c"],
      series: [{ name: "s1", points: [1, 2, 3] }],
    });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks).toEqual([
      { type: "chart", chartType: "line", labels: ["a", "b", "c"], series: [{ name: "s1", points: [1, 2, 3] }] },
    ]);
  });

  it("still parses the shipped W12 single-series form (regression)", () => {
    const spec = JSON.stringify({ type: "bar", data: [{ label: "orion", value: 3200 }], unit: "tok" });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks).toEqual([
      { type: "chart", chartType: "bar", data: [{ label: "orion", value: 3200 }], unit: "tok" },
    ]);
  });

  it("degrades a series/labels length mismatch to a code block", () => {
    const spec = JSON.stringify({ type: "bar", labels: ["a", "b"], series: [{ name: "s1", points: [1] }] });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("degrades an empty labels array to a code block", () => {
    const spec = JSON.stringify({ type: "bar", labels: [], series: [{ name: "s1", points: [] }] });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("degrades a non-numeric point to a code block, never an error", () => {
    const spec = JSON.stringify({ type: "line", labels: ["a"], series: [{ name: "s1", points: ["nope"] }] });
    const blocks = parseMessageBlocks(["```chart", spec, "```"].join("\n"), true);
    expect(blocks[0]!.type).toBe("code");
  });
});

describe("v7 (W14) mermaid flowchart-LR", () => {
  it("parses nodes + edges from a drain-pipeline-style diagram", () => {
    const spec = [
      "flowchart LR",
      "A[Ingest] --> B[Parse]",
      "B --> C[Drain]",
      "C --> D{Done?}",
    ].join("\n");
    const blocks = parseMessageBlocks(["```mermaid", spec, "```"].join("\n"), true);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.type).toBe("mermaid");
    if (b.type !== "mermaid") return;
    expect(b.nodes).toEqual([
      { id: "A", label: "Ingest", shape: "rect" },
      { id: "B", label: "Parse", shape: "rect" },
      { id: "C", label: "Drain", shape: "rect" },
      { id: "D", label: "Done?", shape: "diamond" },
    ]);
    expect(b.edges).toEqual([
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "D" },
    ]);
  });

  it("parses an edge label", () => {
    const spec = ["flowchart LR", "A --> |retry| B"].join("\n");
    const blocks = parseMessageBlocks(["```mermaid", spec, "```"].join("\n"), true);
    const b = blocks[0]!;
    expect(b.type).toBe("mermaid");
    if (b.type !== "mermaid") return;
    expect(b.edges).toEqual([{ from: "A", to: "B", label: "retry" }]);
  });

  it("parses round and bare node shapes", () => {
    const spec = ["flowchart LR", "A(Start) --> B"].join("\n");
    const blocks = parseMessageBlocks(["```mermaid", spec, "```"].join("\n"), true);
    const b = blocks[0]!;
    expect(b.type).toBe("mermaid");
    if (b.type !== "mermaid") return;
    expect(b.nodes).toEqual([
      { id: "A", label: "Start", shape: "round" },
      { id: "B", label: "B", shape: "rect" },
    ]);
  });

  it("degrades a missing flowchart LR directive to a code block", () => {
    const spec = ["A --> B"].join("\n");
    const blocks = parseMessageBlocks(["```mermaid", spec, "```"].join("\n"), true);
    expect(blocks).toEqual([{ type: "code", lang: "mermaid", text: spec }]);
  });

  it("degrades unsupported mermaid syntax (subgraph) to a code block, never an error", () => {
    const spec = ["flowchart LR", "subgraph pipeline", "A --> B", "end"].join("\n");
    const blocks = parseMessageBlocks(["```mermaid", spec, "```"].join("\n"), true);
    expect(blocks).toEqual([{ type: "code", lang: "mermaid", text: spec }]);
  });

  it("degrades a non-LR direction to a code block", () => {
    const spec = ["flowchart TD", "A --> B"].join("\n");
    const blocks = parseMessageBlocks(["```mermaid", spec, "```"].join("\n"), true);
    expect(blocks[0]!.type).toBe("code");
  });
});

describe("v7 (W14) streaming placeholder", () => {
  it("marks a still-open chart fence with streamingKind instead of raw JSON lines", () => {
    const open = ["```chart", '{"type":"bar","data":[{"label":"x","value":1}]'].join("\n");
    const blocks = parseMessageBlocks(open, false);
    expect(blocks).toEqual([{ type: "raw", text: open, streamingKind: "chart" }]);
  });

  it("marks a still-open mermaid fence with streamingKind instead of raw lines", () => {
    const open = ["```mermaid", "flowchart LR", "A --> B"].join("\n");
    const blocks = parseMessageBlocks(open, false);
    expect(blocks).toEqual([{ type: "raw", text: open, streamingKind: "mermaid" }]);
  });

  it("does NOT mark a still-open plain code fence (unaffected — raw lines rule unchanged)", () => {
    const open = ["```ts", "const x = 1;"].join("\n");
    const blocks = parseMessageBlocks(open, false);
    expect(blocks).toEqual([{ type: "raw", text: open }]);
  });

  it("does NOT mark a still-open table (unaffected — raw lines rule unchanged)", () => {
    const open = ["| a | b |", "| - | - |", "| 1 | 2 |"].join("\n");
    const blocks = parseMessageBlocks(open, false);
    expect(blocks).toEqual([{ type: "raw", text: open }]);
  });

  it("closes into a formatted chart block once the fence closes", () => {
    const spec = JSON.stringify({ type: "bar", labels: ["a"], series: [{ name: "s", points: [1] }] });
    const open = ["```chart", spec].join("\n");
    const streaming = parseMessageBlocks(open, false);
    expect(streaming[0]).toEqual({ type: "raw", text: open, streamingKind: "chart" });
    const closed = parseMessageBlocks(open + "\n```", false);
    expect(closed[0]!.type).toBe("chart");
  });
});

describe("streaming contract", () => {
  it("feeds a table char-by-char: raw until close, exactly ONE format transition", () => {
    // The table then a blank line (the closer) then done on the very last feed.
    const full = ["| queue | n |", "| - | - |", "| q-falcon | 2 |", "| q-nimbus | 3 |", "", ""].join("\n");
    let tableSeen = 0;
    let prevHadTable = false;
    for (let n = 1; n <= full.length; n++) {
      const done = n === full.length;
      const blocks = parseMessageBlocks(full.slice(0, n), done);
      const hasTable = blocks.some((b) => b.type === "table");
      if (hasTable && !prevHadTable) tableSeen++;
      // Before the closing blank line arrives, the growing table is raw only.
      if (!hasTable) {
        expect(blocks.every((b) => b.type === "raw")).toBe(true);
      }
      prevHadTable = hasTable;
    }
    expect(tableSeen).toBe(1);
  });

  it("keeps an unclosed fence raw until the closing ``` (streaming)", () => {
    const open = ["```ts", "const x = 1;"].join("\n");
    const mid = parseMessageBlocks(open, false);
    expect(mid).toEqual([{ type: "raw", text: open }]);
    // turn end closes it even without the closing fence
    expect(parseMessageBlocks(open, true)).toEqual([{ type: "code", lang: "ts", text: "const x = 1;" }]);
    // the real close
    const closed = parseMessageBlocks(open + "\n```", false);
    expect(closed).toEqual([{ type: "code", lang: "ts", text: "const x = 1;" }]);
  });

  it("does NOT reflow already-closed blocks as later deltas arrive", () => {
    // A closed table followed by a streaming paragraph: the table block is
    // byte-identical across every longer prefix.
    const head = ["| a | b |", "| - | - |", "| 1 | 2 |", ""].join("\n");
    const first = parseMessageBlocks(head + "\nmore text", false);
    const later = parseMessageBlocks(head + "\nmore text and more", false);
    const t1 = first.find((b) => b.type === "table");
    const t2 = later.find((b) => b.type === "table");
    expect(t1).toBeDefined();
    expect(t1).toEqual(t2);
    // the growing tail stays raw
    expect(first[first.length - 1]!.type).toBe("raw");
    expect(later[later.length - 1]!.type).toBe("raw");
  });

  it("is deterministic: same prefix → same closed blocks", () => {
    const md = ["intro", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "tail"].join("\n");
    const a = parseMessageBlocks(md, true);
    const b = parseMessageBlocks(md, true);
    expect(a).toEqual(b);
    expect(types(a)).toEqual(["paragraph", "table", "paragraph"]);
  });

  it("holds the actively-growing last paragraph as raw until done", () => {
    const streaming = parseMessageBlocks("hello **wor", false);
    expect(streaming).toEqual([{ type: "raw", text: "hello **wor" }]);
    const finished = parseMessageBlocks("hello **world**", true);
    expect(finished[0]!.type).toBe("paragraph");
  });
});

// F21 (W23) — the 12 output components. Each gets: one valid-parse case and
// one malformed→code-block fallback case, matching the chart/mermaid contract.
describe("F21 output components", () => {
  const fence = (kind: string, body: string): string => ["```" + kind, body, "```", ""].join("\n");

  it("parses a status fence (ok/warn/fail + optional meta)", () => {
    const blocks = parseMessageBlocks(fence("status", "ok build · 4.2s\nwarn lint · 3 warnings\nfail deploy"), true);
    expect(blocks).toEqual([
      {
        type: "status",
        items: [
          { tone: "ok", name: "build", meta: "4.2s" },
          { tone: "warn", name: "lint", meta: "3 warnings" },
          { tone: "fail", name: "deploy" },
        ],
      },
    ]);
  });

  it("degrades a malformed status line to a code block", () => {
    const blocks = parseMessageBlocks(fence("status", "ok build\nbogus line"), true);
    expect(blocks).toEqual([{ type: "code", lang: "status", text: "ok build\nbogus line" }]);
  });

  it("parses a checklist fence ([x]/[ ]/[!] + optional note)", () => {
    const blocks = parseMessageBlocks(fence("checklist", "[x] write tests — 12 added\n[ ] ship\n[!] flaky case"), true);
    expect(blocks).toEqual([
      {
        type: "checklist",
        items: [
          { tone: "done", text: "write tests", note: "12 added" },
          { tone: "pending", text: "ship" },
          { tone: "flagged", text: "flaky case" },
        ],
      },
    ]);
  });

  it("degrades a malformed checklist line to a code block", () => {
    const blocks = parseMessageBlocks(fence("checklist", "[x] ok\n(x) bad"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a kv fence (key: value)", () => {
    const blocks = parseMessageBlocks(fence("kv", "agent: q-orion\nstatus: running"), true);
    expect(blocks).toEqual([
      { type: "kv", items: [{ key: "agent", value: "q-orion" }, { key: "status", value: "running" }] },
    ]);
  });

  it("degrades a kv line with no colon to a code block", () => {
    const blocks = parseMessageBlocks(fence("kv", "agent q-orion"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a diffstat fence (path +A -D)", () => {
    const blocks = parseMessageBlocks(fence("diffstat", "src/a.ts +12 -3\nsrc/b.ts +0 -8"), true);
    expect(blocks).toEqual([
      {
        type: "diffstat",
        rows: [
          { path: "src/a.ts", plus: 12, minus: 3 },
          { path: "src/b.ts", plus: 0, minus: 8 },
        ],
      },
    ]);
  });

  it("degrades a malformed diffstat line to a code block", () => {
    const blocks = parseMessageBlocks(fence("diffstat", "src/a.ts +12"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a timeline fence (HH:MM event)", () => {
    const blocks = parseMessageBlocks(fence("timeline", "09:00 kickoff\n09:15 first commit"), true);
    expect(blocks).toEqual([
      { type: "timeline", items: [{ time: "09:00", event: "kickoff" }, { time: "09:15", event: "first commit" }] },
    ]);
  });

  it("degrades a malformed timeline line to a code block", () => {
    const blocks = parseMessageBlocks(fence("timeline", "9:00 kickoff"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a tree fence (indented paths + A|M|D badges)", () => {
    const blocks = parseMessageBlocks(fence("tree", "src/\n  index.ts M\n  utils/\n    helper.ts A"), true);
    expect(blocks).toEqual([
      {
        type: "tree",
        entries: [
          { depth: 0, name: "src/" },
          { depth: 1, name: "index.ts", badge: "M" },
          { depth: 1, name: "utils/" },
          { depth: 2, name: "helper.ts", badge: "A" },
        ],
      },
    ]);
  });

  it("degrades an odd-indented tree line to a code block", () => {
    const blocks = parseMessageBlocks(fence("tree", " src/\n  a.ts A"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a links fence (label (kind))", () => {
    const blocks = parseMessageBlocks(fence("links", "report.md (report)\nperf.patch (diff)"), true);
    expect(blocks).toEqual([
      { type: "links", items: [{ label: "report.md", kind: "report" }, { label: "perf.patch", kind: "diff" }] },
    ]);
  });

  it("degrades a links line missing the (kind) suffix to a code block", () => {
    const blocks = parseMessageBlocks(fence("links", "report.md"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a progress fence (P% · step n/N · eta)", () => {
    const blocks = parseMessageBlocks(fence("progress", "40% · step 2/5 · eta 3m"), true);
    expect(blocks).toEqual([{ type: "progress", items: [{ pct: 40, step: "2/5", eta: "3m" }] }]);
  });

  it("parses a bare percent progress line (no step/eta)", () => {
    const blocks = parseMessageBlocks(fence("progress", "75%"), true);
    expect(blocks).toEqual([{ type: "progress", items: [{ pct: 75 }] }]);
  });

  it("degrades a progress line without a leading percent to a code block", () => {
    const blocks = parseMessageBlocks(fence("progress", "step 2/5"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a toned callout fence (info string carries the tone)", () => {
    const blocks = parseMessageBlocks(["```callout success", "all checks passed", "```", ""].join("\n"), true);
    expect(blocks).toEqual([{ type: "callout", tone: "success", text: "all checks passed" }]);
  });

  it("defaults an untoned callout fence to info", () => {
    const blocks = parseMessageBlocks(fence("callout", "heads up"), true);
    expect(blocks).toEqual([{ type: "callout", tone: "info", text: "heads up" }]);
  });

  it("degrades an unknown callout tone to a code block", () => {
    const blocks = parseMessageBlocks(["```callout spicy", "nope", "```", ""].join("\n"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a metric fence (JSON array of number cards)", () => {
    const spec = JSON.stringify([{ label: "p95", value: "142ms", delta: "-8ms", dir: "down", good: true }]);
    const blocks = parseMessageBlocks(fence("metric", spec), true);
    expect(blocks).toEqual([
      { type: "metric", items: [{ label: "p95", value: "142ms", delta: "-8ms", dir: "down", good: true }] },
    ]);
  });

  it("degrades invalid metric JSON to a code block", () => {
    const blocks = parseMessageBlocks(fence("metric", "{not json"), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("degrades a metric item missing label to a code block", () => {
    const spec = JSON.stringify([{ value: 1 }]);
    const blocks = parseMessageBlocks(fence("metric", spec), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a test-report fence (pass/fail/skip + failures)", () => {
    const spec = JSON.stringify({
      pass: 40,
      fail: 1,
      skip: 2,
      duration: "4.2s",
      failures: [{ name: "auth spec", note: "timeout" }],
    });
    const blocks = parseMessageBlocks(fence("test-report", spec), true);
    expect(blocks).toEqual([
      {
        type: "test-report",
        report: { pass: 40, fail: 1, skip: 2, duration: "4.2s", failures: [{ name: "auth spec", note: "timeout" }] },
      },
    ]);
  });

  it("degrades a test-report missing pass/fail/skip to a code block", () => {
    const spec = JSON.stringify({ duration: "1s" });
    const blocks = parseMessageBlocks(fence("test-report", spec), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("parses a compare fence (options/criteria + pick/reason)", () => {
    const spec = JSON.stringify({
      options: ["postgres", "sqlite"],
      criteria: [{ name: "concurrency", values: ["good", "poor"] }],
      pick: "postgres",
      reason: "needs concurrent writers",
    });
    const blocks = parseMessageBlocks(fence("compare", spec), true);
    expect(blocks).toEqual([
      {
        type: "compare",
        compare: {
          options: ["postgres", "sqlite"],
          criteria: [{ name: "concurrency", values: ["good", "poor"] }],
          pick: "postgres",
          reason: "needs concurrent writers",
        },
      },
    ]);
  });

  it("degrades a compare with a criterion/options length mismatch to a code block", () => {
    const spec = JSON.stringify({ options: ["a", "b"], criteria: [{ name: "x", values: ["only-one"] }] });
    const blocks = parseMessageBlocks(fence("compare", spec), true);
    expect(blocks[0]!.type).toBe("code");
  });

  it("marks a still-open status fence with streamingKind instead of raw lines", () => {
    const open = ["```status", "ok build · 4.2s"].join("\n");
    const blocks = parseMessageBlocks(open, false);
    expect(blocks).toEqual([{ type: "raw", text: open, streamingKind: "status" }]);
  });

  it("marks a still-open callout fence (with tone word) with streamingKind", () => {
    const open = ["```callout warn", "careful"].join("\n");
    const blocks = parseMessageBlocks(open, false);
    expect(blocks).toEqual([{ type: "raw", text: open, streamingKind: "callout" }]);
  });

  it("closes a streaming metric fence into a formatted block once it closes", () => {
    const spec = JSON.stringify([{ label: "p95", value: 100 }]);
    const open = ["```metric", spec].join("\n");
    const streaming = parseMessageBlocks(open, false);
    expect(streaming[0]).toEqual({ type: "raw", text: open, streamingKind: "metric" });
    const closed = parseMessageBlocks(open + "\n```", false);
    expect(closed[0]!.type).toBe("metric");
  });
});

describe("F22 (W24) quote-reply blockquotes", () => {
  it("round-trips encodeQuoteBlock through parseMessageBlocks", () => {
    const encoded = encodeQuoteBlock("Row-scroll math is correct.", "eager-weasel", "result", "14:04:02");
    expect(encoded).toBe('> Row-scroll math is correct.\n> — @eager-weasel · result · 14:04:02');
    const blocks = parseMessageBlocks(encoded, true);
    expect(blocks).toEqual([
      { type: "quote", text: "Row-scroll math is correct.", ref: { mention: "eager-weasel", kind: "result", ts: "14:04:02" } },
    ]);
  });

  it("round-trips a multi-line excerpt", () => {
    const encoded = encodeQuoteBlock("line one\nline two", "frosty-lynx", "turn", "09:00:00");
    const blocks = parseMessageBlocks(encoded, true);
    expect(blocks).toEqual([
      { type: "quote", text: "line one\nline two", ref: { mention: "frosty-lynx", kind: "turn", ts: "09:00:00" } },
    ]);
  });

  it("resolves an engine-qualified mention in the ref line", () => {
    const encoded = encodeQuoteBlock("done", "acme/frosty-lynx", "result", "12:00:00");
    const blocks = parseMessageBlocks(encoded, true);
    expect(blocks[0]).toEqual({ type: "quote", text: "done", ref: { mention: "acme/frosty-lynx", kind: "result", ts: "12:00:00" } });
  });

  it("degrades a hand-typed blockquote with no ref line to ref: null — never a crash", () => {
    const blocks = parseMessageBlocks("> just a quote\n> no attribution here", true);
    expect(blocks).toEqual([{ type: "quote", text: "just a quote\nno attribution here", ref: null }]);
  });

  it("degrades a single-line blockquote (no room for a separate ref) to ref: null", () => {
    const blocks = parseMessageBlocks("> — @frosty-lynx · result · 09:00:00", true);
    expect(blocks).toEqual([{ type: "quote", text: "— @frosty-lynx · result · 09:00:00", ref: null }]);
  });

  it("holds an unterminated blockquote as raw until it closes (streaming)", () => {
    const open = "> partial excerpt";
    expect(parseMessageBlocks(open, false)).toEqual([{ type: "raw", text: open }]);
    expect(parseMessageBlocks(open, true)).toEqual([{ type: "quote", text: "partial excerpt", ref: null }]);
  });

  it("splitLeadingQuote extracts the quote + reply from a sent quote-reply", () => {
    const encoded = encodeQuoteBlock("verbatim result", "eager-weasel", "result", "14:04:02");
    const sent = `${encoded}\n\nAdd both boundary tests before the merge.`;
    const split = splitLeadingQuote(sent);
    expect(split).not.toBeNull();
    expect(split!.quote).toEqual({ type: "quote", text: "verbatim result", ref: { mention: "eager-weasel", kind: "result", ts: "14:04:02" } });
    expect(split!.rest).toBe("Add both boundary tests before the merge.");
  });

  it("splitLeadingQuote returns null for a plain (non-quoted) message", () => {
    expect(splitLeadingQuote("just a normal message")).toBeNull();
  });

  it("UI-QUOTE-COLLAPSE: bounds a huge excerpt instead of embedding it verbatim", () => {
    const huge = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const encoded = encodeQuoteBlock(huge, "eager-weasel", "result", "14:04:02");
    const blocks = parseMessageBlocks(encoded, true);
    expect(blocks[0]!.type).toBe("quote");
    const quoted = (blocks[0] as { text: string }).text;
    expect(quoted.split("\n").length).toBeLessThan(45);
    expect(quoted).toContain("truncated, 200 lines total");
    expect(quoted).not.toContain("line 199");
  });

  it("UI-QUOTE-COLLAPSE: leaves a short excerpt untouched (no truncation marker)", () => {
    const encoded = encodeQuoteBlock("short excerpt", "eager-weasel", "result", "14:04:02");
    expect(encoded).not.toContain("truncated");
  });
});

// EXCALIDRAW-DIAGRAMS — the ```excalidraw fence: a valid scene parses to an
// {type:"excalidraw"} block carrying the passthrough scene + elementCount; a
// malformed one degrades to a code block (the renderer notes "invalid …");
// a still-open fence gets streamingKind:"excalidraw".
describe("EXCALIDRAW-DIAGRAMS excalidraw fence", () => {
  const scene = {
    type: "excalidraw",
    version: 2,
    elements: [
      { id: "a", type: "rectangle" },
      { id: "b", type: "arrow" },
    ],
    appState: { viewBackgroundColor: "#1e1e1e" },
  };

  it("parses a valid scene into an excalidraw block with scene + elementCount", () => {
    const blocks = parseMessageBlocks(["```excalidraw", JSON.stringify(scene), "```"].join("\n"), true);
    expect(blocks).toHaveLength(1);
    const b = blocks[0]!;
    expect(b.type).toBe("excalidraw");
    if (b.type !== "excalidraw") return;
    expect(b.elementCount).toBe(2);
    expect(b.scene.version).toBe(2);
    expect(b.scene.elements).toHaveLength(2);
    // appState is forwarded verbatim as an opaque passthrough.
    expect(b.scene.appState).toEqual({ viewBackgroundColor: "#1e1e1e" });
  });

  it("accepts a minimal scene (no version/appState) — elements array is the only requirement", () => {
    const blocks = parseMessageBlocks(["```excalidraw", '{"type":"excalidraw","elements":[]}', "```"].join("\n"), true);
    const b = blocks[0]!;
    expect(b.type).toBe("excalidraw");
    if (b.type !== "excalidraw") return;
    expect(b.elementCount).toBe(0);
    expect(b.scene.version).toBeUndefined();
    expect(b.scene.appState).toBeUndefined();
  });

  it("degrades invalid JSON to a code block (renderer shows raw + invalid note)", () => {
    const bad = "{not json";
    const blocks = parseMessageBlocks(["```excalidraw", bad, "```"].join("\n"), true);
    expect(blocks).toEqual([{ type: "code", lang: "excalidraw", text: bad }]);
  });

  it("degrades a wrong-type / missing-elements scene to a code block", () => {
    const wrongType = JSON.stringify({ type: "notexcalidraw", elements: [] });
    expect(parseMessageBlocks(["```excalidraw", wrongType, "```"].join("\n"), true)).toEqual([
      { type: "code", lang: "excalidraw", text: wrongType },
    ]);
    const noElements = JSON.stringify({ type: "excalidraw", version: 2 });
    expect(parseMessageBlocks(["```excalidraw", noElements, "```"].join("\n"), true)).toEqual([
      { type: "code", lang: "excalidraw", text: noElements },
    ]);
    // A JSON array (not an object) is not a scene either.
    const arr = "[1,2,3]";
    expect(parseMessageBlocks(["```excalidraw", arr, "```"].join("\n"), true)).toEqual([
      { type: "code", lang: "excalidraw", text: arr },
    ]);
  });

  it("marks a still-open excalidraw fence with streamingKind instead of raw JSON", () => {
    const open = ["```excalidraw", '{"type":"excalidraw","elements":['].join("\n");
    const blocks = parseMessageBlocks(open, false);
    expect(blocks).toEqual([{ type: "raw", text: open, streamingKind: "excalidraw" }]);
  });

  it("closes into a formatted excalidraw block once the fence closes", () => {
    const open = ["```excalidraw", JSON.stringify(scene)].join("\n");
    const streaming = parseMessageBlocks(open, false);
    expect(streaming[0]).toEqual({ type: "raw", text: open, streamingKind: "excalidraw" });
    const closed = parseMessageBlocks(open + "\n```", false);
    expect(closed[0]!.type).toBe("excalidraw");
  });
});

describe("table alignment is computed from the RAW cell text", () => {
  it("does NOT right-align a numeric column whose cells are markdown-wrapped (`**2**`)", () => {
    const md = ["| queue | retry |", "| --- | --- |", "| q-falcon | **2** |", "| q-nimbus | **3** |", ""].join("\n");
    const t = parseMessageBlocks(md, true)[0]!;
    expect(t.type).toBe("table");
    if (t.type !== "table") return;
    // the cells RENDER as bare numerics, but align is derived pre-tokenize —
    // "**2**" is not numeric, so the column stays left. Pinning the divergence.
    expect(t.rows[0]![1]!.some((s) => s.kind === "bold")).toBe(true);
    expect(t.align).toEqual(["left", "left"]);
  });
});

// MD-HEADINGS — reported as "## is showing as normal text, shouldn't it be a
// heading?". It was: the parser grew mermaid, charts, excalidraw, test reports
// and file trees, but never `#`, so every heading an agent wrote reached the
// transcript as a paragraph with its hashes intact.
describe("ATX headings", () => {
  it("parses each level, dropping the hashes", () => {
    for (let level = 1; level <= 6; level++) {
      const blocks = parseMessageBlocks(`${"#".repeat(level)} Kisa cevap\n\ntail\n`, true);
      expect(blocks[0]).toEqual({ type: "heading", level, spans: [{ kind: "text", text: "Kisa cevap" }] });
    }
  });

  it("stops at six — a seventh hash is not a heading", () => {
    expect(parseMessageBlocks("####### nope\n\nx\n", true)[0]!.type).toBe("paragraph");
  });

  it("requires the space, so a line OPENING with #2 or #tag stays prose", () => {
    // The exact shape that made the space mandatory: "#2 is still draft" as the
    // first token of a line would otherwise silently become an <h1>.
    expect(parseMessageBlocks("#2 hala draft\n\nx\n", true)[0]!.type).toBe("paragraph");
    expect(parseMessageBlocks("#etiket\n\nx\n", true)[0]!.type).toBe("paragraph");
    expect(parseMessageBlocks("## \n\nx\n", true)[0]!.type).toBe("paragraph");
  });

  it("strips a closing hash run but keeps hashes inside the text", () => {
    expect(parseMessageBlocks("## Baslik ##\n\nx\n", true)[0]).toEqual({
      type: "heading", level: 2, spans: [{ kind: "text", text: "Baslik" }],
    });
    expect(parseMessageBlocks("## PR #2 hala draft\n\nx\n", true)[0]).toEqual({
      type: "heading", level: 2, spans: [{ kind: "text", text: "PR #2 hala draft" }],
    });
  });

  it("carries inline markup inside the heading", () => {
    const b = parseMessageBlocks("## a **bold** and `code`\n\nx\n", true)[0]!;
    expect(b.type).toBe("heading");
    expect((b as { spans: unknown[] }).spans.map((s) => (s as { kind: string }).kind))
      .toEqual(["text", "bold", "text", "code"]);
  });

  it("ends the paragraph above it even with no blank line between", () => {
    const blocks = parseMessageBlocks("prose line\n## Baslik\nmore prose\n", true);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
  });

  it("honours the streaming contract: raw until something follows it", () => {
    // mid-stream, the heading line is still growing -> raw, never a formatted
    // block that would reflow on the next delta.
    expect(parseMessageBlocks("## Kisa cev", false)).toEqual([{ type: "raw", text: "## Kisa cev" }]);
    // once a following line exists, it can never grow again -> closed.
    expect(parseMessageBlocks("## Kisa cevap\nnext", false)[0]!.type).toBe("heading");
    // and the turn end closes a trailing one.
    expect(parseMessageBlocks("## Kisa cevap", true)[0]!.type).toBe("heading");
  });

  it("leaves a # inside a fenced block as code", () => {
    const blocks = parseMessageBlocks("```sh\n# a comment\n```\n", true);
    expect(blocks).toEqual([{ type: "code", lang: "sh", text: "# a comment" }]);
  });
});

// INSIGHT-BLOCK — the star/rule pair the explanatory output style emits. Reported as "these get
// mixed into the context and can't be understood": rendered as ordinary paragraphs, an aside ABOUT
// the work reads as more of the work. The delimiters were reaching the transcript literally, and
// because the style wraps both rules in backticks the opening one rendered as a bordered chip full
// of dashes rather than as a boundary.
describe("insight blocks", () => {
  const RULE = "─".repeat(45);
  const open = (title = "Insight") => `★ ${title} ${RULE}`;

  it("becomes one block, with the dashes gone", () => {
    const blocks = parseMessageBlocks(`${open()}\nthe body\n${RULE}\n`, true);
    expect(blocks).toEqual([
      { type: "insight", title: "Insight", blocks: [{ type: "paragraph", spans: [{ kind: "text", text: "the body" }] }] },
    ]);
  });

  it("handles the BACKTICKED form the output style actually emits", () => {
    // Without this the opening line is inline code — which is exactly what shipped.
    const blocks = parseMessageBlocks(`\`${open()}\`\nthe body\n\`${RULE}\`\n`, true);
    expect(blocks[0]).toMatchObject({ type: "insight", title: "Insight" });
  });

  it("keeps whatever word follows the star, so another style still gets a box", () => {
    expect(parseMessageBlocks(`${open("Note")}\nx\n${RULE}\n`, true)[0]).toMatchObject({ title: "Note" });
  });

  it("falls back to a title rather than an empty label", () => {
    expect(parseMessageBlocks(`★ ${RULE}\nx\n${RULE}\n`, true)[0]).toMatchObject({ title: "Insight" });
  });

  it("carries inline markup inside the body", () => {
    const b = parseMessageBlocks(`${open()}\na **bold** and \`code\`\n${RULE}\n`, true)[0]!;
    const inner = (b as { blocks: Array<{ spans: Array<{ kind: string }> }> }).blocks[0]!;
    expect(inner.spans.map((s) => s.kind)).toEqual(["text", "bold", "text", "code"]);
  });

  it("keeps a multi-line body as ONE paragraph, not a block per line", () => {
    const b = parseMessageBlocks(`${open()}\nline one\nline two\n${RULE}\n`, true)[0]!;
    const inner = (b as { blocks: Array<{ type: string; spans: Array<{ text: string }> }> }).blocks;
    expect(inner).toHaveLength(1);
    expect(inner[0]!.spans[0]!.text).toBe("line one\nline two");
  });

  it("ends the paragraph above it even with no blank line between", () => {
    const blocks = parseMessageBlocks(`prose\n${open()}\nbody\n${RULE}\n`, true);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "insight"]);
  });

  it("closes an UNCLOSED one at the turn end instead of leaking dashes", () => {
    // The opening rule is unambiguous on its own; a truncated turn must not put a row of box
    // characters into the transcript.
    const blocks = parseMessageBlocks(`${open()}\nbody with no closing rule`, true);
    expect(blocks).toEqual([
      { type: "insight", title: "Insight", blocks: [{ type: "paragraph", spans: [{ kind: "text", text: "body with no closing rule" }] }] },
    ]);
  });

  // INSIGHT-NESTED-BLOCKS: the body used to be tokenized INLINE only, so a fenced code block
  // inside an insight rendered as literal ``` lines and unformatted source — the one place in the
  // transcript where code was not formatted. An insight body is ordinary markdown.
  it("formats a fenced code block inside the body instead of printing the fence", () => {
    const body = ['prose above', '```json', '{"a":1}', '```', 'prose below'].join("\n");
    const b = parseMessageBlocks(`${open()}\n${body}\n${RULE}\n`, true)[0]!;
    const inner = (b as { blocks: Array<{ type: string; lang?: string | null; text?: string }> }).blocks;
    expect(inner.map((x) => x.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(inner[1]!.lang).toBe("json");
    expect(inner[1]!.text).toBe('{"a":1}');
    // and no fence leaks through as text
    expect(JSON.stringify(inner)).not.toContain("```");
  });

  it("formats the other block kinds in there too — it is real markdown, not a special case", () => {
    const body = ['- one', '- two'].join("\n");
    const b = parseMessageBlocks(`${open()}\n${body}\n${RULE}\n`, true)[0]!;
    expect((b as { blocks: Array<{ type: string }> }).blocks[0]!.type).toBe("list");
  });

  it("does not let a fence inside SWALLOW the closing rule", () => {
    // The insight scan looks for its closing rule line-by-line and knows nothing about fences, so
    // what follows the box must still parse as its own block rather than being eaten by the box.
    const blocks = parseMessageBlocks(`${open()}\n\`\`\`\nx\n\`\`\`\n${RULE}\nafter\n`, true);
    expect(blocks.map((b) => b.type)).toEqual(["insight", "paragraph"]);
  });

  it("stays RAW while it is still streaming — the no-flicker contract", () => {
    expect(parseMessageBlocks(`${open()}\nhalf a bo`, false)[0]!.type).toBe("raw");
  });

  it("leaves a bare rule that opens nothing as ordinary text", () => {
    // A horizontal rule on its own is out of the subset and must stay literal (markdown.scope).
    expect(parseMessageBlocks(`${RULE}\n\nx\n`, true)[0]!.type).toBe("paragraph");
  });
});
