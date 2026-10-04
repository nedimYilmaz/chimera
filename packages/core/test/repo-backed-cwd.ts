// Shared fixture: a real directory with a `.git` entry, for specs whose `cwd` is incidental to
// the test (they only care about content shape, not workspace-layout). PROJECT-WORKSPACE-LAYOUT
// made ClaudeAgentBackend.spawn() check `existsSync(join(cwd, ".git"))` on every non-worktree
// spawn to decide whether to inject the WORKSPACE container-line — a bare placeholder path like
// "/tmp/repo" (never created on disk) is now indistinguishable from a real repo-less scratch
// project and would pick up an extra leading text block. Computed once at import time (not per
// test) so every caller shares one fixture dir instead of racing mkdtempSync per test file.
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO_BACKED_CWD = mkdtempSync(join(tmpdir(), "chimera-repo-backed-"));
mkdirSync(join(REPO_BACKED_CWD, ".git"));
