import { describe, it, expect } from "vitest";
import {
  FsListParams,
  FsListResult,
  FsReadParams,
  FsReadResult,
} from "@chimera/protocol";

// FILEBROWSER-T1: fs.list/fs.read params + result shapes for the app's file-browser
// panel. `path` is relative to the project root ("" = root); strict on unknown keys.

describe("FsListParams", () => {
  it("parses project + root path", () => {
    expect(FsListParams.parse({ project: "p1", path: "" })).toEqual({ project: "p1", path: "" });
  });

  it("parses a nested relative path", () => {
    expect(FsListParams.parse({ project: "p1", path: "src/lib" })).toEqual({ project: "p1", path: "src/lib" });
  });

  it("rejects an empty project, a missing path, and extra keys (strict)", () => {
    expect(() => FsListParams.parse({ project: "", path: "" })).toThrow();
    expect(() => FsListParams.parse({ project: "p1" })).toThrow();
    expect(() => FsListParams.parse({ project: "p1", path: "", bogus: 1 })).toThrow();
  });
});

describe("FsListResult", () => {
  it("parses a full listing with all entry kinds and git statuses", () => {
    const result = FsListResult.parse({
      path: "src",
      entries: [
        { name: "index.ts", kind: "file", sizeBytes: 1234, gitStatus: "modified" },
        { name: "lib", kind: "dir", sizeBytes: null, gitStatus: null },
        { name: "link", kind: "symlink", sizeBytes: 0, gitStatus: "untracked" },
        { name: "build", kind: "dir", sizeBytes: null, gitStatus: "ignored" },
        { name: "staged.ts", kind: "file", sizeBytes: 10, gitStatus: "staged" },
      ],
      truncated: false,
    });
    expect(result.entries).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it("parses an empty listing", () => {
    expect(FsListResult.parse({ path: "", entries: [], truncated: false })).toEqual({
      path: "", entries: [], truncated: false,
    });
  });

  it("rejects an invalid entry kind/gitStatus, a negative sizeBytes, and extra keys (strict)", () => {
    const base = { path: "", truncated: false };
    expect(() => FsListResult.parse({ ...base, entries: [{ name: "a", kind: "bogus", sizeBytes: null, gitStatus: null }] })).toThrow();
    expect(() => FsListResult.parse({ ...base, entries: [{ name: "a", kind: "file", sizeBytes: null, gitStatus: "bogus" }] })).toThrow();
    expect(() => FsListResult.parse({ ...base, entries: [{ name: "a", kind: "file", sizeBytes: -1, gitStatus: null }] })).toThrow();
    expect(() => FsListResult.parse({ ...base, entries: [], bogus: true })).toThrow();
    expect(() => FsListResult.parse({ ...base, entries: [{ name: "a", kind: "file", sizeBytes: null, gitStatus: null, bogus: 1 }] })).toThrow();
  });
});

describe("FsReadParams", () => {
  it("parses without maxBytes and with it", () => {
    expect(FsReadParams.parse({ project: "p1", path: "a.txt" })).toEqual({ project: "p1", path: "a.txt" });
    expect(FsReadParams.parse({ project: "p1", path: "a.txt", maxBytes: 4096 })).toEqual({
      project: "p1", path: "a.txt", maxBytes: 4096,
    });
  });

  it("rejects an empty project, a non-positive maxBytes, and extra keys (strict)", () => {
    expect(() => FsReadParams.parse({ project: "", path: "a.txt" })).toThrow();
    expect(() => FsReadParams.parse({ project: "p1", path: "a.txt", maxBytes: 0 })).toThrow();
    expect(() => FsReadParams.parse({ project: "p1", path: "a.txt", maxBytes: -1 })).toThrow();
    expect(() => FsReadParams.parse({ project: "p1", path: "a.txt", bogus: 1 })).toThrow();
  });
});

describe("FsReadResult", () => {
  it("parses a utf8 text result", () => {
    const result = FsReadResult.parse({
      path: "a.txt", encoding: "utf8", content: "hello", sizeBytes: 5, binary: false, mediaType: "text/plain", truncated: false,
    });
    expect(result.encoding).toBe("utf8");
    expect(result.mediaType).toBe("text/plain");
  });

  it("parses a base64 binary result with a null mediaType", () => {
    const result = FsReadResult.parse({
      path: "img.bin", encoding: "base64", content: "AAAA", sizeBytes: 3, binary: true, mediaType: null, truncated: true,
    });
    expect(result.binary).toBe(true);
    expect(result.mediaType).toBeNull();
  });

  it("rejects an invalid encoding, a negative sizeBytes, and extra keys (strict)", () => {
    const base = { path: "a.txt", content: "x", sizeBytes: 1, binary: false, mediaType: null, truncated: false };
    expect(() => FsReadResult.parse({ ...base, encoding: "utf16" })).toThrow();
    expect(() => FsReadResult.parse({ ...base, encoding: "utf8", sizeBytes: -1 })).toThrow();
    expect(() => FsReadResult.parse({ ...base, encoding: "utf8", bogus: true })).toThrow();
  });
});
