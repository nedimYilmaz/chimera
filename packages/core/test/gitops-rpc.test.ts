import { describe, expect, it } from "vitest";
import { GitOpsRpc } from "../src/rpc/gitops-rpc.js";
import { GitOps } from "../src/gitops.js";
import { FileWriteRequestSchema, GitStageRequestSchema } from "@chimera/protocol";
import { MCP_TOOL_TABLE } from "@chimera/protocol/mcp-tools";

describe("Git RPC authority and strict contracts", () => {
  it("rejects a foreign lease before any file or git mutation", () => {
    const rpc = new GitOpsRpc({ resolve: () => "/not-touched", writeReason: () => "foreign live holder", ops: new GitOps(() => { throw new Error("must not execute"); }) });
    expect(() => rpc.handlers["worktree.fileWrite"]({ target: { agentId: "other" }, path: "file", text: "draft", expectedContentVersion: "version", callerAgentId: "caller" })).toThrow("lease_held");
    expect(() => rpc.handlers["worktree.gitStage"]({ target: { agentId: "other" }, paths: ["file"], unstage: false, expectedHead: "head", expectedIndexFingerprint: "index", callerAgentId: "caller" })).toThrow("lease_held");
    expect(() => rpc.handlers["worktree.gitCommit"]({ target: { agentId: "other" }, message: "reviewed", expectedHead: "head", expectedIndexFingerprint: "index", callerAgentId: "caller" })).toThrow("lease_held");
  });
  it("requires explicit CAS fields and refuses root/identity/path escapes", () => {
    const input = { target: { agentId: "a" }, path: "file", text: "draft", expectedContentVersion: "v" };
    expect(FileWriteRequestSchema.safeParse(input).success).toBe(true);
    expect(FileWriteRequestSchema.safeParse({ ...input, root: "/" }).success).toBe(false);
    for (const path of ["../x", "/x", "a/../x", "a//x", ".git/config", ".GIT/config"]) expect(FileWriteRequestSchema.safeParse({ ...input, path }).success).toBe(false);
    expect(GitStageRequestSchema.safeParse({ target: { agentId: "a" }, paths: ["file"] }).success).toBe(false);
  });
  it("exposes six caller-scoped MCP tools with no identity argument or anonymous widening", () => {
    const tools = MCP_TOOL_TABLE.filter(t => /^worktree_(git_(status|diff|stage|commit)|file_(read|write))$/.test(t.name)); expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.inputSchema).not.toHaveProperty("callerAgentId");
      const resolved = tool.resolve({ target: { agentId: "foreign" }, callerAgentId: "forged" }, { agentId: "actual" } as never);
      expect(resolved).toMatchObject({ kind: "rpc", params: { callerAgentId: "actual" } });
      expect(tool.resolve({}, {} as never)).toMatchObject({ kind: "error" });
    }
  });
});
