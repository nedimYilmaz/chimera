// PROJECT-WORKSPACE-LAYOUT: a project-scoped agent (isolation:"none" — the project conductor,
// dispatch's direct project spawn, or a project-native team worker) whose cwd has no `.git` is a
// repo-less scratch workspace (e.g. an operator's Jira-ticket project). It must be told to clone
// any repo it needs into a SUBDIRECTORY, never the project root — and a repo-backed project must
// NOT get this line (pointless tokens, reads as contradictory advice). Detected via an actual
// `.git` existsSync check on cwd, not ProjectSpec.origin (a registered local path can be a real
// checkout even with origin === null).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { ResolvedAgentSpec } from "@chimera/core/backend";

const WORKSPACE_LINE = "WORKSPACE: this project directory is a container, not a checkout. If you need a repository, clone it into a SUBDIRECTORY (<project>/<repo-name>) — never into the project root.";

function parkedQuery() {
  const calls: Array<{ prompt: AsyncIterable<{ message: { content: Array<{ text?: string }> } } | { message: { content: Array<{ text?: string }> } }>; options: Record<string, unknown> }> = [];
  const fn = ((args: never) => {
    calls.push(args as never);
    return { async *[Symbol.asyncIterator]() { /* never yields */ }, interrupt: async () => {} };
  }) as never;
  return { fn, calls };
}
function nextOrTimeout(iter: AsyncIterator<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    iter.next().then((r) => (r.done ? "DONE" : r.value)),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), ms)),
  ]);
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/unused", isolation: "none", ...over }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
function repoLessDir(): string {
  return mkdtempSync(join(tmpdir(), "chimera-workspace-repoless-"));
}
function repoBackedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chimera-workspace-repobacked-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

describe("ClaudeAgentBackend PROJECT-WORKSPACE-LAYOUT", () => {
  it("(a) a repo-less project spawn's first user turn carries the WORKSPACE container line", async () => {
    const cwd = repoLessDir();
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd }), () => {}, async () => true);
    const first = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(first).not.toBe("TIMEOUT");
    const blocks = (first as { message: { content: Array<{ text?: string }> } }).message.content;
    expect(blocks[0]!.text).toBe(WORKSPACE_LINE);
    expect(blocks[1]!.text).toBe("task");   // the real prompt still follows, untouched
  });

  it("(b) a repo-backed project spawn's first user turn does NOT carry the WORKSPACE line", async () => {
    const cwd = repoBackedDir();
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd }), () => {}, async () => true);
    const first = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(first).not.toBe("TIMEOUT");
    const blocks = (first as { message: { content: Array<{ text?: string }> } }).message.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe("task");
    expect(blocks[0]!.text).not.toContain("WORKSPACE:");
  });

  it("(c) the line rides the first-user-turn channel, not the cached systemPrompt.append, on a normal (non-resumeOnly) spawn", async () => {
    const cwd = repoLessDir();
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd, instructions: "be nice" }), () => {}, async () => true);
    // SAFE-1 CACHE-PREFIX: systemPrompt.append must stay exactly `instructions` — if the
    // per-spawn WORKSPACE line leaked onto it, every repo-less-project spawn would write its
    // own prompt-cache entry instead of sharing the one cached prefix.
    expect(calls[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true, append: "be nice" });
    const first = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(first).not.toBe("TIMEOUT");
    const blocks = (first as { message: { content: Array<{ text?: string }> } }).message.content;
    expect(blocks[0]!.text).toBe(WORKSPACE_LINE);
  });

  it("(c) the line rides the systemPrompt append on the resumeOnly reattach path (no first user turn exists to carry it)", async () => {
    const cwd = repoLessDir();
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn })
      .spawn(spec({ cwd, resumeOnly: true, resume: "sess-1", instructions: "be nice" }), () => {}, async () => true);
    expect((calls[0]!.options.systemPrompt as { append?: string }).append).toBe(`be nice\n\n${WORKSPACE_LINE}`);
    const queue = calls[0]!.prompt as unknown as { isEmpty(): boolean };
    expect(queue.isEmpty()).toBe(true);   // resumeOnly pushes no first turn at all
  });

  it("never injects the WORKSPACE line for a worktree-isolated spawn, even at a repo-less cwd (worktrees always have .git)", async () => {
    // A worktree spawn's cwd is resolved to its own .git-bearing worktree dir by ensureWorkdir
    // regardless of what spec.cwd names — isolation:"worktree" already takes the ORIENTATION
    // branch unconditionally, so this only guards against a future refactor collapsing the two
    // branches back together.
    const cwd = mkdtempSync(join(tmpdir(), "chimera-workspace-realrepo-"));
    execFileSync("git", ["-C", cwd, "init", "-q"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "--allow-empty", "-m", "init"]);
    const { fn, calls } = parkedQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd, isolation: "worktree" }), () => {}, async () => true);
    const first = await nextOrTimeout(calls[0]!.prompt[Symbol.asyncIterator](), 30);
    expect(first).not.toBe("TIMEOUT");
    const text = (first as { message: { content: Array<{ text?: string }> } }).message.content[0]!.text!;
    expect(text).not.toContain("WORKSPACE:");
    expect(text.startsWith("WORKSPACE (already set up")).toBe(true);
  });
});
