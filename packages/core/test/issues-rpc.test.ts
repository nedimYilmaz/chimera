import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events.js";
import { QueueStore } from "../src/queues.js";
import { IssuesBoard } from "../src/issues-board.js";
import { IssuesRpc } from "../src/rpc/issues-rpc.js";
import { IssueSourceUpsertRequestSchema, IssuePostCommentRequestSchema } from "@chimera/protocol";
function rig() {
  const home = mkdtempSync(join(tmpdir(), "issues-rpc-")); const queues = new QueueStore(home, new EventLog(home));
  queues.create({ name: "mine", paused: true }); queues.create({ name: "foreign", paused: true });
  const board = new IssuesBoard({ home, queues, accepted: () => false, exec: async () => JSON.stringify([{ number: 1, title: "Task", body: "work", state: "OPEN", url: "https://github.com/demo/repo/issues/1", updatedAt: "2026-10-05T01:00:00Z" }]) });
  const deps = { board, queues, projectExists: (id: string) => ["p", "other"].includes(id), scope: (caller: string) => { if (caller !== "worker") throw new Error("Unknown caller"); return { projectId: "p", queue: "mine", conductor: false, projectQueues: ["mine", "foreign"] }; }, origin: vi.fn(async () => "conductor"), tick: vi.fn(async () => {}) };
  const rpc = new IssuesRpc(deps).handlers;
  const own = rpc["issues.sourceUpsert"](IssueSourceUpsertRequestSchema.parse({ projectId: "p", repo: "demo/repo", queue: "mine", callerAgentId: "worker" }));
  return { rpc, board, queues, own, deps };
}
describe("issues RPC queue scope", () => {
  it("agents cannot bind foreign queues/projects, create dispatch authority or import a running queue", async () => {
    const r = rig();
    for (const input of [{ projectId: "p", queue: "foreign" }, { projectId: "other", queue: "mine" }, { projectId: "p" }]) expect(() => r.rpc["issues.sourceUpsert"](IssueSourceUpsertRequestSchema.parse({ ...input, repo: "demo/repo", callerAgentId: "worker" }))).toThrow();
    const own = await r.own; r.queues.resume("mine");
    await expect(r.rpc["issues.sync"]({ sourceId: own.id, callerAgentId: "worker" })).rejects.toMatchObject({ code: "permission" });
    expect(r.deps.tick).not.toHaveBeenCalled();
  });
  it("filters reads, refuses foreign mutations, and stamps import provenance server-side", async () => {
    const r = rig(); const own = await r.own;
    const foreign = await r.rpc["issues.sourceUpsert"](IssueSourceUpsertRequestSchema.parse({ projectId: "other", repo: "other/repo", queue: "foreign" }));
    expect(await r.rpc["issues.sourceList"]({ callerAgentId: "worker" })).toEqual([own]);
    expect(() => r.rpc["issues.sourceRemove"]({ sourceId: foreign.id, callerAgentId: "worker" })).toThrow();
    await r.rpc["issues.sync"]({ sourceId: own.id, callerAgentId: "worker" });
    expect(r.queues.allTasks()[0]).toMatchObject({ pushedBy: "worker", originConductorId: "conductor", tags: ["gh-issue"] });
    expect(r.deps.origin).toHaveBeenCalledWith("mine", "worker"); expect(r.deps.tick).toHaveBeenCalledOnce();
    const links = await r.rpc["issues.linkList"]({ callerAgentId: "worker" }); expect(links).toHaveLength(1);
    await expect(r.rpc["issues.postComment"](IssuePostCommentRequestSchema.parse({ taskId: links[0]!.taskId, body: "x", phase: "confirm", callerAgentId: "worker" }))).rejects.toMatchObject({ code: "permission" });
  });
});
