import { describe, it, expect } from "vitest";
import { RPC_CONTRACT } from "../src/contract.js";
import { IssueSourceUpsertRequestSchema, IssuePostCommentRequestSchema, IssuePostCommentResultSchema } from "../src/issues.js";
describe("issues protocol", () => {
  it("defaults to opt-in paused provisioning and bounded explicit scope", () => {
    expect(IssueSourceUpsertRequestSchema.parse({ projectId: "p", repo: "demo/repo" })).toMatchObject({ enabled: true, labels: [], state: "open", allowRunningQueue: false });
    for (const input of [{ repo: "--bad" }, { labels: Array(9).fill("bug") }, { labels: ["bad\nflag"] }, { token: "forbidden" }]) expect(IssueSourceUpsertRequestSchema.safeParse({ projectId: "p", repo: "demo/repo", ...input }).success).toBe(false);
  });
  it("keeps uncertain comment and partial close results distinct without weakening strict validation", () => {
    const base = { previewId: null, repo: "demo/repo", number: 1, body: "reviewed result", closeIssue: true, message: "inspect issue" };
    expect(IssuePostCommentResultSchema.parse({ ...base, status: "uncertain", commentStatus: "uncertain", closeStatus: "not_attempted" }).status).toBe("uncertain");
    expect(IssuePostCommentResultSchema.parse({ ...base, status: "partial", commentStatus: "posted", closeStatus: "uncertain" }).commentStatus).toBe("posted");
    expect(IssuePostCommentResultSchema.safeParse({ ...base, status: "uncertain", token: "not allowed" }).success).toBe(false);
  });
  it("preview is the default; contract covers all six strict methods", () => {
    expect(IssuePostCommentRequestSchema.parse({ taskId: "t", body: "result" })).toMatchObject({ phase: "preview", closeIssue: false });
    for (const method of ["issues.sourceList", "issues.sourceUpsert", "issues.sourceRemove", "issues.sync", "issues.linkList", "issues.postComment"] as const) expect(RPC_CONTRACT[method].request.safeParse({ impossible: true }).success).toBe(false);
  });
});
