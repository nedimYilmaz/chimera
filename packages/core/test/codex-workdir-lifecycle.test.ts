import { describe, expect, it } from "vitest";
import { Codex } from "@openai/codex-sdk";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgentBackend, type CodexLike } from "@chimera/core/backends/codex";
import type { BackendEvent } from "@chimera/core/backend";
import { cxSpec } from "./codex-backend-helpers.js";

describe("Codex exec active CWD lifecycle (offline)", () => {
  it.each([true, false])("remove active CWD before process exit: %s", async (removeEarly) => {
    const root = mkdtempSync(join(tmpdir(), "chimera-codex-cleanup-"));
    const cwd = join(root, "worktree");
    const finish = join(root, "finish");
    const executable = join(root, "fake-codex.cjs");
    mkdirSync(cwd);
    // Real SDK/child process, but no provider: model only a post-message CWD lookup.
    // This proves the lifecycle hazard, not which internal lookup the real CLI performs.
    writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
process.chdir(process.argv[process.argv.indexOf("--cd") + 1]);
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "thread.started", thread_id: "cleanup-repro" });
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { id: "final", type: "agent_message", text: "work landed" } });
const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(finish)})) {
    if (Date.now() > deadline) { clearInterval(timer); process.exit(2); }
    return;
  }
  clearInterval(timer);
  try { process.cwd(); }
  catch (error) { process.stderr.write(error.code + " during final CWD lookup\\n"); process.exit(1); }
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}, 10);
`, { mode: 0o700 });
    const events: BackendEvent[] = [];
    let terminal!: (event: BackendEvent) => void;
    const ended = new Promise<BackendEvent>(resolve => { terminal = resolve; });
    const handle = new CodexAgentBackend({
      codexFactory: options => new Codex({ ...options, codexPathOverride: executable } as ConstructorParameters<typeof Codex>[0]) as unknown as CodexLike,
    }).spawn(cxSpec({ cwd }), event => {
      events.push(event);
      if (event.kind === "message_complete") {
        expect(events.some(e => e.kind === "result")).toBe(false);
        if (removeEarly) rmSync(cwd, { recursive: true });
        writeFileSync(finish, "finish");
      }
      if (event.kind === "result" || event.kind === "error") terminal(event);
    }, async () => true);
    try {
      const event = await ended;
      expect(events.some(e => e.kind === "message_complete")).toBe(true);
      if (removeEarly) {
        expect(event.kind).toBe("error");
        expect(event.data).toMatchObject({ exitCode: 1, stderrTail: "ENOENT during final CWD lookup" });
        expect(events.some(e => e.kind === "result")).toBe(false);
      } else {
        expect(event.kind).toBe("result");
        expect(event.data.text).toBe("work landed");
        expect(existsSync(cwd)).toBe(true);
        rmSync(cwd, { recursive: true });
        expect(existsSync(cwd)).toBe(false);
      }
    } finally {
      await handle.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
