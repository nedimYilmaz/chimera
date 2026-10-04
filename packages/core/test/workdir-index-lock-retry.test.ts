import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// F08.QA-FIX item 4 (N4): concurrent `git worktree add` calls against the same main repo can race
// for .git's index.lock under fleet load — QA's own read is that this belongs in the git helper as
// a bounded retry, NOT a failover.ts classifier row (there is no backend error event to classify).
// This proves ensureWorkdir absorbs a transient index.lock failure instead of hard-failing the spawn.

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (...a: unknown[]) => execFileSyncMock(...a) };
});

function indexLockError(): Error & { stderr: Buffer } {
  const e = new Error("Command failed") as Error & { stderr: Buffer };
  e.stderr = Buffer.from("fatal: Unable to create '/repo/.git/index.lock': File exists.\n");
  return e;
}

describe("ensureWorkdir index.lock contention", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "chimera-workdir-test-"));
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("retries past two transient index.lock failures and still creates the worktree", async () => {
    const { ensureWorkdir } = await import("../src/workdir.js");
    let addAttempts = 0;
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes("rev-parse")) return Buffer.from("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n");
      if (args.includes("worktree") && args.includes("add")) {
        addAttempts++;
        if (addAttempts <= 2) throw indexLockError();
        return Buffer.from("");
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    });

    const info = ensureWorkdir({ isolation: "worktree", cwd, agentId: "agent-1", workdirKey: undefined });

    expect(info.created).toBe(true);
    expect(info.mainRepo).toBe(cwd);
    // Only the FIRST worktree-add variant ("-b <branch>") was ever invoked — the retry absorbed
    // both failures internally, so the "-b" fallback re-add-of-existing-branch path never fired.
    const addCalls = execFileSyncMock.mock.calls.filter(([, args]) => (args as string[]).includes("worktree"));
    expect(addCalls).toHaveLength(3);
    for (const [, args] of addCalls) expect(args as string[]).toContain("-b");
  });
});
