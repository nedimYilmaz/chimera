import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import { ensureWorkdir, resolveWorkdirPath } from "../src/workdir.js";
import { makeEngineHome } from "./helpers.js";
import { gitEnvironment } from "../src/gitops.js";
import type { GitFile, GitStatus } from "@chimera/protocol";

describe("server-resolved Git target and real lease authority", () => {
  it("gates operator/live-holder, unrelated agent and read-only writes, and never falls back to main", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "chimera-git-authority-")));
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: gitEnvironment(), stdio: "pipe" });
    git("init"); writeFileSync(join(cwd, "one.txt"), "main text"); git("add", "--", "one.txt"); git("-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init");
    const home = makeEngineHome();
    const e = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([[{ awaitSend: true }], [{ awaitSend: true }]])]]) });
    const own = await e.supervisor.spawn({ prompt: "fixture", cwd, isolation: "worktree", permissionProfile: "full" });
    const other = await e.supervisor.spawn({ prompt: "fixture", cwd, isolation: "worktree", permissionProfile: "readOnly" });
    try {
      ensureWorkdir({ ...own.spec, agentId: own.agentId }); ensureWorkdir({ ...other.spec, agentId: other.agentId });
      const root = resolveWorkdirPath({ ...own.spec, agentId: own.agentId });
      e.worktreeLeases.acquire(own.agentId, root, own.agentId);
      const target = { agentId: own.agentId };
      const status = await e.handle("worktree.gitStatus", { target }) as GitStatus;
      expect(status.writable).toBe(false);
      const file = await e.handle("worktree.fileRead", { target, path: "one.txt" }) as GitFile;
      const change = { target, path: "one.txt", text: "saved text", expectedContentVersion: file.contentVersion };
      await expect(e.handle("worktree.fileWrite", change)).rejects.toMatchObject({ code: "lease_held" });
      await expect(e.handle("worktree.fileRead", { target, path: "one.txt", callerAgentId: other.agentId })).rejects.toMatchObject({ code: "access_denied" });
      await e.handle("worktree.fileWrite", { ...change, callerAgentId: own.agentId });
      expect(readFileSync(join(root, "one.txt"), "utf8")).toBe("saved text"); expect(readFileSync(join(cwd, "one.txt"), "utf8")).toBe("main text");
      const otherRoot = resolveWorkdirPath({ ...other.spec, agentId: other.agentId }); e.worktreeLeases.acquire(other.agentId, otherRoot, other.agentId);
      const otherFile = await e.handle("worktree.fileRead", { target: { agentId: other.agentId }, path: "one.txt", callerAgentId: other.agentId }) as GitFile;
      await expect(e.handle("worktree.fileWrite", { target: { agentId: other.agentId }, path: "one.txt", text: "forbidden", expectedContentVersion: otherFile.contentVersion, callerAgentId: other.agentId })).rejects.toMatchObject({ code: "lease_held" });
      rmSync(root, { recursive: true, force: true });
      await expect(e.handle("worktree.fileRead", { target, path: "one.txt" })).rejects.toMatchObject({ code: "unsupported" });
    } finally { await e.supervisor.kill(own.agentId); await e.supervisor.kill(other.agentId); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  }, 20000);
});
