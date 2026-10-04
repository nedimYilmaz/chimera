import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, readFile, expandHome, readAtWidenedRoot, FS_LIST_MAX_ENTRIES, FS_READ_MAX_BYTES, FileTooLargeError } from "@chimera/core/fsbrowse";
import { ARTIFACT_MAX_BYTES } from "@chimera/core/artifacts";
import { ProjectPathError } from "@chimera/core/projects";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";

// FILEBROWSER-T2: fs.list's directory-listing engine (fsbrowse.ts) — the
// realpath-both-sides escape guard, the FS_LIST_MAX_ENTRIES cap, and the
// git-status annotation pass, plus the fs.list RPC wiring on a real Engine.

// CORE-SUITE-BASELINE: the git-status annotation pass shells out to real `git` — under
// this machine's concurrent-agent load that can exceed vitest's 5000ms default; widened
// per existing precedent (supervisor-crash-loop.test.ts).
vi.setConfig({ testTimeout: 20_000 });

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "chimera-fsbrowse-"));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init", "--no-gpg-sign");
}

describe("listDir", () => {
  it("lists files and dirs under the project with sizes and kinds", () => {
    const root = makeProject();
    writeFileSync(join(root, "a.txt"), "hello");
    mkdirSync(join(root, "sub"));
    const result = listDir(root, "");
    expect(result.truncated).toBe(false);
    const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
    expect(byName["a.txt"]).toMatchObject({ kind: "file", sizeBytes: 5, gitStatus: null });
    expect(byName["sub"]).toMatchObject({ kind: "dir", sizeBytes: null, gitStatus: null });
  });

  it("lists a nested relative path", () => {
    const root = makeProject();
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "x.ts"), "x");
    const result = listDir(root, "src/lib");
    expect(result.path).toBe("src/lib");
    expect(result.entries).toEqual([{ name: "x.ts", kind: "file", sizeBytes: 1, gitStatus: null }]);
  });

  it("refuses a ../ escape", () => {
    const root = makeProject();
    mkdirSync(join(root, "inner"));
    expect(() => listDir(join(root, "inner"), "../../etc")).toThrow(ProjectPathError);
  });

  it("refuses an absolute path outside the project", () => {
    const root = makeProject();
    expect(() => listDir(root, "/etc")).toThrow(ProjectPathError);
  });

  it("refuses a symlink that resolves outside the project root", () => {
    const root = makeProject();
    const outside = makeProject();
    writeFileSync(join(outside, "secret.txt"), "shh");
    symlinkSync(outside, join(root, "escape"));
    expect(() => listDir(root, "escape")).toThrow(ProjectPathError);
  });

  it("reports a missing target as a clean ProjectPathError, not a raw ENOENT", () => {
    const root = makeProject();
    expect(() => listDir(root, "nope")).toThrow(ProjectPathError);
  });

  it("does not confuse a sibling whose name prefixes the root (boundary confusion: /a/bc vs /a/b)", () => {
    const base = makeProject();
    const root = join(base, "a", "b");
    const sibling = join(base, "a", "bc");
    mkdirSync(root, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.txt"), "shh");
    // A naive `child.startsWith(parent)` guard (no trailing-slash boundary) would
    // wrongly treat ".../a/bc" as nested under ".../a/b" since the raw string "b"
    // prefixes "bc" — isPathUnder must require the "/" boundary to reject this.
    expect(() => listDir(root, "../bc")).toThrow(ProjectPathError);
  });

  it("caps the listing at FS_LIST_MAX_ENTRIES and sets truncated", () => {
    const root = makeProject();
    for (let i = 0; i < FS_LIST_MAX_ENTRIES + 5; i++) writeFileSync(join(root, `f${i}`), "");
    const result = listDir(root, "");
    expect(result.entries).toHaveLength(FS_LIST_MAX_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it("annotates gitStatus for modified, staged, untracked, and ignored entries", () => {
    const root = makeProject();
    initRepo(root);
    writeFileSync(join(root, "tracked.txt"), "v1");
    git(root, "add", "tracked.txt");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add tracked", "--no-gpg-sign");
    writeFileSync(join(root, "tracked.txt"), "v2");              // modified (unstaged)
    writeFileSync(join(root, "loose.txt"), "u");                 // untracked
    writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
    git(root, "add", ".gitignore");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "add gitignore", "--no-gpg-sign");
    writeFileSync(join(root, "ignored.txt"), "i");                // ignored
    writeFileSync(join(root, "staged.txt"), "s");
    git(root, "add", "staged.txt");                              // staged, committed nowhere

    const result = listDir(root, "");
    const byName = Object.fromEntries(result.entries.map((e) => [e.name, e.gitStatus]));
    expect(byName["tracked.txt"]).toBe("modified");
    expect(byName["staged.txt"]).toBe("staged");
    expect(byName["loose.txt"]).toBe("untracked");
    expect(byName["ignored.txt"]).toBe("ignored");
  });

  it("degrades to null gitStatus (never throws) for a non-git project", () => {
    const root = makeProject();
    writeFileSync(join(root, "a.txt"), "x");
    const result = listDir(root, "");
    expect(result.entries).toEqual([{ name: "a.txt", kind: "file", sizeBytes: 1, gitStatus: null }]);
  });
});

describe("readFile", () => {
  it("reads a text file as utf8", () => {
    const root = makeProject();
    writeFileSync(join(root, "a.txt"), "hello world");
    const result = readFile(root, "a.txt");
    expect(result).toEqual({ path: "a.txt", encoding: "utf8", content: "hello world", sizeBytes: 11, binary: false, mediaType: null, truncated: false });
  });

  it("truncates text content over FS_READ_MAX_BYTES and sets truncated", () => {
    const root = makeProject();
    const big = "x".repeat(FS_READ_MAX_BYTES + 10);
    writeFileSync(join(root, "big.txt"), big);
    const result = readFile(root, "big.txt");
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(FS_READ_MAX_BYTES);
    expect(result.sizeBytes).toBe(FS_READ_MAX_BYTES + 10);
    expect(result.binary).toBe(false);
  });

  it("refuses a file over the ARTIFACT_MAX_BYTES hard cap", () => {
    const root = makeProject();
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(ARTIFACT_MAX_BYTES + 1));
    expect(() => readFile(root, "huge.bin")).toThrow(FileTooLargeError);
  });

  it("detects a PNG as an image and returns base64 content + mediaType", () => {
    const root = makeProject();
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = Buffer.concat([pngMagic, Buffer.from([0, 1, 2, 3, 4, 5])]);
    writeFileSync(join(root, "pic.png"), png);
    const result = readFile(root, "pic.png");
    expect(result.binary).toBe(true);
    expect(result.mediaType).toBe("image/png");
    expect(result.encoding).toBe("base64");
    expect(result.content).toBe(png.toString("base64"));
    expect(result.truncated).toBe(false);
  });

  it("detects a random binary as binary:true with empty content", () => {
    const root = makeProject();
    const bin = Buffer.from([0x01, 0x02, 0x00, 0x03, 0x04, 0xff, 0xfe]);
    writeFileSync(join(root, "data.bin"), bin);
    const result = readFile(root, "data.bin");
    expect(result.binary).toBe(true);
    expect(result.mediaType).toBeNull();
    expect(result.content).toBe("");
    expect(result.sizeBytes).toBe(bin.length);
  });

  it("refuses a ../ escape, an absolute-outside path, and a symlink-out, same as listDir", () => {
    const root = makeProject();
    const outside = makeProject();
    writeFileSync(join(outside, "secret.txt"), "shh");
    mkdirSync(join(root, "inner"));
    symlinkSync(outside, join(root, "escape"));
    expect(() => readFile(join(root, "inner"), "../../etc/passwd")).toThrow(ProjectPathError);
    expect(() => readFile(root, "/etc/passwd")).toThrow(ProjectPathError);
    expect(() => readFile(root, "escape/secret.txt")).toThrow(ProjectPathError);
  });

  it("does not confuse a sibling whose name prefixes the root (boundary confusion: /a/bc vs /a/b)", () => {
    const base = makeProject();
    const nestedRoot = join(base, "a", "b");
    const sibling = join(base, "a", "bc");
    mkdirSync(nestedRoot, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.txt"), "shh");
    expect(() => readFile(nestedRoot, "../bc/secret.txt")).toThrow(ProjectPathError);
  });
});

// PATH-LINK-TILDE-AND-SCOPE
describe("expandHome", () => {
  it("expands a bare ~ to the given home dir", () => {
    expect(expandHome("~", "/Users/alice")).toBe("/Users/alice");
  });

  it("expands ~/... against the given home dir", () => {
    expect(expandHome("~/Documents/x.md", "/Users/alice")).toBe("/Users/alice/Documents/x.md");
  });

  it("refuses ~user/... (some OTHER user's home) — returns null, not a guess", () => {
    expect(expandHome("~bob/Documents/x.md", "/Users/alice")).toBeNull();
  });

  it("passes an already-absolute path through unchanged", () => {
    expect(expandHome("/etc/passwd", "/Users/alice")).toBe("/etc/passwd");
  });
});

describe("readAtWidenedRoot", () => {
  it("reads a ~-path that resolves under one of the given roots", () => {
    const home = makeProject();
    mkdirSync(join(home, "Documents", "acmecorp"), { recursive: true });
    writeFileSync(join(home, "Documents", "acmecorp", "report.md"), "hi");
    const importDir = join(home, "Documents", "acmecorp");
    const result = readAtWidenedRoot("~/Documents/acmecorp/report.md", [importDir], home);
    expect(result).toMatchObject({ content: "hi", binary: false });
    // the FULL expanded path is reported back (display value), not a root-relative one.
    expect(result.path).toBe(join(home, "Documents", "acmecorp", "report.md"));
  });

  it("reads a plain absolute path (no tilde) under one of the given roots", () => {
    const importDir = makeProject();
    writeFileSync(join(importDir, "report.md"), "hi");
    const result = readAtWidenedRoot(join(importDir, "report.md"), [importDir], "/Users/alice");
    expect(result.content).toBe("hi");
  });

  it("tries every given root in turn, first match wins", () => {
    const rootA = makeProject();
    const rootB = makeProject();
    writeFileSync(join(rootB, "only-in-b.md"), "b");
    const result = readAtWidenedRoot(join(rootB, "only-in-b.md"), [rootA, rootB], "/Users/alice");
    expect(result.content).toBe("b");
  });

  it("REFUSES a ~-path outside every given root (e.g. ~/.ssh/id_rsa) — never widens to the whole home dir", () => {
    const home = makeProject();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), "secret");
    const importDir = join(home, "Documents", "acmecorp");
    mkdirSync(importDir, { recursive: true });
    expect(() => readAtWidenedRoot("~/.ssh/id_rsa", [importDir], home)).toThrow(ProjectPathError);
  });

  it("refuses ~user/... even when a root would otherwise contain it", () => {
    const home = makeProject();
    expect(() => readAtWidenedRoot("~bob/x.md", [home], home)).toThrow(ProjectPathError);
  });

  it("refuses a symlink inside an allowed root that points outside it — same realpath-both-sides invariant as readFile", () => {
    const home = makeProject();
    const importDir = join(home, "Documents", "acmecorp");
    mkdirSync(importDir, { recursive: true });
    const outside = makeProject();
    writeFileSync(join(outside, "secret.txt"), "shh");
    symlinkSync(outside, join(importDir, "escape"));
    expect(() => readAtWidenedRoot("~/Documents/acmecorp/escape/secret.txt", [importDir], home)).toThrow(ProjectPathError);
  });

  it("refuses when no roots are given (e.g. projectImportDir unset)", () => {
    expect(() => readAtWidenedRoot("~/Documents/x.md", [], "/Users/alice")).toThrow(ProjectPathError);
  });
});

describe("fs.list RPC", () => {
  function engineOn(home: string): Engine {
    return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
  }

  it("lists a registered project's root", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProject();
    writeFileSync(join(path, "readme.md"), "hi");
    await e.handle("project.create", { name: "p1", path });
    const result = await e.handle("fs.list", { project: "p1", path: "" });
    expect(result).toMatchObject({ path: "", truncated: false });
    expect((result as { entries: unknown[] }).entries).toEqual([{ name: "readme.md", kind: "file", sizeBytes: 2, gitStatus: null }]);
  });

  it("rejects a ghost project with a clean {code:protocol} error", async () => {
    const e = engineOn(makeEngineHome());
    await expect(e.handle("fs.list", { project: "ghost", path: "" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a path escape via the RPC boundary too", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProject();
    await e.handle("project.create", { name: "p1", path });
    await expect(e.handle("fs.list", { project: "p1", path: "../../etc" })).rejects.toMatchObject({ code: "protocol" });
  });
});

describe("fs.read RPC", () => {
  function engineOn(home: string): Engine {
    return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
  }

  it("reads a registered project's file", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProject();
    writeFileSync(join(path, "readme.md"), "hi");
    await e.handle("project.create", { name: "p1", path });
    const result = await e.handle("fs.read", { project: "p1", path: "readme.md" });
    expect(result).toEqual({ path: "readme.md", encoding: "utf8", content: "hi", sizeBytes: 2, binary: false, mediaType: null, truncated: false });
  });

  it("rejects a ghost project with a clean {code:protocol} error", async () => {
    const e = engineOn(makeEngineHome());
    await expect(e.handle("fs.read", { project: "ghost", path: "a.txt" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("rejects a path escape via the RPC boundary too", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProject();
    await e.handle("project.create", { name: "p1", path });
    await expect(e.handle("fs.read", { project: "p1", path: "../../etc/passwd" })).rejects.toMatchObject({ code: "protocol" });
  });

  // PATH-LINK-TILDE-AND-SCOPE: `project` omitted ⇒ widened-root resolution
  // (registered projects + config.projectImportDir). Exercised here with a
  // plain absolute path (tilde expansion itself is covered by expandHome's
  // own unit tests above, against an injected home — this suite doesn't mock
  // node:os, so it sticks to shapes that don't need the real OS home dir).
  describe("with project omitted (widened-root resolution)", () => {
    it("reads a file under config.projectImportDir even though it's not a registered project", async () => {
      const e = engineOn(makeEngineHome());
      const importDir = makeProject();
      writeFileSync(join(importDir, "report.md"), "hi");
      await e.handle("config.patch", { patch: { projectImportDir: importDir } });
      const result = await e.handle("fs.read", { path: join(importDir, "report.md") });
      expect(result).toMatchObject({ content: "hi", binary: false });
    });

    it("still resolves under a registered project's root (widened set is additive, not a replacement)", async () => {
      const e = engineOn(makeEngineHome());
      const path = makeProject();
      writeFileSync(join(path, "readme.md"), "hi");
      await e.handle("project.create", { name: "p1", path });
      const result = await e.handle("fs.read", { path: join(path, "readme.md") });
      expect(result).toMatchObject({ content: "hi" });
    });

    it("refuses a path outside every registered project AND outside projectImportDir", async () => {
      const e = engineOn(makeEngineHome());
      const importDir = makeProject();
      await e.handle("config.patch", { patch: { projectImportDir: importDir } });
      const outside = makeProject();
      writeFileSync(join(outside, "secret.txt"), "shh");
      await expect(e.handle("fs.read", { path: join(outside, "secret.txt") })).rejects.toMatchObject({ code: "protocol" });
    });

    it("refuses when projectImportDir is unset and no registered project matches — never falls back to CWD or the whole disk", async () => {
      const e = engineOn(makeEngineHome());
      const outside = makeProject();
      writeFileSync(join(outside, "secret.txt"), "shh");
      await expect(e.handle("fs.read", { path: join(outside, "secret.txt") })).rejects.toMatchObject({ code: "protocol" });
    });

    it("refuses a symlink inside projectImportDir that points outside it", async () => {
      const e = engineOn(makeEngineHome());
      const importDir = makeProject();
      const outside = makeProject();
      writeFileSync(join(outside, "secret.txt"), "shh");
      symlinkSync(outside, join(importDir, "escape"));
      await e.handle("config.patch", { patch: { projectImportDir: importDir } });
      await expect(e.handle("fs.read", { path: join(importDir, "escape", "secret.txt") })).rejects.toMatchObject({ code: "protocol" });
    });
  });
});

// PATH-LINK-ONE-ROUNDTRIP: the transcript's path links used to resolve by probing EVERY registered
// project with its own fs.read and keeping the first that answered — N sequential round trips per
// link with N-1 expected failures. Measured on an operator's machine: 10 projects, so 10 RPCs and
// 9 logged daemon errors per link, 305 failures a minute, every one queued on the daemon's single
// thread. The walk lives here now: same candidate order, local stat calls, one answer.
describe("fs.resolve — the candidate walk, server-side", () => {
  function engineOn(home: string): Engine {
    return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
  }

  it("finds a repo-relative path in whichever project actually holds it", async () => {
    const e = engineOn(makeEngineHome());
    const empty = makeProject();
    const holder = makeProject();
    writeFileSync(join(holder, "pricing.ts"), "export const x = 1;\n");
    await e.handle("project.create", { name: "empty", path: empty });
    await e.handle("project.create", { name: "holder", path: holder });
    expect(await e.handle("fs.resolve", { path: "pricing.ts" })).toMatchObject({ project: "holder", relPath: "pricing.ts" });
  });

  it("answers null — not an error — when no project holds it", async () => {
    // The COMMON case: prose that merely looks like a path. It must cost one call and render as
    // plain text, never a rejection the operator has to interpret.
    const e = engineOn(makeEngineHome());
    await e.handle("project.create", { name: "p1", path: makeProject() });
    expect(await e.handle("fs.resolve", { path: "nothing/here.ts" })).toBeNull();
  });

  it("prefers the most specific root when projects nest", async () => {
    const outer = makeProject();
    const inner = join(outer, "nested");
    mkdirSync(inner);
    writeFileSync(join(inner, "foo.ts"), "x");
    const e = engineOn(makeEngineHome());
    await e.handle("project.create", { name: "outer", path: outer });
    await e.handle("project.create", { name: "inner", path: inner });
    // Both roots contain the file; the nested project is the honest answer.
    expect(await e.handle("fs.resolve", { path: join(inner, "foo.ts") })).toMatchObject({ project: "inner", relPath: "foo.ts" });
  });

  it("REFUSES a traversal escape rather than resolving it", async () => {
    // The guard that used to live client-side in candidateRoots' pre-filter. It cannot be dropped
    // just because the walk moved: readFile's resolve-then-check is what enforces it now, and a
    // path climbing out of every root must come back null, never a file outside the project.
    const e = engineOn(makeEngineHome());
    const path = makeProject();
    await e.handle("project.create", { name: "p1", path });
    expect(await e.handle("fs.resolve", { path: `${path}/../../../../etc/passwd` })).toBeNull();
    expect(await e.handle("fs.resolve", { path: "../../../../etc/passwd" })).toBeNull();
  });

  it("returns the file's content, so a resolved link needs no second call", async () => {
    const e = engineOn(makeEngineHome());
    const path = makeProject();
    writeFileSync(join(path, "readme.md"), "hi there");
    await e.handle("project.create", { name: "p1", path });
    const hit = await e.handle("fs.resolve", { path: "readme.md" }) as { result: { content: string } };
    expect(hit.result.content).toBe("hi there");
  });
});
