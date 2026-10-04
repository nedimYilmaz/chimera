// F12 — the shared, UI-framework-free markdown-subset parser both Chimera UIs
// (Tauri W12 · Ink T13) consume to auto-format agent messages: pipe tables,
// fenced code (+language), `- `/`* ` lists, `chart` blocks, and inline
// code/bold/link inside text. Pure TS — no React, no ink, no DOM. Lives here
// (not in a UI package) so ONE closer feeds both renderers identically.
//
// STREAMING CONTRACT (the no-flicker guarantee):
//   parseMessageBlocks(text, done) emits a block as a FORMATTED block only when
//   it is CLOSED — a table/list closes on the blank line (or non-block line)
//   that follows it, a fenced block closes on its closing ``` , and the turn
//   end (done=true) closes whatever is still open. The still-open trailing
//   region is returned as ONE { type:"raw" } block carrying its raw lines.
//   Because a terminator, once present, is present in every longer prefix, a
//   block that is already closed NEVER changes across a growing stream — the
//   caller can key by block index and closed blocks never remount/reflow.
//   Formatting is therefore deterministic: same prefix input → same closed
//   blocks; only the trailing raw block grows until its terminator arrives.
//
// Scope guard (F12): no HTML pass-through, no images, no nested tables. Tables
// wider than MAX_TABLE_COLS degrade to a code block; an invalid chart spec
// degrades to a plain code block — never an error.

export const MAX_TABLE_COLS = 8;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type InlineSpan =
  | { kind: "text"; text: string }
  // Bold is the ONLY nesting span — its content is re-tokenized so a link,
  // mention, wikilink, or code inside **…** renders structurally instead of as
  // raw literal text (INLINE-SPANS-DO-NOT-NEST). `code`/`link`/`mention`/
  // `wikilink` stay flat strings: code's content is literal by definition, and
  // the others' display text is a terminal label, not a markdown region — none
  // of them can contain further markup worth re-parsing. Bold-inside-bold is
  // structurally impossible: INLINE_RE's bold body is `[^*]+`, so a captured
  // bold's content can never itself contain `**`, which bounds the recursion
  // to exactly one extra level no matter how adversarial the input.
  | { kind: "bold"; spans: InlineSpan[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  // F22 (W24) — an `@adjective-animal` or engine-qualified `@studio/name`
  // token. `name` is the matched text AFTER the `@` (never includes it) — the
  // renderer decides chip-vs-plain-text by looking `name` up against known
  // agents; the tokenizer itself matches the SHAPE only, not agent identity.
  | { kind: "mention"; name: string }
  // MEM-5 (PLAN-MEMORY.md §3) — an Obsidian-style `[[target]]` / `[[target|alias]]`
  // memory wiki-link. `target` is the raw link target (id or Title) used for
  // resolution; `text` is the display label (the alias when given, else the
  // target). `text` is carried DELIBERATELY so any renderer without wiki-link
  // support (the tui's frozen span fallback, the height-measuring spansText)
  // shows the label with zero code change — only the app's MessageBody upgrades
  // it to a click-navigable chip.
  | { kind: "wikilink"; target: string; text: string }
  // FILE-PATH-LINKS — a bare filesystem path (absolute, or repo-relative with
  // at least one "/"), optionally suffixed with this repo's own `:line` /
  // `:line:col` convention. `text` is the exact matched string (line/col
  // suffix included, for display); `path` is the file path alone; `line`/`col`
  // are 1-based or null. Detection here is SHAPE only (a plausible path-looking
  // token) — whether it actually resolves to a real, permitted-root file is an
  // app-only, async concern (no fs access exists at this layer, and the tui has
  // no in-app viewer to open), so `text` is carried the same way `wikilink`
  // carries its display label: any renderer that doesn't special-case "path"
  // (today: the tui) shows the plain matched text with zero code change; only
  // the app's MessageBody resolves it (against registered project roots) and
  // upgrades it to a click-to-preview span.
  | { kind: "path"; text: string; path: string; line: number | null; col: number | null };

export type ColumnAlign = "left" | "right";

export type ChartPoint = { label: string; value: number };

// v7 (W14, Tauri-only) — a named series inside a multi-series ```chart spec.
export type ChartSeries = { name: string; points: number[] };

// v7 (W14) — flowchart-LR subset: nodes + edges only (no subgraphs/styling).
export type MermaidNodeShape = "rect" | "round" | "diamond";
export type MermaidNode = { id: string; label: string; shape: MermaidNodeShape };
export type MermaidEdge = { from: string; to: string; label?: string };

// F21 (W23) — the 12 output-component kinds, all fenced blocks (the fence's
// info string carries the kind name; `callout` also carries a tone as a
// second word, e.g. ```callout success). Same streaming/fallback contract as
// chart/mermaid (F12 v7): an open fence shows a dim placeholder instead of
// raw lines, and a malformed body degrades to a plain code block — never a
// crash. Line-based kinds parse one item per non-blank line; JSON kinds parse
// one JSON value filling the whole fence body.
export type StatusTone = "ok" | "warn" | "fail";
export type StatusItem = { tone: StatusTone; name: string; meta?: string };

export type ChecklistTone = "done" | "pending" | "flagged";
export type ChecklistItem = { tone: ChecklistTone; text: string; note?: string };

export type KvPair = { key: string; value: string };

export type DiffstatRow = { path: string; plus: number; minus: number };

export type TimelineItem = { time: string; event: string };

export type TreeBadge = "A" | "M" | "D";
export type TreeEntry = { depth: number; name: string; badge?: TreeBadge };

export type LinkItem = { label: string; kind: string };

export type ProgressItem = { pct: number; step?: string; eta?: string };

export type CalloutTone = "info" | "success" | "warn" | "error";

export type MetricItem = {
  label: string;
  value: string | number;
  delta?: string | number;
  dir?: "up" | "down";
  good?: boolean;
};

export type TestReportFailure = { name: string; note?: string };
export type TestReportSpec = {
  pass: number;
  fail: number;
  skip: number;
  duration: string | number;
  failures: TestReportFailure[];
};

export type CompareCriterion = { name: string; values: string[] };
export type CompareSpec = {
  options: string[];
  criteria: CompareCriterion[];
  pick?: string;
  reason?: string;
};

// EXCALIDRAW-DIAGRAMS — a fenced ```excalidraw block carries a standard
// Excalidraw scene JSON (the same shape a .excalidraw file has: {type, version,
// elements[], appState?}). We keep the scene as an opaque passthrough after a
// STRUCTURAL check only ({type:"excalidraw", elements: array}); appState/files
// are optional and forwarded verbatim to the renderer (the app hands the whole
// scene to @excalidraw/excalidraw, the tui shows a one-line placeholder). Any
// element's internal shape is @excalidraw's concern, not the parser's — so we
// never validate element fields (forward-compatible with new element kinds).
export type ExcalidrawScene = {
  type: "excalidraw";
  version?: number;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

// F22 (W24) — a quote-reply's attribution: who/what is quoted + when. Encoded
// as the LAST line of a `>` blockquote block (see QUOTE_REF_RE below); absent
// (ref: null) when the last quoted line doesn't match that shape — degrades to
// a plain blockquote, never a crash.
export type QuoteRef = { mention: string; kind: "result" | "turn"; ts: string };

// The kind names a still-open fence can carry — used to pick the streaming
// placeholder's label (F12 v7's "chart/diagram streaming…" pattern, extended
// to all 12 new kinds).
export type StreamingKind =
  | "chart"
  | "mermaid"
  | "status"
  | "checklist"
  | "kv"
  | "diffstat"
  | "timeline"
  | "tree"
  | "links"
  | "progress"
  | "callout"
  | "metric"
  | "test-report"
  | "compare"
  | "excalidraw";

export type MessageBlock =
  | { type: "paragraph"; spans: InlineSpan[] }
  // MD-HEADINGS — an ATX heading. `level` is the hash count; the renderer maps
  // it to size/weight, so a level is never "just" a bigger paragraph.
  | { type: "heading"; level: HeadingLevel; spans: InlineSpan[] }
  | { type: "list"; items: InlineSpan[][] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "table"; headers: InlineSpan[][]; align: ColumnAlign[]; rows: InlineSpan[][][] }
  // W12 single-series form: {type, data:[{label,value}], unit?}
  | { type: "chart"; chartType: "bar" | "line"; data: ChartPoint[]; unit?: string }
  // v7 (W14) multi-series form: {type, title?, labels:[], series:[{name,points:[]}]}
  | { type: "chart"; chartType: "bar" | "line"; title?: string; labels: string[]; series: ChartSeries[]; unit?: string }
  | { type: "mermaid"; nodes: MermaidNode[]; edges: MermaidEdge[] }
  // F21 (W23) — the 12 output components
  | { type: "status"; items: StatusItem[] }
  | { type: "checklist"; items: ChecklistItem[] }
  | { type: "kv"; items: KvPair[] }
  | { type: "diffstat"; rows: DiffstatRow[] }
  | { type: "timeline"; items: TimelineItem[] }
  | { type: "tree"; entries: TreeEntry[] }
  | { type: "links"; items: LinkItem[] }
  | { type: "progress"; items: ProgressItem[] }
  | { type: "callout"; tone: CalloutTone; text: string }
  // INSIGHT-BLOCK: the star/rule pair the explanatory output style emits. Its body is an ASIDE — a
  // teaching note about the work, not the work — and rendered as ordinary paragraphs it reads as
  // more of the same answer, which is exactly the confusion this fixes. `title` is whatever
  // follows the star, so a style using a different word still gets a box rather than two rows of
  // dashes.
  // `blocks`, not inline spans: an insight body is ordinary markdown and routinely contains a
  // fenced code block (an ADF payload, a config snippet). Tokenized inline, those fences rendered
  // as literal ``` lines inside the box — the one place in the transcript where code was NOT
  // formatted. Parsed recursively, everything the renderer already knows how to draw works here.
  | { type: "insight"; title: string; blocks: MessageBlock[] }
  | { type: "metric"; items: MetricItem[] }
  | { type: "test-report"; report: TestReportSpec }
  | { type: "compare"; compare: CompareSpec }
  // EXCALIDRAW-DIAGRAMS — a ```excalidraw fence carrying a scene JSON. `scene`
  // is the validated (structural-only) passthrough handed to the renderer;
  // `elementCount` (= scene.elements.length) drives the app's oversized-scene
  // collapse and the tui's placeholder count without re-reading the scene.
  | { type: "excalidraw"; scene: ExcalidrawScene; elementCount: number }
  // F22 (W24) — a `>`-prefixed blockquote (a quote-reply's quoted excerpt).
  // `text` is the excerpt body (quoted lines, "> " stripped, joined by "\n");
  // `ref` is the parsed attribution line when the last quoted line matched
  // QUOTE_REF_RE, else null (a plain blockquote — still rendered, just with
  // no clickable header).
  | { type: "quote"; text: string; ref: QuoteRef | null }
  // streamingKind marks a still-open fence whose kind renders a component —
  // its renderer shows a dim placeholder instead of raw lines (unset ⇒ the
  // ordinary raw-lines rule).
  | { type: "raw"; text: string; streamingKind?: StreamingKind };

// ---------------------------------------------------------------------------
// inline tokenizer — **bold**, `code`, [text](url), @mention; earliest match
// wins. Ported from the app's Markdown.tsx tokenizer so both live off ONE rule
// set. Links carry their url but a renderer decides whether they navigate (the
// desktop renders them as accent text, never a live <a>).
//
// F22 (W24) — @mention matches the SHAPE of an adjective-animal name or an
// engine-qualified "studio/name" (a leading letter, then letters/digits/
// hyphen/underscore, optionally "/" + the same shape again) — it does NOT
// check agent identity; an unmatched-shape "@" (an email like foo@bar.com, a
// bare "@") just falls through as plain text via the trailing capture. The
// renderer resolves `name` against known agents and renders plain text for an
// unknown one (F22 acceptance: "unknown names stay plain text").
// ---------------------------------------------------------------------------

const MENTION_SEGMENT = "[a-zA-Z][a-zA-Z0-9_-]*";
// The `[[…]]` alternative is LAST so it never shadows the existing forms; the
// markdown-link form `[text](url)` can't match a `[[target]]` (no `(url)` tail),
// so ordering only needs wiki-link after it to be safe. Groups: 10 outer, 11
// target, 12 optional alias. `[^\[\]|]+` bars nested brackets and the alias pipe;
// mirrors core's memory-links.ts parser so app + daemon agree on what a link is.
//
// BARE-URL-AUTOLINK — group 13, `https?://\S+`. It's appended LAST so it never
// shadows `[text](url)`: the bracket form starts at `[`, which is always an
// earlier scan position than the `http` inside its own `(url)` tail, so the
// engine commits to the bracket alternative before ever trying this one on the
// same text. The raw capture is greedy (swallows trailing prose punctuation
// and any prose paren wrapping the URL) — trimAutolinkTrailing() below trims
// it back down to the real URL, and tokenizeInline shortens `last` to match so
// the trimmed-off characters flow back into the surrounding text span.
// FILE-PATH-LINKS — group 14, a bare path token: an optional leading "/"
// (absolute) or "~/" (PATH-LINK-TILDE-AND-SCOPE: home-relative — see
// pathRefs.ts's candidateRoots and fsbrowse.ts's expandHome for how that
// prefix is resolved; deliberately ONLY the bare "~/" form. "~user/..." (some
// OTHER user's home) is NOT recognized as a home-relative shape — "~" itself
// is outside PATH_SEGMENT's char class, so the match can only start AFTER the
// username, e.g. "~bob/x/y.ts" tokenizes as plain text "~bob" + a
// (harmless, almost-certainly-unresolvable) repo-relative path "x/y.ts". This
// is a preexisting, unrelated tokenizer property — ANY coincidental
// slash-separated text already tokenized as a repo-relative candidate before
// this feature existed — not a "~user" special case, and not a security
// concern: it's never treated as tilde-shaped (pathRefs.ts's isTildePath is
// false for it), so it only ever gets tried as an ordinary repo-relative
// candidate against registered projects, same as always), one-or-more
// "segment/" directory components (so a bare extensionless word or a
// slash-free "foo.ts" never matches — a path mention worth linking always has
// a directory separator in this codebase's usage), a final segment, a real
// extension, and up to two trailing `:digits` groups for this repo's own
// `path:line` / `path:line:col` convention. The extension must START with a
// letter (1-12 alnum chars total) — a real file extension always does, and
// this is what keeps a version-ish or numeric-fraction token like "3/4" or
// "v1.2/3.4" from shape-matching as a path (its "extension" would be
// all-digits). The segment class deliberately excludes ":" and ",", so
// trailing prose punctuation (a sentence's period, a comma, a bare colon with
// no digits after it) is never part of the match — unlike the bare-URL form,
// no trimAutolinkTrailing-style cleanup is needed. Appended LAST (after the
// bare-URL group) purely by convention (newest addition goes last); there is
// no ordering hazard with the other alternatives since none of them can start
// with "/", "~", or a path-segment word character while also being a
// superset of this shape at the same scan position.
const PATH_SEGMENT = "[\\w.\\-@]+";
const PATH_TOKEN_SOURCE = `(?:~/|/)?(?:${PATH_SEGMENT}/)+${PATH_SEGMENT}\\.[A-Za-z][A-Za-z0-9]{0,11}(?::\\d+){0,2}`;

const INLINE_RE = new RegExp(
  `(\\*\\*([^*]+)\\*\\*)|(\`([^\`]+)\`)|(\\[([^\\]]+)\\]\\((<[^<>\\r\\n]+>|[^)\\s]+)\\))|(@(${MENTION_SEGMENT}(?:/${MENTION_SEGMENT})?))|(\\[\\[([^\\[\\]|]+)(?:\\|([^\\[\\]]*))?\\]\\])|(https?://\\S+)|(${PATH_TOKEN_SOURCE})`,
  "g",
);

// FILE-PATH-LINKS — peels this repo's own `:line` / `:line:col` suffix (up to
// two trailing `:digits` groups) off a matched path token. Unambiguous: ":"
// never appears inside PATH_SEGMENT, so any trailing `:digits` run can only be
// the line/col suffix, never part of a directory or file name.
const PATH_SUFFIX_RE = /(?::(\d+))(?::(\d+))?$/;

export function parsePathToken(raw: string): { path: string; line: number | null; col: number | null } {
  const m = PATH_SUFFIX_RE.exec(raw);
  if (!m) return { path: raw, line: null, col: null };
  return { path: raw.slice(0, m.index), line: Number(m[1]), col: m[2] ? Number(m[2]) : null };
}

const AUTOLINK_TRAILING_PUNCT_RE = /[.,;:!?'"’”]$/;

// BARE-URL-AUTOLINK — trims a greedily-captured `https?://\S+` match down to
// the actual URL. Trailing prose punctuation (a sentence's period, a comma, a
// closing quote…) is never part of a URL, so it's stripped unconditionally.
// A trailing ")" is different: it's part of the URL when the URL itself opened
// it (e.g. a wiki article `Foo_(bar)`), but NOT when prose wrapped the whole
// URL in parens (`(see https://x.test)` — the opening "(" sits before the
// match and was never captured, so the count is unbalanced). Only an
// unmatched trailing ")" gets stripped, and the two checks alternate in a
// loop so cascaded cases (`…(bar)).` or `…(bar),`) resolve fully.
export function trimAutolinkTrailing(raw: string): string {
  let s = raw;
  for (;;) {
    if (AUTOLINK_TRAILING_PUNCT_RE.test(s)) {
      s = s.slice(0, -1);
      continue;
    }
    if (s.endsWith(")")) {
      const opens = (s.match(/\(/g) ?? []).length;
      const closes = (s.match(/\)/g) ?? []).length;
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return s;
}

export function tokenizeInline(text: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  let last = 0;
  // matchAll (not a manual lastIndex/exec loop) — bold recursion re-enters
  // this function with the SAME module-level INLINE_RE while an outer call is
  // still mid-iteration; a shared mutable .lastIndex would let the recursive
  // call's resets corrupt the outer loop's position, producing a never-
  // advancing scan that grows `out` without bound (confirmed: OOM'd the
  // process on "**x**".repeat(200) before this fix). matchAll's iterator
  // clones the regex with its own independent lastIndex, so nested calls
  // can't interfere with each other no matter how deep the nesting.
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    let matchLen = m[0]!.length;
    if (m[2] !== undefined) out.push({ kind: "bold", spans: tokenizeInline(m[2]) });
    else if (m[4] !== undefined) out.push({ kind: "code", text: m[4] });
    else if (m[6] !== undefined) out.push({ kind: "link", text: m[6], url: m[7] ?? "" });
    else if (m[9] !== undefined) out.push({ kind: "mention", name: m[9] });
    else if (m[11] !== undefined) {
      // Alias display text wins when present and non-blank; else fall back to the
      // target itself (an id or Title). Both trimmed, matching the store's parser.
      const target = m[11].trim();
      const alias = m[12]?.trim();
      out.push({ kind: "wikilink", target, text: alias ? alias : target });
    } else if (m[13] !== undefined) {
      const url = trimAutolinkTrailing(m[13]);
      out.push({ kind: "link", text: url, url });
      matchLen = url.length;
    } else if (m[14] !== undefined) {
      const { path, line, col } = parsePathToken(m[14]);
      out.push({ kind: "path", text: m[14], path, line, col });
    }
    last = m.index + matchLen;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  if (out.length === 0) out.push({ kind: "text", text: "" });
  return out;
}

// ---------------------------------------------------------------------------
// line classifiers
// ---------------------------------------------------------------------------

const FENCE_RE = /^```(.*)$/;
const LIST_RE = /^\s*[-*]\s+(.*)$/;
const NUMERIC_RE = /^[+-]?(\d[\d,]*)(\.\d+)?%?$/; // 1  1,234  3.5  42%  -7
// F22 (W24) — a GFM-style blockquote line ("> text" or a bare ">"). The
// attribution line a quote-reply appends (see QUOTE_REF_RE) rides the SAME
// prefix so any client's plain markdown viewer renders the whole thing as one
// blockquote — "legible markdown" per the F22 acceptance line.
const QUOTE_LINE_RE = /^>\s?(.*)$/;
// MD-HEADINGS — an ATX heading (`# ` … `###### `), optional closing hashes.
// The required space after the hashes is load-bearing, not pedantry: it is the
// only thing keeping a line that OPENS with `#2` (a PR number) or `#etiket`
// from being read as a heading. Content must be non-blank, so a bare `##`
// stays a paragraph rather than rendering as an empty heading rule.
const HEADING_RE = /^(#{1,6})[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;
// INSIGHT-BLOCK — the delimiters. The optional backticks are not defensive padding: the output
// style that produces these wraps BOTH rules in backticks, so without them the opening line parses
// as inline CODE and renders as a bordered chip full of dashes — which is what shipped.
const INSIGHT_OPEN_RE = /^`?\s*\u2605\s*(.*?)\s*\u2500{3,}\s*`?$/;
const INSIGHT_CLOSE_RE = /^`?\s*\u2500{3,}\s*`?$/;
const QUOTE_REF_RE = new RegExp(`^— @(${MENTION_SEGMENT}(?:/${MENTION_SEGMENT})?) · (result|turn) · (\\d{2}:\\d{2}:\\d{2})$`);

const isBlank = (line: string): boolean => line.trim() === "";
const isHeading = (line: string): boolean => HEADING_RE.test(line);
const isInsightOpen = (line: string): boolean => INSIGHT_OPEN_RE.test(line);
const isFence = (line: string): boolean => FENCE_RE.test(line);
const isListItem = (line: string): boolean => LIST_RE.test(line);
const isQuoteLine = (line: string): boolean => QUOTE_LINE_RE.test(line);

/** A pipe-table row: contains a `|` and isn't a fence/list line. */
function looksLikeTableRow(line: string): boolean {
  return line.includes("|") && !isFence(line) && !isListItem(line);
}

/** The GFM separator row under the header: every cell is dashes (with optional
 * leading/trailing colons for explicit alignment). */
function isTableSeparator(line: string): boolean {
  if (!line.includes("-") || !line.includes("|")) return false;
  const cells = splitPipeRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Split one pipe row into trimmed cells, dropping the empty cells the leading
 * and trailing pipes produce (`| a | b |` → ["a","b"]; `a | b` → ["a","b"]). */
function splitPipeRow(line: string): string[] {
  const parts = line.split("|").map((c) => c.trim());
  if (parts.length > 0 && parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// chart spec — a fenced ```chart block. W12 shipped the single-series form
// {type, data:[{label,value}], unit?}; v7 (W14) adds a multi-series form
// {type, title?, labels:[], series:[{name, points:[]}], unit?} — additive,
// picked by the presence of `series`. Any parse/shape failure returns null so
// the caller degrades to a code block, never an error.
// ---------------------------------------------------------------------------

type SingleSeriesChart = Extract<MessageBlock, { type: "chart"; data: ChartPoint[] }>;
type MultiSeriesChart = Extract<MessageBlock, { type: "chart"; series: ChartSeries[] }>;

function parseChart(body: string): SingleSeriesChart | MultiSeriesChart | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (o.type !== "bar" && o.type !== "line") return null;
  const unit = typeof o.unit === "string" ? o.unit : undefined;

  if (o.series !== undefined) {
    if (!Array.isArray(o.labels) || o.labels.length === 0 || !o.labels.every((l) => typeof l === "string")) return null;
    if (!Array.isArray(o.series) || o.series.length === 0) return null;
    const series: ChartSeries[] = [];
    for (const raw of o.series) {
      if (typeof raw !== "object" || raw === null) return null;
      const s = raw as Record<string, unknown>;
      if (typeof s.name !== "string") return null;
      if (!Array.isArray(s.points) || s.points.length !== o.labels.length) return null;
      if (!s.points.every((p) => typeof p === "number" && Number.isFinite(p))) return null;
      series.push({ name: s.name, points: s.points as number[] });
    }
    const out: MultiSeriesChart = { type: "chart", chartType: o.type, labels: o.labels as string[], series };
    if (typeof o.title === "string") out.title = o.title;
    if (unit) out.unit = unit;
    return out;
  }

  if (!Array.isArray(o.data) || o.data.length === 0) return null;
  const data: ChartPoint[] = [];
  for (const raw of o.data) {
    if (typeof raw !== "object" || raw === null) return null;
    const p = raw as Record<string, unknown>;
    if (typeof p.label !== "string" || typeof p.value !== "number" || !Number.isFinite(p.value)) return null;
    data.push({ label: p.label, value: p.value });
  }
  const out: SingleSeriesChart = { type: "chart", chartType: o.type, data };
  if (unit) out.unit = unit;
  return out;
}

// ---------------------------------------------------------------------------
// mermaid spec — a fenced ```mermaid block, flowchart-LR subset only: a
// `flowchart LR` directive followed by node decls (`id[Label]`) and/or edges
// (`A --> B`, `A -->|label| B`). Any other mermaid syntax (subgraphs, styling,
// classDef, other directions) is unsupported and returns null so the caller
// degrades to a plain code block — never an error.
// ---------------------------------------------------------------------------

const MERMAID_DIRECTIVE_RE = /^flowchart\s+LR\s*;?$/i;
const MERMAID_ID = "[A-Za-z_][A-Za-z0-9_]*";
// Already parenthesized as ONE capturing group — callers append `?` directly
// rather than re-wrapping (re-wrapping would nest a second group and shift
// every subsequent capture index in MERMAID_EDGE_RE).
const MERMAID_LABEL = "(\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\})";
const MERMAID_NODE_DECL_RE = new RegExp(`^(${MERMAID_ID})\\s*${MERMAID_LABEL}?\\s*;?$`);
const MERMAID_EDGE_RE = new RegExp(
  `^(${MERMAID_ID})\\s*${MERMAID_LABEL}?\\s*-->\\s*(?:\\|([^|]*)\\|\\s*)?(${MERMAID_ID})\\s*${MERMAID_LABEL}?\\s*;?$`,
);

function mermaidShapeAndLabel(id: string, bracket: string | undefined): { shape: MermaidNodeShape; label: string } {
  if (!bracket) return { shape: "rect", label: id };
  const inner = bracket.slice(1, -1).trim().replace(/^"(.*)"$/, "$1");
  const label = inner || id;
  if (bracket.startsWith("(")) return { shape: "round", label };
  if (bracket.startsWith("{")) return { shape: "diamond", label };
  return { shape: "rect", label };
}

function parseMermaid(body: string): Extract<MessageBlock, { type: "mermaid" }> | null {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("%%"));
  if (lines.length === 0 || !MERMAID_DIRECTIVE_RE.test(lines[0]!)) return null;

  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  const upsertNode = (id: string, bracket: string | undefined): void => {
    if (nodes.has(id) && !bracket) return;
    const { shape, label } = mermaidShapeAndLabel(id, bracket);
    nodes.set(id, { id, label, shape });
  };

  for (const line of lines.slice(1)) {
    const edgeMatch = MERMAID_EDGE_RE.exec(line);
    if (edgeMatch) {
      const [, fromId, fromBracket, edgeLabel, toId, toBracket] = edgeMatch;
      upsertNode(fromId!, fromBracket);
      upsertNode(toId!, toBracket);
      const edge: MermaidEdge = { from: fromId!, to: toId! };
      if (edgeLabel && edgeLabel.trim()) edge.label = edgeLabel.trim();
      edges.push(edge);
      continue;
    }
    const nodeMatch = MERMAID_NODE_DECL_RE.exec(line);
    if (nodeMatch) {
      upsertNode(nodeMatch[1]!, nodeMatch[2]);
      continue;
    }
    return null; // unsupported mermaid syntax — degrade to a code block
  }

  if (nodes.size === 0) return null;
  return { type: "mermaid", nodes: [...nodes.values()], edges };
}

// ---------------------------------------------------------------------------
// F21 (W23) output-component fences — one parser per kind. Every parser
// returns null on ANY malformed line/value so the caller degrades the whole
// fence to a plain code block, matching parseChart/parseMermaid's contract.
// ---------------------------------------------------------------------------

const nonBlankLines = (body: string): string[] => body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

const STATUS_LINE_RE = /^(ok|warn|fail)\s+(.+)$/;

function parseStatusFence(body: string): Extract<MessageBlock, { type: "status" }> | null {
  const lines = nonBlankLines(body);
  if (lines.length === 0) return null;
  const items: StatusItem[] = [];
  for (const line of lines) {
    const m = STATUS_LINE_RE.exec(line);
    if (!m) return null;
    const rest = m[2]!;
    const sep = rest.indexOf(" · ");
    const name = (sep === -1 ? rest : rest.slice(0, sep)).trim();
    const meta = sep === -1 ? undefined : rest.slice(sep + 3).trim();
    if (!name) return null;
    items.push(meta ? { tone: m[1] as StatusTone, name, meta } : { tone: m[1] as StatusTone, name });
  }
  return { type: "status", items };
}

const CHECKLIST_LINE_RE = /^\[( |x|!)\]\s+(.+)$/;

function parseChecklistFence(body: string): Extract<MessageBlock, { type: "checklist" }> | null {
  const lines = nonBlankLines(body);
  if (lines.length === 0) return null;
  const items: ChecklistItem[] = [];
  for (const line of lines) {
    const m = CHECKLIST_LINE_RE.exec(line);
    if (!m) return null;
    const rest = m[2]!;
    const sep = rest.indexOf(" — ");
    const text = (sep === -1 ? rest : rest.slice(0, sep)).trim();
    const note = sep === -1 ? undefined : rest.slice(sep + 3).trim();
    if (!text) return null;
    const tone: ChecklistTone = m[1] === "x" ? "done" : m[1] === "!" ? "flagged" : "pending";
    items.push(note ? { tone, text, note } : { tone, text });
  }
  return { type: "checklist", items };
}

function parseKvFence(body: string): Extract<MessageBlock, { type: "kv" }> | null {
  const lines = nonBlankLines(body);
  if (lines.length === 0) return null;
  const items: KvPair[] = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) return null;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) return null;
    items.push({ key, value });
  }
  return { type: "kv", items };
}

const DIFFSTAT_LINE_RE = /^(\S+)\s+\+(\d+)\s+[-−](\d+)$/;

function parseDiffstatFence(body: string): Extract<MessageBlock, { type: "diffstat" }> | null {
  const lines = nonBlankLines(body);
  if (lines.length === 0) return null;
  const rows: DiffstatRow[] = [];
  for (const line of lines) {
    const m = DIFFSTAT_LINE_RE.exec(line);
    if (!m) return null;
    rows.push({ path: m[1]!, plus: Number(m[2]), minus: Number(m[3]) });
  }
  return { type: "diffstat", rows };
}

const TIMELINE_LINE_RE = /^(\d{2}:\d{2})\s+(.+)$/;

function parseTimelineFence(body: string): Extract<MessageBlock, { type: "timeline" }> | null {
  const lines = nonBlankLines(body);
  if (lines.length === 0) return null;
  const items: TimelineItem[] = [];
  for (const line of lines) {
    const m = TIMELINE_LINE_RE.exec(line);
    if (!m) return null;
    items.push({ time: m[1]!, event: m[2]!.trim() });
  }
  return { type: "timeline", items };
}

const TREE_BADGE_RE = /^(.*\S)\s+([AMD])$/;

function parseTreeFence(body: string): Extract<MessageBlock, { type: "tree" }> | null {
  const rawLines = body.split("\n").filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return null;
  const entries: TreeEntry[] = [];
  for (const line of rawLines) {
    const indent = /^ */.exec(line)![0]!.length;
    if (indent % 2 !== 0) return null;
    let rest = line.slice(indent);
    if (!rest || isBlank(rest)) return null;
    let badge: TreeBadge | undefined;
    const badgeMatch = TREE_BADGE_RE.exec(rest);
    if (badgeMatch) {
      rest = badgeMatch[1]!;
      badge = badgeMatch[2] as TreeBadge;
    }
    entries.push(badge ? { depth: indent / 2, name: rest, badge } : { depth: indent / 2, name: rest });
  }
  return { type: "tree", entries };
}

const LINKS_LINE_RE = /^(.+?)\s+\(([^()]+)\)$/;

function parseLinksFence(body: string): Extract<MessageBlock, { type: "links" }> | null {
  const lines = nonBlankLines(body);
  if (lines.length === 0) return null;
  const items: LinkItem[] = [];
  for (const line of lines) {
    const m = LINKS_LINE_RE.exec(line);
    if (!m) return null;
    items.push({ label: m[1]!.trim(), kind: m[2]!.trim() });
  }
  return { type: "links", items };
}

function parseProgressFence(body: string): Extract<MessageBlock, { type: "progress" }> | null {
  const lines = nonBlankLines(body);
  if (lines.length === 0) return null;
  const items: ProgressItem[] = [];
  for (const line of lines) {
    const parts = line.split(/\s*·\s*/);
    const pctMatch = /^(\d+)%$/.exec(parts[0]!);
    if (!pctMatch) return null;
    const item: ProgressItem = { pct: Number(pctMatch[1]) };
    for (const part of parts.slice(1)) {
      if (/^step\s+\S/.test(part)) item.step = part.replace(/^step\s+/, "").trim();
      else if (/^eta\s+\S/.test(part)) item.eta = part.replace(/^eta\s+/, "").trim();
      else return null;
    }
    items.push(item);
  }
  return { type: "progress", items };
}

const CALLOUT_TONES = new Set<CalloutTone>(["info", "success", "warn", "error"]);

function parseCalloutFence(toneWord: string | undefined, body: string): Extract<MessageBlock, { type: "callout" }> | null {
  const text = body.trim();
  if (!text) return null;
  if (toneWord && !CALLOUT_TONES.has(toneWord as CalloutTone)) return null;
  return { type: "callout", tone: toneWord ? (toneWord as CalloutTone) : "info", text };
}

function parseMetricFence(body: string): Extract<MessageBlock, { type: "metric" }> | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(json) || json.length === 0) return null;
  const items: MetricItem[] = [];
  for (const raw of json) {
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.label !== "string") return null;
    if (typeof o.value !== "string" && typeof o.value !== "number") return null;
    const item: MetricItem = { label: o.label, value: o.value };
    if (typeof o.delta === "string" || typeof o.delta === "number") item.delta = o.delta;
    if (o.dir === "up" || o.dir === "down") item.dir = o.dir;
    if (typeof o.good === "boolean") item.good = o.good;
    items.push(item);
  }
  return { type: "metric", items };
}

function parseTestReportFence(body: string): Extract<MessageBlock, { type: "test-report" }> | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (typeof o.pass !== "number" || typeof o.fail !== "number" || typeof o.skip !== "number") return null;
  if (typeof o.duration !== "string" && typeof o.duration !== "number") return null;
  const failures: TestReportFailure[] = [];
  if (o.failures !== undefined) {
    if (!Array.isArray(o.failures)) return null;
    for (const raw of o.failures) {
      if (typeof raw !== "object" || raw === null) return null;
      const f = raw as Record<string, unknown>;
      if (typeof f.name !== "string") return null;
      failures.push(typeof f.note === "string" ? { name: f.name, note: f.note } : { name: f.name });
    }
  }
  return { type: "test-report", report: { pass: o.pass, fail: o.fail, skip: o.skip, duration: o.duration, failures } };
}

function parseCompareFence(body: string): Extract<MessageBlock, { type: "compare" }> | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.options) || o.options.length === 0 || !o.options.every((v) => typeof v === "string")) return null;
  const options = o.options as string[];
  if (!Array.isArray(o.criteria) || o.criteria.length === 0) return null;
  const criteria: CompareCriterion[] = [];
  for (const raw of o.criteria) {
    if (typeof raw !== "object" || raw === null) return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string") return null;
    if (!Array.isArray(c.values) || c.values.length !== options.length || !c.values.every((v) => typeof v === "string")) return null;
    criteria.push({ name: c.name, values: c.values as string[] });
  }
  const compare: CompareSpec = { options, criteria };
  if (typeof o.pick === "string") compare.pick = o.pick;
  if (typeof o.reason === "string") compare.reason = o.reason;
  return { type: "compare", compare };
}

// EXCALIDRAW-DIAGRAMS — a ```excalidraw fence body is one Excalidraw scene
// JSON. Structural validation ONLY (per the feature contract): it must be a
// JSON object with type:"excalidraw" and an `elements` array; version/appState/
// files are optional and forwarded verbatim. Any failure returns null so the
// caller degrades to a plain code block (the renderer additionally notes
// "invalid excalidraw scene") — never an error, never a crashed transcript.
function parseExcalidrawFence(body: string): Extract<MessageBlock, { type: "excalidraw" }> | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.type !== "excalidraw") return null;
  if (!Array.isArray(o.elements)) return null;
  const scene: ExcalidrawScene = { type: "excalidraw", elements: o.elements };
  if (typeof o.version === "number") scene.version = o.version;
  if (typeof o.appState === "object" && o.appState !== null && !Array.isArray(o.appState)) {
    scene.appState = o.appState as Record<string, unknown>;
  }
  if (typeof o.files === "object" && o.files !== null && !Array.isArray(o.files)) {
    scene.files = o.files as Record<string, unknown>;
  }
  return { type: "excalidraw", scene, elementCount: o.elements.length };
}

// info-string word → parser, for the line-based + JSON kinds that don't need
// a second fence-info word (every kind except `callout`, dispatched inline).
const COMPONENT_PARSERS: Record<string, (body: string) => MessageBlock | null> = {
  status: parseStatusFence,
  checklist: parseChecklistFence,
  kv: parseKvFence,
  diffstat: parseDiffstatFence,
  timeline: parseTimelineFence,
  tree: parseTreeFence,
  links: parseLinksFence,
  progress: parseProgressFence,
  metric: parseMetricFence,
  "test-report": parseTestReportFence,
  compare: parseCompareFence,
};

const STREAMING_FENCE_KINDS = new Set<StreamingKind>([
  "chart",
  "mermaid",
  "status",
  "checklist",
  "kv",
  "diffstat",
  "timeline",
  "tree",
  "links",
  "progress",
  "callout",
  "metric",
  "test-report",
  "compare",
  "excalidraw",
]);

// ---------------------------------------------------------------------------
// the block closer
// ---------------------------------------------------------------------------

/** Is the block that ends at index `k` CONFIRMED closed?
 *
 * The subtlety is the trailing newline: "a\n" splits to ["a",""] where the ""
 * is the line ending, NOT a blank separator (you need "a\n\n" for that). During
 * streaming that trailing "" must not close "a" — the next delta could turn it
 * into "a\nb" (a continuation). So a blank at index k confirms a boundary only
 * when it is NOT the final array element (real input follows it) or the turn
 * has ended; a non-blank line at k (a new structural block) always confirms;
 * running past the end confirms only on `done`. This is what makes closed
 * blocks byte-stable across a growing prefix (no reflow). */
function isConfirmedBoundary(lines: string[], k: number, done: boolean): boolean {
  if (k >= lines.length) return done;
  if (!isBlank(lines[k]!)) return true;
  if (k < lines.length - 1) return true;
  return done;
}

/** Parse a (possibly still-streaming) message body into blocks. `done` marks
 * the turn end — when true, a trailing block with no terminator is closed and
 * formatted; when false it stays a raw block. */
export function parseMessageBlocks(text: string, done: boolean): MessageBlock[] {
  const lines = text.split("\n");
  const blocks: MessageBlock[] = [];
  let i = 0;

  const rawTail = (from: number, streamingKind?: StreamingKind): void => {
    // The still-open trailing region — one raw block, verbatim (trailing blank
    // lines trimmed so a lone "\n" the composer appends doesn't render).
    // streamingKind marks a still-open chart/mermaid fence, so the renderer can
    // show a dim placeholder instead of raw JSON (unset ⇒ raw lines, as usual).
    let end = lines.length;
    while (end > from && isBlank(lines[end - 1]!)) end--;
    if (end > from) {
      const text = lines.slice(from, end).join("\n");
      blocks.push(streamingKind ? { type: "raw", text, streamingKind } : { type: "raw", text });
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (isBlank(line)) {
      i++;
      continue;
    }

    // fenced code / chart / F21 output components ---------------------------
    if (isFence(line)) {
      const lang = (FENCE_RE.exec(line)![1] ?? "").trim();
      const kindWord = lang.split(/\s+/, 1)[0] ?? "";
      let j = i + 1;
      while (j < lines.length && !isFence(lines[j]!)) j++;
      const closed = j < lines.length; // found the closing ```
      if (!closed && !done) {
        // still streaming inside the fence → raw until it closes. A component
        // fence shows a dim placeholder instead of raw JSON/lines (F12 v7).
        rawTail(i, STREAMING_FENCE_KINDS.has(kindWord as StreamingKind) ? (kindWord as StreamingKind) : undefined);
        return blocks;
      }
      const body = lines.slice(i + 1, closed ? j : lines.length).join("\n");
      const componentParser = COMPONENT_PARSERS[kindWord];
      if (lang === "chart") {
        const chart = parseChart(body);
        blocks.push(chart ?? { type: "code", lang: "chart", text: body });
      } else if (lang === "mermaid") {
        const diagram = parseMermaid(body);
        blocks.push(diagram ?? { type: "code", lang: "mermaid", text: body });
      } else if (lang === "excalidraw") {
        // EXCALIDRAW-DIAGRAMS — a malformed scene degrades to a code block so
        // the renderer can show the raw JSON plus its "invalid excalidraw
        // scene" note (never a crash).
        const scene = parseExcalidrawFence(body);
        blocks.push(scene ?? { type: "code", lang: "excalidraw", text: body });
      } else if (kindWord === "callout") {
        const toneWord = lang.split(/\s+/)[1];
        const callout = parseCalloutFence(toneWord, body);
        blocks.push(callout ?? { type: "code", lang, text: body });
      } else if (componentParser) {
        const parsed = componentParser(body);
        blocks.push(parsed ?? { type: "code", lang, text: body });
      } else {
        blocks.push({ type: "code", lang: lang === "" ? null : lang, text: body });
      }
      i = closed ? j + 1 : lines.length;
      continue;
    }

    // INSIGHT-BLOCK: opens on the star rule, closes on the bare rule. An UNCLOSED one at the turn
    // end still becomes a block rather than leaking two rows of dashes into the transcript — the
    // opening rule is unambiguous enough to trust on its own.
    if (isInsightOpen(line)) {
      let k = i + 1;
      while (k < lines.length && !INSIGHT_CLOSE_RE.test(lines[k]!)) k++;
      const closed = k < lines.length;
      if (!closed && !done) {
        rawTail(i);
        return blocks;
      }
      const title = (INSIGHT_OPEN_RE.exec(line)![1] ?? "").trim();
      const body = lines.slice(i + 1, k).join("\n").trim();
      // `true`: whatever the body holds is all of it, closed or not, so an unterminated construct
      // inside is finalized here rather than held back as a raw tail that would never arrive.
      blocks.push({ type: "insight", title: title || "Insight", blocks: parseMessageBlocks(body, true) });
      i = closed ? k + 1 : lines.length;
      continue;
    }

    // MD-HEADINGS — one line, so it closes as soon as ANYTHING follows it
    // (or the turn ends). Same streaming contract as every other block: never
    // formatted while it could still grow.
    if (isHeading(line)) {
      if (!isConfirmedBoundary(lines, i + 1, done)) {
        rawTail(i);
        return blocks;
      }
      const m = HEADING_RE.exec(line)!;
      blocks.push({ type: "heading", level: m[1]!.length as HeadingLevel, spans: tokenizeInline(m[2]!) });
      i++;
      continue;
    }

    // F22 (W24) — blockquote (quote-reply excerpt). Checked BEFORE the table
    // row heuristic below since a quoted line can itself contain a literal
    // "|" (looksLikeTableRow would otherwise misclassify it if the next line
    // happens to look like a separator row — narrow but real edge case).
    if (isQuoteLine(line)) {
      let k = i;
      while (k < lines.length && isQuoteLine(lines[k]!)) k++;
      const closed = isConfirmedBoundary(lines, k, done);
      if (!closed) {
        rawTail(i);
        return blocks;
      }
      blocks.push(buildQuoteBlock(lines.slice(i, k)));
      i = k;
      continue;
    }

    // pipe table (header + separator + rows) --------------------------------
    if (looksLikeTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      let k = i + 2;
      while (k < lines.length && looksLikeTableRow(lines[k]!) && !isTableSeparator(lines[k]!)) k++;
      // Closed when a terminator follows the rows (a blank/non-table line, or
      // end-of-input with done). Open (streaming) when the rows run to the end
      // of the input and the turn hasn't ended.
      const closed = isConfirmedBoundary(lines, k, done);
      if (!closed) {
        rawTail(i);
        return blocks;
      }
      blocks.push(buildTable(lines.slice(i, k)));
      i = k;
      continue;
    }

    // list ------------------------------------------------------------------
    if (isListItem(line)) {
      let k = i;
      const items: InlineSpan[][] = [];
      while (k < lines.length && isListItem(lines[k]!)) {
        items.push(tokenizeInline(LIST_RE.exec(lines[k]!)![1]!));
        k++;
      }
      const closed = isConfirmedBoundary(lines, k, done);
      if (!closed) {
        rawTail(i);
        return blocks;
      }
      blocks.push({ type: "list", items });
      i = k;
      continue;
    }

    // paragraph -------------------------------------------------------------
    let k = i;
    while (
      k < lines.length &&
      !isBlank(lines[k]!) &&
      !isFence(lines[k]!) &&
      !isHeading(lines[k]!) &&
      !isInsightOpen(lines[k]!) &&
      !isListItem(lines[k]!) &&
      !(looksLikeTableRow(lines[k]!) && k + 1 < lines.length && isTableSeparator(lines[k + 1]!))
    ) {
      k++;
    }
    const closed = isConfirmedBoundary(lines, k, done);
    if (!closed) {
      // The actively-growing last paragraph: raw until a blank line or turn
      // end, so its inline spans never reflow mid-stream.
      rawTail(i);
      return blocks;
    }
    blocks.push({ type: "paragraph", spans: tokenizeInline(lines.slice(i, k).join("\n")) });
    i = k;
  }

  return blocks;
}

/** Build a `quote` block from its raw `>`-prefixed lines: strip the prefix from
 * each, then check whether the LAST stripped line is an attribution (F22's
 * turn-ref line) — if so it's excluded from `text` and parsed into `ref`;
 * otherwise the whole thing is a plain blockquote (`ref: null`). */
function buildQuoteBlock(quoteLines: string[]): Extract<MessageBlock, { type: "quote" }> {
  const stripped = quoteLines.map((l) => QUOTE_LINE_RE.exec(l)![1]!);
  const last = stripped[stripped.length - 1] ?? "";
  const m = stripped.length > 1 ? QUOTE_REF_RE.exec(last) : null;
  if (m) {
    return {
      type: "quote",
      text: stripped.slice(0, -1).join("\n"),
      ref: { mention: m[1]!, kind: m[2] as "result" | "turn", ts: m[3]! },
    };
  }
  return { type: "quote", text: stripped.join("\n"), ref: null };
}

/** F22 (W24) — split a SENT message's LEADING `>` blockquote (if any) from the
 * rest, for a caller that renders a quote-reply specially without routing the
 * WHOLE message through the general block parser — TranscriptPanel's user-
 * turn renderer stays plain-text/paragraphs otherwise (a user message getting
 * full markdown formatting — tables, bold, etc — is out of F22's scope; only
 * the quote-reply's own attributed blockquote needs the rich excerpt-block
 * treatment). Returns null when `text` doesn't start with a blockquote line
 * at all, so the caller's existing plain-text path is untouched. */
export function splitLeadingQuote(text: string): { quote: Extract<MessageBlock, { type: "quote" }>; rest: string } | null {
  const lines = text.split("\n");
  if (lines.length === 0 || !isQuoteLine(lines[0]!)) return null;
  let k = 0;
  while (k < lines.length && isQuoteLine(lines[k]!)) k++;
  const quote = buildQuoteBlock(lines.slice(0, k));
  // The encoder always separates the quote from the reply with ONE blank
  // line (Composer.tsx's `${quotedPrefix}\n\n${text}`) — skip it if present.
  const restStart = k < lines.length && isBlank(lines[k]!) ? k + 1 : k;
  return { quote, rest: lines.slice(restStart).join("\n") };
}

// UI-QUOTE-COLLAPSE — an embedded excerpt is bounded so quoting a huge
// message (e.g. a long research dump) doesn't duplicate it wholesale into the
// sent message/DB record. The renderer's own QuoteBlock collapses the visual
// presentation further (to ~2-3 lines) regardless of this wire-level cap; the
// backlink is how a reader reaches the untruncated source, not a bigger embed.
const QUOTE_EXCERPT_MAX_LINES = 40;
const QUOTE_EXCERPT_MAX_CHARS = 4000;

function boundQuoteExcerpt(text: string): string {
  const rawLines = text.split("\n");
  const clippedByLines = rawLines.length > QUOTE_EXCERPT_MAX_LINES;
  let body = clippedByLines ? rawLines.slice(0, QUOTE_EXCERPT_MAX_LINES).join("\n") : text;
  const clippedByChars = body.length > QUOTE_EXCERPT_MAX_CHARS;
  if (clippedByChars) body = body.slice(0, QUOTE_EXCERPT_MAX_CHARS);
  if (!clippedByLines && !clippedByChars) return text;
  return `${body}\n[…truncated, ${rawLines.length} lines total]`;
}

/** F22 (W24) — encode a quote-reply's excerpt + attribution as the SAME `>`
 * blockquote shape buildQuoteBlock parses back. Pure/reversible-by-design: any
 * client sees legible markdown (no wire/daemon change needed), the Tauri
 * renderer lifts a matching ref back into a clickable excerpt block. */
export function encodeQuoteBlock(excerpt: string, mention: string, kind: "result" | "turn", ts: string): string {
  const lines = boundQuoteExcerpt(excerpt).split("\n").map((l) => `> ${l}`);
  lines.push(`> — @${mention} · ${kind} · ${ts}`);
  return lines.join("\n");
}

/** Build a table block from its raw lines (header, separator, rows). Falls back
 * to a code block when the header exceeds MAX_TABLE_COLS (F12: wide → code). */
function buildTable(tableLines: string[]): MessageBlock {
  const headers = splitPipeRow(tableLines[0]!);
  if (headers.length > MAX_TABLE_COLS) {
    return { type: "code", lang: null, text: tableLines.join("\n") };
  }
  const cols = headers.length;
  const rows = tableLines.slice(2).map((l) => {
    const cells = splitPipeRow(l);
    // normalize every row to the header width (pad short, drop overflow)
    const out = cells.slice(0, cols);
    while (out.length < cols) out.push("");
    return out;
  });
  // A column is right-aligned when every non-empty data cell is numeric (the
  // F12 "numeric columns right-aligned" rule — content-derived, not colon-tag).
  const align: ColumnAlign[] = headers.map((_, c) => {
    const cells = rows.map((r) => r[c] ?? "").filter((v) => v !== "");
    return cells.length > 0 && cells.every((v) => NUMERIC_RE.test(v)) ? "right" : "left";
  });
  return {
    type: "table",
    headers: headers.map((h) => tokenizeInline(h)),
    align,
    rows: rows.map((r) => r.map((c) => tokenizeInline(c))),
  };
}
