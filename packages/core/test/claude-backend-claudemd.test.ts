import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { ResolvedAgentSpec } from "@chimera/core/backend";

type Msg = Record<string, unknown>;
function fakeQuery(messages: Msg[] = []) {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
  const fn = ((args: { prompt: unknown; options: Record<string, unknown> }) => {
    calls.push(args);
    return { async *[Symbol.asyncIterator]() { for (const m of messages) yield m; }, interrupt: vi.fn(async () => {}) };
  }) as never;
  return { fn, calls };
}
function spec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", inherit: { settingSources: [] }, ...over }),
    agentId: "ag-1", accountName: "second", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("ClaudeAgentBackend TOKEN-EFF-2 CLAUDE.md self-injection", () => {
  it("appends the repo-root CLAUDE.md after instructions when settingSources omits project", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-claudemd-"));
    writeFileSync(join(repo, "CLAUDE.md"), "# Agent guide\n\nDo the thing.");
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd: repo, instructions: "be nice" }), () => {}, async () => true);
    await settle();
    const append = (calls[0]!.options.systemPrompt as { append: string }).append;
    expect(append).toBe("be nice\n\n# Agent guide\n\nDo the thing.");
  });

  it("silently skips when the repo has no CLAUDE.md", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-claudemd-"));
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd: repo, instructions: "be nice" }), () => {}, async () => true);
    await settle();
    expect(calls[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true, append: "be nice" });
  });

  it("truncates an oversized CLAUDE.md to the 8KB cap", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-claudemd-"));
    writeFileSync(join(repo, "CLAUDE.md"), "x".repeat(20_000));
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec({ cwd: repo }), () => {}, async () => true);
    await settle();
    const append = (calls[0]!.options.systemPrompt as { append: string }).append;
    expect(append).toBe(`\n\n${"x".repeat(8 * 1024)}`);
  });

  it("does not double-inject when settingSources already includes project (SDK loads CLAUDE.md itself)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "chimera-claudemd-"));
    writeFileSync(join(repo, "CLAUDE.md"), "# Agent guide\n\nDo the thing.");
    const { fn, calls } = fakeQuery();
    new ClaudeAgentBackend({ queryFn: fn }).spawn(
      spec({ cwd: repo, instructions: "be nice", inherit: { settingSources: ["project"] } }), () => {}, async () => true,
    );
    await settle();
    expect(calls[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", excludeDynamicSections: true, append: "be nice" });
  });
});
