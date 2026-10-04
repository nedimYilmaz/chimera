// PERMISSION-CARD-READABILITY: turns a tool call's raw `input` into a plan for
// a HUMAN-READABLE rendering — no JSON syntax (braces, quoted keys, escaped
// "\n"/"\"") in the common case. Both the app (DOM) and tui (Ink) permission
// cards render from this SAME pure derivation, so "what does this command
// actually say" reads the same on both surfaces. It never touches the exact
// JSON.stringify ground truth the mod+e / ctrl+e raw view still shows —
// callers keep using their own formatToolInput-equivalent for that.
//
// This function must NEVER throw past its own boundary and must NEVER drop
// content: every string value the input carries ends up verbatim in some row
// or listing line, un-escaped but NOT reformatted (a real newline replaces a
// literal `\n`; the characters inside a line are never rewritten).

export type ToolInputRow =
  | { kind: "summary"; text: string }
  | { kind: "primary"; text: string }
  | { kind: "text"; label: string; text: string }
  | { kind: "nested"; label: string; lines: string[] }
  | { kind: "meta"; label: string; text: string };

export type ToolInputView =
  | { kind: "rows"; rows: ToolInputRow[] }
  | { kind: "listing"; lines: string[] }
  | { kind: "json"; text: string };

// The tool-input fields that ARE the thing being approved, not metadata about
// it — Bash's `command` leads and gets the most visual weight. Every other
// string field still renders as real, un-escaped text (never JSON-escaped),
// just without the extra emphasis (audited against the real Bash/Read/Write/
// Edit/Grep/Glob/WebFetch tool shapes; new/unknown tools still render safely
// via the plain "text" row path, so nothing needs to be added here to stay
// safe — this set only controls visual WEIGHT, not visibility).
const PRIMARY_KEYS = new Set(["command"]);

function humanizeLabel(key: string): string {
  return key.replace(/_/g, " ");
}

// Only collapses a scalar to a friendlier unit when the collapse is EXACT
// (no rounding) — a value whose precision matters (e.g. a 480001ms timeout)
// is never misrepresented, it just doesn't get the shorthand.
function humanizeScalar(key: string, value: number | boolean | null): string {
  if (typeof value === "number" && /timeout/i.test(key) && value > 0) {
    if (value % 60_000 === 0) return `${value / 60_000}m`;
    if (value % 1_000 === 0) return `${value / 1_000}s`;
  }
  return String(value);
}

const MAX_LISTING_DEPTH = 8;

// A readable "key: value" / "- item" listing with NO JSON punctuation — the
// fallback tier for values we don't have a specific field rule for (nested
// objects/arrays, or a whole input that isn't a plain object).
function listingLines(value: unknown, depth: number): string[] {
  if (depth > MAX_LISTING_DEPTH) return [String(value)];
  if (value === null || value === undefined) return ["(none)"];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) {
    if (value.length === 0) return ["(empty)"];
    return value.flatMap((item) => {
      const sub = listingLines(item, depth + 1);
      return sub.map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`));
    });
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return ["(empty)"];
    return entries.flatMap(([k, v]) => {
      const sub = listingLines(v, depth + 1);
      if (sub.length === 1) return [`${humanizeLabel(k)}: ${sub[0]}`];
      return [`${humanizeLabel(k)}:`, ...sub.map((line) => `  ${line}`)];
    });
  }
  return [String(value)];
}

function safeJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const ROW_RANK: Record<ToolInputRow["kind"], number> = {
  summary: 0, primary: 1, text: 2, nested: 3, meta: 4,
};

export function analyzeToolInput(input: unknown): ToolInputView {
  try {
    if (typeof input === "string") {
      return { kind: "rows", rows: [{ kind: "primary", text: input }] };
    }
    if (input === null || input === undefined) {
      return { kind: "rows", rows: [] };
    }
    if (Array.isArray(input) || typeof input !== "object") {
      // A whole non-object input (array, number, boolean) has no field
      // structure to key off of — render it as a readable listing rather
      // than pretending it has labeled fields.
      return { kind: "listing", lines: listingLines(input, 0) };
    }
    const obj = input as Record<string, unknown>;
    const rows: ToolInputRow[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (key === "description" && typeof value === "string") {
        rows.push({ kind: "summary", text: value });
      } else if (typeof value === "string") {
        rows.push(PRIMARY_KEYS.has(key)
          ? { kind: "primary", text: value }
          : { kind: "text", label: humanizeLabel(key), text: value });
      } else if (value === null || typeof value === "number" || typeof value === "boolean") {
        rows.push({ kind: "meta", label: humanizeLabel(key), text: humanizeScalar(key, value) });
      } else {
        rows.push({ kind: "nested", label: humanizeLabel(key), lines: listingLines(value, 1) });
      }
    }
    // Stable sort: summary leads, then the primary payload (command), then
    // other text fields, then nested listings, then quiet metadata chips —
    // ties keep the original key order.
    rows.sort((a, b) => ROW_RANK[a.kind] - ROW_RANK[b.kind]);
    return { kind: "rows", rows };
  } catch {
    // A pathological input (a throwing getter, etc.) — the one case where
    // even the readable listing isn't possible. Exact pretty JSON, never blank.
    return { kind: "json", text: safeJson(input) };
  }
}

/** A single unescaped line for compact previews (e.g. the TUI's collapsed
 * banner) — the best "read me" text the input carries, real characters, no
 * JSON escaping, collapsed to one line since a preview has no room to wrap. */
export function toolInputPreviewText(input: unknown): string {
  const view = analyzeToolInput(input);
  let text: string;
  if (view.kind === "json") text = view.text;
  else if (view.kind === "listing") text = view.lines.join(" ");
  else {
    // Prefer the actual payload (command/content/...) over the human summary
    // for this compact single-line preview -- the summary already sits
    // beside the tool name in the same banner, so the preview's job is to
    // hint at WHAT runs, not restate why.
    const row = view.rows.find((r) => r.kind === "primary")
      ?? view.rows.find((r) => r.kind === "text")
      ?? view.rows.find((r) => r.kind === "summary");
    text = row && "text" in row ? row.text : "";
  }
  return text.replace(/\s+/g, " ").trim();
}
