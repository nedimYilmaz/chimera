import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, linkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitOps, gitEnvironment, gitExec } from "../src/gitops.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chimera-gitops-"))); dirs.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "one.txt"), "one\n"); writeFileSync(join(root, "two.txt"), "two\n"); git("add", "--", "one.txt", "two.txt"); git("commit", "-m", "initial");
  return { root, git, ops: new GitOps() };
}
describe("confined Git/file operations in real repositories", () => {
  // Each real operation has its own budget: repeated no-follow Python/Git startups
  // can exhaust a cumulative budget even when individual operations complete normally.
  it("edits and stages only selected paths", () => {
    const { root, ops } = repo();
    const file = ops.read(root, "one.txt"); const saved = ops.write(root, "one.txt", "edited\n", file.contentVersion);
    expect(ops.read(root, "one.txt")).toMatchObject({ text: "edited\n", contentVersion: saved.contentVersion });
    writeFileSync(join(root, "two.txt"), "keep unstaged\n");
    const before = ops.status(root); ops.stage(root, ["one.txt"], false, before.head, before.indexFingerprint);
    const status = ops.status(root); expect(status.files.find(f => f.path === "one.txt")?.staged).toBe(true); expect(status.files.find(f => f.path === "two.txt")?.staged).toBe(false);
    expect(ops.diff(root, "one.txt", true, 3, 65536).hunks).toContain("+edited");
  }, 15000);
  it("unstages selected paths and preserves their working text", () => {
    const { root, git, ops } = repo();
    writeFileSync(join(root, "one.txt"), "edited\n"); writeFileSync(join(root, "two.txt"), "keep unstaged\n"); git("add", "--", "one.txt");
    const before = ops.status(root); ops.stage(root, ["one.txt"], true, before.head, before.indexFingerprint);
    const status = ops.status(root); expect(status.files.every(f => !f.staged)).toBe(true);
    expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("keep unstaged\n");
    ops.stage(root, ["one.txt"], false, status.head, status.indexFingerprint);
    const restaged = ops.status(root); expect(restaged.files.find(f => f.path === "one.txt")?.staged).toBe(true); expect(restaged.files.find(f => f.path === "two.txt")?.staged).toBe(false);
  }, 15000);
  it("edits, stages and commits reviewed files with normal hooks and leaves unrelated edits", () => {
    const { root, git, ops } = repo();
    const file = ops.read(root, "one.txt"); ops.write(root, "one.txt", "edited\n", file.contentVersion);
    writeFileSync(join(root, "two.txt"), "keep unstaged\n");
    const before = ops.status(root); ops.stage(root, ["one.txt"], false, before.head, before.indexFingerprint);
    const status = ops.status(root);
    writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nprintf hook > hook-ran\n", { mode: 0o755 });
    const committed = ops.commit(root, "reviewed", status.head, status.indexFingerprint);
    expect(committed.sha).toBe(git("rev-parse", "HEAD")); expect(git("show", "HEAD:one.txt")).toBe("edited"); expect(git("show", "HEAD:two.txt")).toBe("two"); expect(readFileSync(join(root, "hook-ran"), "utf8")).toBe("hook");
    expect(readFileSync(join(root, "two.txt"), "utf8")).toBe("keep unstaged\n");
  }, 15000);
  it("ignores repository Python startup modules from inherited PYTHONPATH", () => {
    const { root, ops } = repo(); const marker = join(root, "startup-ran");
    writeFileSync(join(root, "sitecustomize.py"), `open(${JSON.stringify(marker)}, "w").write("untrusted startup")`);
    const previous = process.env.PYTHONPATH;
    try {
      process.env.PYTHONPATH = root;
      const file = ops.read(root, "one.txt"); ops.write(root, "one.txt", "edited\n", file.contentVersion);
      expect(ops.status(root).head).not.toBeNull();
      expect(() => readFileSync(marker)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous;
    }
  }, 15000);
  it("rejects changed content and replacement identity even with equal bytes", () => {
    const { root, ops } = repo(); const file = ops.read(root, "one.txt");
    writeFileSync(join(root, "one.txt"), "concurrent\n");
    expect(() => ops.write(root, "one.txt", "draft\n", file.contentVersion)).toThrow("stale_content"); expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("concurrent\n");
    const next = ops.read(root, "one.txt"); rmSync(join(root, "one.txt")); writeFileSync(join(root, "one.txt"), next.text);
    expect(() => ops.write(root, "one.txt", "draft\n", next.contentVersion)).toThrow("stale_content");
  });
  it("rejects traversal, symlink components, hardlinks, binary, invalid UTF-8 and large files", () => {
    const { root, ops } = repo(); const outside = mkdtempSync(join(tmpdir(), "gitops-outside-")); dirs.push(outside); writeFileSync(join(outside, "secret"), "secret");
    symlinkSync(outside, join(root, "escape")); symlinkSync(join(root, "one.txt"), join(root, "alias")); linkSync(join(root, "two.txt"), join(root, "hardlink"));
    writeFileSync(join(root, "binary"), Buffer.from([0, 1])); writeFileSync(join(root, "invalid"), Buffer.from([0xff])); writeFileSync(join(root, "big"), "x".repeat(262145)); mkdirSync(join(root, "dir"));
    for (const path of ["../secret", "/tmp/file", "escape/secret", "alias", "hardlink", "binary", "invalid", "big", "dir", ".git/config"]) expect(() => ops.read(root, path), path).toThrow();
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("secret");
  });
  it("fails stale index-only stage/commit checks although HEAD is unchanged", () => {
    const { root, git, ops } = repo(); writeFileSync(join(root, "one.txt"), "draft"); const before = ops.status(root);
    writeFileSync(join(root, "two.txt"), "external"); git("add", "--", "two.txt"); expect(ops.status(root).head).toBe(before.head);
    expect(() => ops.stage(root, ["one.txt"], false, before.head, before.indexFingerprint)).toThrow("stale_index");
    expect(() => ops.commit(root, "wrong", before.head, before.indexFingerprint)).toThrow("stale_index"); expect(git("diff", "--cached", "--name-only")).toBe("two.txt");
  });
  it("holds the real index lock during private staging", () => {
    const { root, git } = repo(); let checked = false;
    const ops = new GitOps((cwd, args, env) => {
      if (env?.GIT_INDEX_FILE && args[0] === "add") { checked = true; expect(() => git("add", "--", "two.txt")).toThrow(); }
      return gitExec(cwd, args, env);
    });
    writeFileSync(join(root, "one.txt"), "changed"); const s = ops.status(root); ops.stage(root, ["one.txt"], false, s.head, s.indexFingerprint); expect(checked).toBe(true);
  });
  it("preserves HEAD/index and cleans its lock after a failed pre-commit hook", () => {
    const { root, git, ops } = repo(); writeFileSync(join(root, "one.txt"), "changed"); git("add", "--", "one.txt");
    const s = ops.status(root); writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(() => ops.commit(root, "blocked", s.head, s.indexFingerprint)).toThrow();
    const after = ops.status(root); expect(after.indexFingerprint).toBe(s.indexFingerprint); expect(after.head).toBe(s.head);
    expect(() => git("add", "--", "one.txt")).not.toThrow();
  });
  it("preserves HEAD/index and cleans its lock after configured signing fails", () => {
    const { root, git, ops } = repo(); writeFileSync(join(root, "one.txt"), "changed"); git("add", "--", "one.txt");
    const s = ops.status(root); git("config", "commit.gpgsign", "true"); git("config", "gpg.format", "openpgp"); git("config", "gpg.program", "/nonexistent/chimera-signing");
    expect(() => ops.commit(root, "signing blocked", s.head, s.indexFingerprint)).toThrow();
    const after = ops.status(root); expect(after.head).toBe(s.head); expect(after.indexFingerprint).toBe(s.indexFingerprint);
    expect(() => git("add", "--", "one.txt")).not.toThrow();
  }, 15000);
  it("handles literal option/pathspec-shaped names and scrubs inherited Git roots", () => {
    const { root, ops } = repo(); const name = ":(glob)*"; writeFileSync(join(root, name), "literal"); writeFileSync(join(root, "-A"), "option");
    const s = ops.status(root); ops.stage(root, [name], false, s.head, s.indexFingerprint); expect(ops.status(root).files.filter(f => f.staged).map(f => f.path)).toEqual([name]);
    expect(gitEnvironment({})).not.toHaveProperty("GIT_DIR");
  }, 15000);
  it("refuses Git configuration that redirects the selected worktree outside its root", () => {
    const { root, ops, git } = repo(); const outside = realpathSync(mkdtempSync(join(tmpdir(), "gitops-redirect-"))); dirs.push(outside);
    git("config", "core.worktree", outside);
    expect(() => ops.status(root)).toThrow("invalid_root");
  });
});
