#!/usr/bin/env node
// Single correct implementation of "give a fresh worktree its own node_modules" — see
// packages/core/src/workdir.ts (setupWorktreeNodeModules) for why this exists: hand-rolling
// `ln -s <mainRepo>/node_modules <worktreeDir>/node_modules` (whole-directory symlink) and then
// repointing @chimera/* links "in the worktree" actually rewrites MAIN's real @chimera links,
// because every path under that symlinked node_modules resolves through it into main. Every
// worktree agent should call this script instead of hand-rolling those steps.
//
// Usage: node scripts/setup-worktree-modules.mjs [worktreeDir]   (defaults to cwd)
import { register } from "tsx/esm/api";
register();
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const worktreeDir = resolve(process.argv[2] ?? process.cwd());
const gitCommonDir = execFileSync(
  "git",
  ["-C", worktreeDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  { stdio: ["ignore", "pipe", "pipe"] },
).toString().trim();
const mainRepo = dirname(gitCommonDir);

if (mainRepo === worktreeDir) {
  console.error(`${worktreeDir} IS the main checkout (no separate .git common dir found) — nothing to set up.`);
  process.exit(1);
}

const { setupWorktreeNodeModules } = await import("../packages/core/src/workdir.ts");
setupWorktreeNodeModules(mainRepo, worktreeDir);
console.log(`node_modules ready in ${worktreeDir} (main: ${mainRepo})`);
