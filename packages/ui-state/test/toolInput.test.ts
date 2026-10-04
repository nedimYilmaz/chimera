import { describe, it, expect } from "vitest";
import { analyzeToolInput, toolInputPreviewText } from "../src/toolInput.js";

// PERMISSION-CARD-READABILITY: analyzeToolInput turns a raw tool-call input
// into a human-readable rendering plan -- no JSON syntax (braces, quoted
// keys, escaped "\n"/"\"") in the common ("rows"/"listing") case. The exact
// JSON.stringify ground truth stays available separately (callers' own
// mod+e / ctrl+e raw path) -- this module never needs to reproduce it except
// as the last-resort "json" fallback below.

const BASH_INPUT = {
  command:
    'cd /Users/alice/Documents/acmecorp/PROJ-10483/terraform-aws\n'
    + 'gh pr comment 4584 -R acmecorp/terraform-aws --body "atlantis plan" >/dev/null 2>&1\n'
    + 'BEFORE=$(gh pr view 4584 -R acmecorp/terraform-aws --json comments '
    + `-q '[.comments[]|select(.author.login=="acmecorp-atlantis")]|length')\n`
    + 'until [ "$(gh pr view 4584 -R acmecorp/terraform-aws --json comments '
    + `-q '[.comments[]|select(.author.login=="acmecorp-atlantis")]|length')" -gt "$BEFORE" ]; do sleep 15; done`,
  description: "Retry Atlantis plan",
  timeout: 480000,
};

describe("analyzeToolInput: structured object (Bash shape)", () => {
  const view = analyzeToolInput(BASH_INPUT);

  it("returns rows, description leading, command as the primary row", () => {
    expect(view.kind).toBe("rows");
    if (view.kind !== "rows") throw new Error("unreachable");
    expect(view.rows[0]).toEqual({ kind: "summary", text: "Retry Atlantis plan" });
    expect(view.rows[1].kind).toBe("primary");
  });

  it("the command text is VERBATIM -- real newlines preserved, no escaping introduced", () => {
    if (view.kind !== "rows") throw new Error("unreachable");
    const primary = view.rows.find((r) => r.kind === "primary");
    expect(primary && "text" in primary ? primary.text : "").toBe(BASH_INPUT.command);
  });

  it("humanizes an exact-division timeout to a clean unit, keeping it a meta row (not JSON)", () => {
    if (view.kind !== "rows") throw new Error("unreachable");
    const meta = view.rows.find((r) => r.kind === "meta");
    expect(meta).toEqual({ kind: "meta", label: "timeout", text: "8m" });
  });

  it("never humanizes a timeout that doesn't divide exactly (fidelity over prettiness)", () => {
    const v = analyzeToolInput({ command: "x", timeout: 480001 });
    if (v.kind !== "rows") throw new Error("unreachable");
    const meta = v.rows.find((r) => r.kind === "meta");
    expect(meta).toEqual({ kind: "meta", label: "timeout", text: "480001" });
  });
});

describe("analyzeToolInput: other read-me string fields", () => {
  it("a non-primary string field becomes a labeled text row, verbatim", () => {
    const v = analyzeToolInput({ file_path: "/a/b.ts", old_string: "foo", new_string: "bar" });
    if (v.kind !== "rows") throw new Error("unreachable");
    expect(v.rows).toContainEqual({ kind: "text", label: "file path", text: "/a/b.ts" });
    expect(v.rows).toContainEqual({ kind: "text", label: "old string", text: "foo" });
    expect(v.rows).toContainEqual({ kind: "text", label: "new string", text: "bar" });
  });
});

describe("analyzeToolInput: nested / unusual shapes render safely, no crash, no JSON punctuation", () => {
  it("a nested object/array field becomes a readable listing, not JSON", () => {
    const v = analyzeToolInput({ command: "run", env: { FOO: "1", BAR: "2" }, files: ["a.ts", "b.ts"] });
    if (v.kind !== "rows") throw new Error("unreachable");
    const env = v.rows.find((r) => r.kind === "nested" && r.label === "env");
    expect(env && "lines" in env ? env.lines : []).toEqual(["FOO: 1", "BAR: 2"]);
    const files = v.rows.find((r) => r.kind === "nested" && r.label === "files");
    expect(files && "lines" in files ? files.lines : []).toEqual(["- a.ts", "- b.ts"]);
    const joined = v.rows.flatMap((r) => ("lines" in r ? r.lines : "text" in r ? [r.text] : []) as string[]).join("\n");
    expect(joined).not.toMatch(/[{}]|":/);
  });

  it("a top-level array input renders as a readable listing (not JSON)", () => {
    const v = analyzeToolInput(["one", "two"]);
    expect(v.kind).toBe("listing");
    if (v.kind !== "listing") throw new Error("unreachable");
    expect(v.lines).toEqual(["- one", "- two"]);
  });

  it("a top-level string input is a single verbatim primary row", () => {
    const v = analyzeToolInput("plain string input");
    expect(v).toEqual({ kind: "rows", rows: [{ kind: "primary", text: "plain string input" }] });
  });

  it("null/undefined input renders as empty rows, never crashes", () => {
    expect(analyzeToolInput(null)).toEqual({ kind: "rows", rows: [] });
    expect(analyzeToolInput(undefined)).toEqual({ kind: "rows", rows: [] });
  });

  it("falls back to a safe non-blank string (never crashes) when even a readable listing throws", () => {
    // A throwing getter defeats analyzeToolInput's own entry-walk AND
    // JSON.stringify (both enumerate the same property) -- the true
    // "nothing works" case. It must still resolve to "json" kind with
    // non-empty text, never throw out of analyzeToolInput and never blank.
    const poisoned: Record<string, unknown> = {};
    Object.defineProperty(poisoned, "boom", {
      enumerable: true,
      get() { throw new Error("nope"); },
    });
    let v: ReturnType<typeof analyzeToolInput> | undefined;
    expect(() => { v = analyzeToolInput(poisoned); }).not.toThrow();
    expect(v?.kind).toBe("json");
    if (v?.kind !== "json") throw new Error("unreachable");
    expect(v.text.length).toBeGreaterThan(0);
  });
});

describe("toolInputPreviewText: single unescaped line", () => {
  it("collapses the primary field's real newlines to spaces, no JSON escaping", () => {
    const preview = toolInputPreviewText(BASH_INPUT);
    expect(preview).not.toContain("\n");
    expect(preview).not.toContain("\\n");
    expect(preview.startsWith("cd /Users/alice/Documents/acmecorp/PROJ-10483/terraform-aws gh pr comment")).toBe(true);
  });
});
