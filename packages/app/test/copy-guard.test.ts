import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, relative } from "node:path";

// F11 (W11) — CI copy guards, enforced by the test suite (the plan's hex guard
// had only ever been a documented rg; this file makes BOTH machine-checked).
//
//   1. English-only guard — no non-ASCII LETTER may appear in user-facing code
//      or string content. Glyphs / box-drawing / symbols (◆ ⇅ ▪ ◐ ─ ╭ · → ↑↓ …)
//      are NOT letters, so they pass a Unicode-letter test — no whitelist.
//      Comments are exempt: they are dev prose, not shipped copy.
//   2. Hex guard — no literal color hex outside src/styles/tokens.css; the app
//      is token-only (var(--…)). Comments exempt.
//
// Both walk packages/app/src only (test fixtures live under test/, so they are
// never scanned) and share one comment-masking scanner.

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TOKENS = join(SRC, "styles", "tokens.css");
const EXTS = new Set([".ts", ".tsx", ".css"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (EXTS.has(extname(full))) out.push(full);
  }
  return out;
}

/** Blank out comment bytes (→ spaces, newlines preserved) while KEEPING string
 * and code content — user-facing copy lives in strings, so those must be
 * scanned; only comments are dev-only and exempt. A tiny char state machine:
 * .css has no `//` line comments and no template literals. */
function maskComments(src: string, ext: string): string {
  const css = ext === ".css";
  let out = "";
  let state: "normal" | "block" | "line" | "dq" | "sq" | "tmpl" = "normal";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "normal") {
      if (c === "/" && c2 === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (!css && c === "/" && c2 === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === '"') { state = "dq"; out += c; i++; continue; }
      if (c === "'") { state = "sq"; out += c; i++; continue; }
      if (!css && c === "`") { state = "tmpl"; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "normal"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "normal"; out += "\n"; i++; continue; }
      out += " "; i++; continue;
    }
    // inside a string / template
    const quote = state === "dq" ? '"' : state === "sq" ? "'" : "`";
    if (c === "\\") { out += c + (src[i + 1] ?? ""); i += 2; continue; }
    if (c === quote) { state = "normal"; out += c; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

function locate(masked: string, index: number): string {
  const before = masked.slice(0, index);
  const line = before.split("\n").length;
  const col = index - before.lastIndexOf("\n");
  return `${line}:${col}`;
}

const LETTER = /\p{L}/u;

describe("F11 English-only copy guard", () => {
  it("no non-ASCII letters in shipped strings/code across packages/app/src", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const masked = maskComments(readFileSync(file, "utf8"), extname(file));
      let idx = 0;
      for (const ch of masked) {
        const cp = ch.codePointAt(0)!;
        if (cp > 127 && LETTER.test(ch)) {
          offenders.push(`${relative(SRC, file)}:${locate(masked, idx)} — ${JSON.stringify(ch)}`);
        }
        idx += ch.length;
      }
    }
    expect(offenders, `non-English letters found:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("token-only hex guard", () => {
  it("no literal color hex outside src/styles/tokens.css", () => {
    const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === TOKENS) continue;
      const masked = maskComments(readFileSync(file, "utf8"), extname(file));
      let m: RegExpExecArray | null;
      hex.lastIndex = 0;
      while ((m = hex.exec(masked)) !== null) {
        offenders.push(`${relative(SRC, file)}:${locate(masked, m.index)} — ${m[0]}`);
      }
    }
    expect(offenders, `literal hex found (use var(--…)):\n${offenders.join("\n")}`).toEqual([]);
  });
});
