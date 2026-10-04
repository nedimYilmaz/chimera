import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { bashWriteTargets, editToolTargetPath, findMainSourceWrite } from "@chimera/core/hosttools";

// F22 task 1: "which paths would this tool call WRITE to". Detection only — no policy, no call
// sites yet. The point of most of these cases is the ORDER-DEPENDENT cwd rebinding and the
// fail-closed git list; the blind-spot block at the bottom pins the documented limits so nobody
// later mistakes this for a sandbox.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chimera-wt-")));
  const wt = join(root, "wt");
  const other = join(root, "other");
  mkdirSync(wt);
  mkdirSync(other);
  return { root, wt, other };
}

describe("bashWriteTargets — git", () => {
  it("treats every mutating subcommand under -C as a write of that directory", () => {
    const { wt, other } = fixture();
    for (const sub of ["commit -am x", "add .", "merge main", "checkout main", "reset --hard", "stash", "apply p.diff", "rebase main"]) {
      expect(bashWriteTargets(`git -C ../other ${sub}`, wt)).toEqual([other]);
    }
  });

  it("fails CLOSED on an unknown/new subcommand", () => {
    const { wt, other } = fixture();
    expect(bashWriteTargets("git -C ../other frobnicate", wt)).toEqual([other]);
  });

  it("aims at --work-tree, never at --git-dir — relocating the repo metadata must not hide the write", () => {
    const { wt, other } = fixture();
    // Regression (QA of 4d32b1e6): -C/--work-tree/--git-dir shared ONE last-wins slot, so putting
    // --git-dir last pointed the detector at a harmless .git path while git still wrote `other`.
    expect(bashWriteTargets(`git --work-tree=${other} --git-dir=${wt}/.git checkout .`, wt)).toEqual([other]);
    expect(bashWriteTargets(`git --git-dir=${wt}/.git --work-tree=${other} checkout .`, wt)).toEqual([other]);
    expect(bashWriteTargets(`git --work-tree ${other} --git-dir ${wt}/.git commit -am x`, wt)).toEqual([other]);
    // A relative --work-tree resolves against -C's directory, exactly as git does.
    expect(bashWriteTargets("git -C ../other --work-tree=. commit -am x", wt)).toEqual([other]);
  });

  it("never produces a FOREIGN target for the fleet's everyday commands (a false deny halts the fleet)", () => {
    const { wt, other } = fixture();
    for (const cmd of [
      "git status", "git log --oneline -20", "git diff --stat", "git show --stat HEAD",
      "cat package.json", "grep -rn foo packages", "ls -la packages/core",
      "npx tsc -b packages/core/tsconfig.json",
      "npx vitest run packages/core --testTimeout=60000",
      "node scripts/setup-worktree-modules.mjs",
      "git add -A && git commit -m x",
    ]) {
      expect(bashWriteTargets(cmd, wt).filter((t) => t.startsWith(other))).toEqual([]);
    }
  });

  // QA of F22 (finding 7): `config` used to sit in the read list wholesale, so
  // `git -C <foreign worktree> config user.name x` — which really does write
  // <worktree>/.git/config — produced NO target and walked straight through the lease gate.
  it("git config is a WRITE unless the argv carries a read spelling", () => {
    const { wt, other } = fixture();
    expect(bashWriteTargets("git -C ../other config user.name x", wt)).toEqual([other]);
    expect(bashWriteTargets("git -C ../other config --unset user.name", wt)).toEqual([other]);
    for (const read of ["--get user.name", "--get-all user.name", "--get-regexp ^user", "--list", "-l"]) {
      expect(bashWriteTargets(`git -C ../other config ${read}`, wt)).toEqual([]);
    }
  });

  it("reads produce no target, with or without -C", () => {
    const { wt } = fixture();
    for (const cmd of ["git -C ../other status", "git -C ../other log --oneline", "git -C ../other diff", "git grep foo", "git status"]) {
      expect(bashWriteTargets(cmd, wt)).toEqual([]);
    }
  });

  it("skips git's value-taking global options when finding the subcommand", () => {
    const { wt, other } = fixture();
    expect(bashWriteTargets("git -c user.name=x -C ../other commit -m y", wt)).toEqual([other]);
    expect(bashWriteTargets("git --work-tree=../other checkout .", wt)).toEqual([other]);
  });

  it("a bare mutating git targets the CURRENT dir, which an earlier `cd` may have rebound", () => {
    const { wt, other } = fixture();
    expect(bashWriteTargets("cd ../other && git commit -am x", wt)).toEqual([other]);
    expect(bashWriteTargets("git commit -am x", wt)).toEqual([wt]);
  });
});

describe("bashWriteTargets — redirections and file tools", () => {
  it("catches >, >>, N> and &> in both glued and spaced spellings", () => {
    const { wt } = fixture();
    expect(bashWriteTargets("echo hi > out.txt", wt)).toEqual([join(wt, "out.txt")]);
    expect(bashWriteTargets("echo hi >>out.txt", wt)).toEqual([join(wt, "out.txt")]);
    expect(bashWriteTargets("make 2> err.log", wt)).toEqual([join(wt, "err.log")]);
    expect(bashWriteTargets("make &> both.log", wt)).toEqual([join(wt, "both.log")]);
    expect(bashWriteTargets("make &>both.log", wt)).toEqual([join(wt, "both.log")]);
  });

  it("ignores fd duplication (`2>&1`) but still sees the real redirect next to it", () => {
    const { wt } = fixture();
    expect(bashWriteTargets("make 2>&1 > out.txt", wt)).toEqual([join(wt, "out.txt")]);
  });

  it("cp/mv/ln target only the destination; rm targets every operand", () => {
    const { wt } = fixture();
    expect(bashWriteTargets("cp -r a b", wt)).toEqual([join(wt, "b")]);
    expect(bashWriteTargets("mv a b", wt)).toEqual([join(wt, "b")]);
    expect(bashWriteTargets("rm -rf a b", wt)).toEqual([join(wt, "a"), join(wt, "b")]);
  });

  it("tee writes its operands; sed only with -i, and only when a FILE follows the script", () => {
    const { wt } = fixture();
    expect(bashWriteTargets("echo x | tee -a out.txt", wt)).toEqual([join(wt, "out.txt")]);
    expect(bashWriteTargets("sed -i 's/a/b/' f.ts", wt)).toEqual([join(wt, "f.ts")]);
    expect(bashWriteTargets("sed -i.bak 's/a/b/' f.ts", wt)).toEqual([join(wt, "f.ts")]);
    expect(bashWriteTargets("sed 's/a/b/' f.ts", wt)).toEqual([]);
    expect(bashWriteTargets("cat f.ts | sed -i 's/a/b/'", wt)).toEqual([]);   // one plain arg = stdin, no file
  });

  it("resolves against the rebound cwd, dedupes, and preserves first-seen order", () => {
    const { wt, other } = fixture();
    expect(bashWriteTargets("echo a > o.txt && cp x o.txt", wt)).toEqual([join(wt, "o.txt")]);
    expect(bashWriteTargets("cd ../other; echo a > o.txt", wt)).toEqual([join(other, "o.txt")]);
    expect(bashWriteTargets("cd", wt)).toEqual([]);   // bare `cd` goes $HOME, never a worktree
  });
});

describe("bashWriteTargets — DOCUMENTED blind spots (guardrail, not sandbox)", () => {
  it("does not see writes performed by interpreters, find/xargs, or wrapper scripts", () => {
    const { wt } = fixture();
    expect(bashWriteTargets(`python -c "open('f.txt','w').write('x')"`, wt)).toEqual([]);
    expect(bashWriteTargets("node -e \"require('fs').writeFileSync('f.txt','x')\"", wt)).toEqual([]);
    expect(bashWriteTargets("find . -name '*.tmp' -exec rm {} +", wt)).toEqual([]);
    expect(bashWriteTargets("ls | xargs rm", wt)).toEqual([]);
    expect(bashWriteTargets("./deploy.sh", wt)).toEqual([]);
    expect(bashWriteTargets("eval \"$CMD\"", wt)).toEqual([]);
  });

  it("sees the heredoc's own redirect, but not what the written script later does", () => {
    const { wt } = fixture();
    const cmd = "cat > s.sh <<'EOF'\nrm victim.txt\nEOF\nbash s.sh";
    expect(bashWriteTargets(cmd, wt)).toEqual([join(wt, "s.sh")]);
  });
});

describe("editToolTargetPath", () => {
  it("resolves each Edit-family tool's path field against execCwd, and nothing else", () => {
    const { wt } = fixture();
    expect(editToolTargetPath("Edit", { file_path: "src/a.ts" }, wt)).toBe(join(wt, "src/a.ts"));
    expect(editToolTargetPath("Write", { file_path: "src/a.ts" }, wt)).toBe(join(wt, "src/a.ts"));
    expect(editToolTargetPath("MultiEdit", { file_path: "src/a.ts" }, wt)).toBe(join(wt, "src/a.ts"));
    expect(editToolTargetPath("NotebookEdit", { notebook_path: "n.ipynb" }, wt)).toBe(join(wt, "n.ipynb"));
    expect(editToolTargetPath("Bash", { file_path: "src/a.ts" }, wt)).toBeNull();
    expect(editToolTargetPath("Edit", { file_path: "" }, wt)).toBeNull();
    expect(editToolTargetPath("Edit", undefined, wt)).toBeNull();
  });

  it("is the exact path findMainSourceWrite reports — extraction must not have changed it", () => {
    const { root, wt } = fixture();
    const main = root;   // wt lives under it, so an escaping edit lands in main
    const input = { file_path: "../src/a.ts" };
    expect(findMainSourceWrite("Edit", input, wt, main)).toBe(editToolTargetPath("Edit", input, wt));
    expect(findMainSourceWrite("Edit", input, wt, main)).toBe(resolve(root, "src/a.ts"));
    expect(findMainSourceWrite("Edit", { file_path: "own.ts" }, wt, main)).toBeNull();
  });
});
