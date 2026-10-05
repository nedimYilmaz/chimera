import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentBackend } from "../src/backends/claude.js";

it("official Claude SDK forks an offline transcript but its source-directory fork is not visible at the new worktree cwd", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "chimera-claude-fork-proof-")));
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(temp, "config");
  const sourceCwd = join(temp, "source"), childCwd = join(temp, "child");
  const sessionId = randomUUID(), userId = randomUUID(), assistantId = randomUUID();
  const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", sourceCwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true }); mkdirSync(sourceCwd); mkdirSync(childCwd);
  const row = (type: string, uuid: string, parentUuid: string | null, message: unknown) => ({ type, uuid, parentUuid, sessionId, cwd: sourceCwd, timestamp: new Date().toISOString(), isSidechain: false, message });
  writeFileSync(join(project, `${sessionId}.jsonl`), [row("user", userId, null, { role: "user", content: "Harmless offline history" }), row("assistant", assistantId, userId, { role: "assistant", content: [{ type: "text", text: "Offline fixture response" }] })].map(x => JSON.stringify(x)).join("\n") + "\n");
  try {
    const original = await getSessionMessages(sessionId, { dir: sourceCwd });
    expect(original.length).toBe(2);
    const fork = await forkSession(sessionId, { dir: sourceCwd, upToMessageId: assistantId });
    expect(fork.sessionId).not.toBe(sessionId);
    expect((await getSessionMessages(fork.sessionId, { dir: sourceCwd })).length).toBe(2);
    expect(await getSessionMessages(fork.sessionId, { dir: childCwd })).toEqual([]);
    // Existence of forkSession is insufficient to advertise cross-cwd native resume.
    expect(new ClaudeAgentBackend().capabilities.supportsConversationFork ?? false).toBe(false);
    expect(await getSessionMessages(sessionId, { dir: sourceCwd })).toEqual(original);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior;
    rmSync(temp, { recursive: true, force: true });
  }
});
