import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import {
  ProjectStore, isPathUnder, isGitSource, deriveProjectName, gitInitSeed,
  DuplicateProjectError, UnknownProjectError, ProjectPathError, GitImportError,
} from "@chimera/core/projects";

// WD Stage 2 (coverage B12): the ProjectStore registry — CRUD + persistence
// following the teams.json discipline (parse-on-load, fail-fast corruption,
// temp-then-rename saves) — plus the pure helpers the engine's session matching
// and import routing are built on.

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-proj-"));
  return { dir, store: new ProjectStore(dir, new EventLog(dir)) };
}

// a real directory to register as a project path
function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "chimera-proj-path-"));
}

describe("isPathUnder (coverage B12 boundary check)", () => {
  it("matches the path itself and true descendants", () => {
    expect(isPathUnder("/a/b", "/a/b")).toBe(true);
    expect(isPathUnder("/a/b/c", "/a/b")).toBe(true);
    expect(isPathUnder("/a/b/c/d", "/a/b")).toBe(true);
  });

  it("NEVER matches a sibling sharing a name prefix (/a/bc vs /a/b — the contract's own example)", () => {
    expect(isPathUnder("/a/bc", "/a/b")).toBe(false);
    expect(isPathUnder("/a/bc/d", "/a/b")).toBe(false);
  });

  it("normalizes trailing slashes on both sides", () => {
    expect(isPathUnder("/a/b/", "/a/b")).toBe(true);
    expect(isPathUnder("/a/b/c", "/a/b/")).toBe(true);
    expect(isPathUnder("/a/bc", "/a/b/")).toBe(false);
  });

  it("a parent is not under its child", () => {
    expect(isPathUnder("/a", "/a/b")).toBe(false);
  });
});

describe("isGitSource / deriveProjectName", () => {
  it("recognizes https/ssh/git/file schemes and scp-style git@", () => {
    for (const s of ["https://github.com/x/y.git", "ssh://git@host/x.git", "git://host/x", "file:///tmp/repo", "git@github.com:x/y.git"])
      expect(isGitSource(s), s).toBe(true);
  });

  it("a plain local path is NOT a git source", () => {
    expect(isGitSource("/tmp/some/dir")).toBe(false);
    expect(isGitSource("relative/dir")).toBe(false);
  });

  it("derives a CoordName-safe name: last segment, .git stripped, invalid chars folded to '-'", () => {
    expect(deriveProjectName("https://github.com/acme/tui-crew.git")).toBe("tui-crew");
    expect(deriveProjectName("git@github.com:acme/repo.name.git")).toBe("repo-name");
    expect(deriveProjectName("/tmp/my project dir")).toBe("my-project-dir");
    expect(deriveProjectName("file:///tmp/repos/demo/")).toBe("demo");
  });

  it("throws {code:'protocol'} when nothing usable remains", () => {
    expect(() => deriveProjectName("///")).toThrow(ProjectPathError);
  });
});

describe("ProjectStore CRUD + persistence", () => {
  it("create validates the path is an absolute existing directory", () => {
    const { store } = makeStore();
    expect(() => store.create({ name: "p", path: "not/absolute" })).toThrow(ProjectPathError);
    expect(() => store.create({ name: "p", path: "/definitely/missing/dir-xyz" })).toThrow(ProjectPathError);
    const file = join(makeProjectDir(), "a-file.txt");
    writeFileSync(file, "x");
    expect(() => store.create({ name: "p", path: file })).toThrow(ProjectPathError);   // a FILE is not a project dir
  });

  it("create stamps defaults (origin null, teams [], queue null, archived false, createdAt) and rejects duplicates", () => {
    const { store } = makeStore();
    const path = makeProjectDir();
    const spec = store.create({ name: "alpha", path });
    expect(spec).toMatchObject({ name: "alpha", path, origin: null, teams: [], queue: null, archived: false });
    expect(spec.createdAt).toBeGreaterThan(0);
    expect(() => store.create({ name: "alpha", path })).toThrow(DuplicateProjectError);
  });

  it("a CoordName-invalid name is rejected by the spec parse (dots/slashes never reach disk)", () => {
    const { store } = makeStore();
    expect(() => store.create({ name: "bad.name", path: makeProjectDir() })).toThrow();
  });

  it("persists across a reload of the same dir (projects.json)", () => {
    const { dir, store } = makeStore();
    const path = makeProjectDir();
    store.create({ name: "alpha", path, teams: ["crew"], queue: "q1" });
    const reloaded = new ProjectStore(dir, new EventLog(dir));
    expect(reloaded.get("alpha")).toMatchObject({ name: "alpha", path, teams: ["crew"], queue: "q1" });
  });

  it("get throws UnknownProjectError for a ghost; has() answers without throwing", () => {
    const { store } = makeStore();
    expect(() => store.get("ghost")).toThrow(UnknownProjectError);
    expect(store.has("ghost")).toBe(false);
  });

  it("assignTeam appends once and dedupes on re-assign (idempotent)", () => {
    const { store } = makeStore();
    store.create({ name: "alpha", path: makeProjectDir() });
    expect(store.assignTeam("alpha", "crew").teams).toEqual(["crew"]);
    expect(store.assignTeam("alpha", "crew").teams).toEqual(["crew"]);   // dedupe
    expect(store.assignTeam("alpha", "other").teams).toEqual(["crew", "other"]);
  });

  it("setLoadProjectSettings flips the toggle, is idempotent (no-op save on same value), and persists", () => {
    const { dir, store } = makeStore();
    store.create({ name: "alpha", path: makeProjectDir() });
    expect(store.get("alpha").loadProjectSettings).toBe(true);   // schema default
    expect(store.setLoadProjectSettings("alpha", false).loadProjectSettings).toBe(false);
    expect(store.setLoadProjectSettings("alpha", false).loadProjectSettings).toBe(false);   // idempotent
    expect(new ProjectStore(dir, new EventLog(dir)).get("alpha").loadProjectSettings).toBe(false);
  });

  it("setSetupHook persists the hook, is idempotent (no-op save on same value), and the event carries enabled only — never the command", () => {
    const { dir, store } = makeStore();
    store.create({ name: "alpha", path: makeProjectDir() });
    expect(store.get("alpha").worktreeSetup).toBeNull();   // schema default

    const hook = { command: "npm install", enabled: true, timeoutSec: 60 };
    expect(store.setSetupHook("alpha", hook).worktreeSetup).toEqual(hook);
    expect(store.setSetupHook("alpha", hook).worktreeSetup).toEqual(hook);   // idempotent
    expect(new ProjectStore(dir, new EventLog(dir)).get("alpha").worktreeSetup).toEqual(hook);

    const events = new EventLog(dir).tail("project:alpha", 50);
    const setEvent = events.find((e) => (e.data as { state?: string }).state === "setup-hook-set");
    expect(setEvent?.data).toEqual({ project: "alpha", state: "setup-hook-set", enabled: true });
    expect(JSON.stringify(setEvent?.data)).not.toContain("npm install");

    expect(store.setSetupHook("alpha", null).worktreeSetup).toBeNull();
  });

  it("archive flips the flag, is idempotent, and persists", () => {
    const { dir, store } = makeStore();
    store.create({ name: "alpha", path: makeProjectDir() });
    expect(store.archive("alpha").archived).toBe(true);
    expect(store.archive("alpha").archived).toBe(true);                  // idempotent
    expect(new ProjectStore(dir, new EventLog(dir)).get("alpha").archived).toBe(true);
  });

  it("create dedupes a teams list at the door", () => {
    const { store } = makeStore();
    const spec = store.create({ name: "alpha", path: makeProjectDir(), teams: ["crew", "crew"] });
    expect(spec.teams).toEqual(["crew"]);
  });

  it("fails fast on a corrupt projects.json, naming the file (teams.json discipline)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-proj-corrupt-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "projects.json"), "{not json");
    expect(() => new ProjectStore(dir, new EventLog(dir))).toThrow(/corrupt coordination state in .*projects\.json/);
  });

  it("saves via temp-then-rename (the persisted file is valid JSON after every mutation)", () => {
    const { dir, store } = makeStore();
    store.create({ name: "alpha", path: makeProjectDir() });
    store.assignTeam("alpha", "crew");
    const raw = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")) as unknown[];
    expect(raw).toHaveLength(1);
  });
});

describe("GIT-STDOUT-DIAGNOSTIC (gitInitSeed surfaces stdout, not just stderr)", () => {
  // gitInitSeed/gitClone hardcode execFile("git", ...) — this puts a fake "git" first on
  // PATH so the test exercises the code's own (err, stdout, stderr) handling directly,
  // deterministically, rather than depending on which stream a real git subcommand happens
  // to choose (git itself often re-emits hook output on stderr regardless of what the hook
  // wrote to, which made an earlier real-hook-based repro of this pass even before the fix).
  it("includes a failing git command's stdout-only diagnostic in the rejection message", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "chimera-fakegit-bin-"));
    const fakeGit = join(binDir, "git");
    writeFileSync(fakeGit, "#!/bin/sh\necho 'CUSTOM-STDOUT-DIAGNOSTIC'\nexit 1\n");
    chmodSync(fakeGit, 0o755);
    const dest = mkdtempSync(join(tmpdir(), "chimera-proj-hookstdout-"));

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      await expect(gitInitSeed(dest)).rejects.toMatchObject({
        constructor: GitImportError,
        message: expect.stringContaining("CUSTOM-STDOUT-DIAGNOSTIC"),
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
