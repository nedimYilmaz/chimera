import { describe, it, expect } from "vitest";
import { looksLikeFileRef } from "../src/components/PathLink";

// CODE-CHIP-PATHS — a path written the way people actually write one, in backticks. Markdown makes
// that inline CODE, and the parser's path detection only runs over plain text, so a backticked path
// arrived as an unclickable chip while the same path unquoted became a link. Backwards: the
// backticked form is the correct way to write it.
//
// This filter is the cost control. Inline code is the most common span in a technical transcript —
// every `foo()`, `--flag` and `null` — and resolving each one would be a daemon request per chip
// per message. A chip only earns a lookup if it is shaped like a file reference at all.

describe("looksLikeFileRef", () => {
  it("accepts the shapes people write paths in", () => {
    for (const t of [
      "PROJ-5678/tasks/",
      "tasks/T03-kraken.md",
      "packages/app/src/components/PathLink.tsx",
      "./scripts/setup.mjs",
      "~/notes/todo.md",
      "README.md",
      "Dockerfile.prod",
    ]) {
      expect(looksLikeFileRef(t), t).toBe(true);
    }
  });

  it("rejects ordinary inline code, which is most of what it sees", () => {
    for (const t of [
      "foo()", "--strict-mcp-config", "null", "npm run build", "Array<string>",
      "a, b", "obj[key]", "{ id }", "`nested`", "a|b", "x ? y : z",
    ]) {
      expect(looksLikeFileRef(t), t).toBe(false);
    }
  });

  it("rejects a bare word with no extension and no directory", () => {
    // There is nothing to resolve it against, so a lookup would always miss — the request would be
    // spent to learn nothing.
    expect(looksLikeFileRef("medusa-integration")).toBe(false);
    expect(looksLikeFileRef("StandardStorage")).toBe(false);
  });

  it("rejects a URL — that is already a link, and reading it as a path is a wasted request", () => {
    expect(looksLikeFileRef("https://acmecorp.atlassian.net/browse/PROJ-5678")).toBe(false);
    expect(looksLikeFileRef("file:///tmp/x.md")).toBe(false);
  });

  it("rejects anything with whitespace, and anything absurdly long", () => {
    expect(looksLikeFileRef("some file.md")).toBe(false);
    expect(looksLikeFileRef("a/".repeat(150) + "x.md")).toBe(false);
    expect(looksLikeFileRef("")).toBe(false);
    expect(looksLikeFileRef("   ")).toBe(false);
  });

  it("accepts a version-ish string only when it is plausibly a filename", () => {
    // "v1.2" has an extension-shaped tail and no slash — it passes the SHAPE filter and is then
    // rejected by resolution, which is the correct division of labour: this filter's job is to
    // avoid pointless requests, not to be the authority on what a file is.
    expect(looksLikeFileRef("v1.2")).toBe(true);
    // but something with punctuation that cannot appear in a normal path is rejected outright
    expect(looksLikeFileRef("v1.2(beta)")).toBe(false);
  });
});
