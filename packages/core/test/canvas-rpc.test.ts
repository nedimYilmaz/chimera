import { describe, it, expect } from "vitest";
import { CanvasRpc } from "../src/rpc/canvas-rpc.js";
import { CanvasStore } from "../src/canvas-store.js";
import { emptyCanvasLayout } from "@chimera/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("canvas authority", () => {
  it("requires trusted operator or authenticated same-project caller and never leaks cosmetic notes", () => {
    const home = mkdtempSync(join(tmpdir(), "canvas-rpc-"));
    try {
      const store = new CanvasStore(home), agent = (id: string, projectId = "p", accountName = "account") => ({ agentId: id, projectId, accountName, principal: "local", treeId: "tree", state: "idle", spec: { isolation: "none" } });
      const rpc = new CanvasRpc({ store, projectQueues: () => ["q"], agents: () => [agent("a"), agent("b", "other"), agent("private", "p", "other")], tasks: () => [], artifacts: () => [], links: () => [], callerQueue: () => null });
      expect(() => rpc.handlers["canvas.get"]({ projectId: "p" })).toThrow("authenticated");
      expect(() => rpc.handlers["canvas.get"]({ projectId: "other", callerAgentId: "a" })).toThrow("own project");
      expect(() => rpc.handlers["canvas.saveLayout"]({ projectId: "p", baseRevision: 0, layout: emptyCanvasLayout() })).toThrow("operator");
      rpc.operator("canvas.saveLayout", { projectId: "p", baseRevision: 0, layout: { ...emptyCanvasLayout(), stickies: [{ id: "s", x: 0, y: 0, text: "private cosmetic note" }] } });
      const view = rpc.handlers["canvas.get"]({ projectId: "p", callerAgentId: "a" });
      expect(view).toMatchObject({ nodes: [{ entityId: "a" }], readOnly: true, layout: { stickies: [] } });
      expect(rpc.operator("canvas.get", { projectId: "p" })).toMatchObject({ revision: 1, layout: { stickies: [{ text: "private cosmetic note" }] } });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
it("recomputes membership after agent owner/account/project moves", () => {
  const home = mkdtempSync(join(tmpdir(), "canvas-owner-"));
  try {
    const a = { agentId: "a", projectId: "p", accountName: "account", principal: "local", treeId: "t", state: "idle", spec: { isolation: "none" } }, b = { ...a, agentId: "b" };
    const rpc = new CanvasRpc({ store: new CanvasStore(home), projectQueues: () => [], agents: () => [a, b], tasks: () => [], artifacts: () => [], links: () => [], callerQueue: () => null });
    expect(rpc.handlers["canvas.get"]({ projectId: "p", callerAgentId: "a" })).toMatchObject({ nodes: [{ entityId: "a" }, { entityId: "b" }] });
    b.accountName = "other"; expect(rpc.handlers["canvas.get"]({ projectId: "p", callerAgentId: "a" })).toMatchObject({ nodes: [{ entityId: "a" }] });
    a.projectId = "other"; expect(() => rpc.handlers["canvas.get"]({ projectId: "p", callerAgentId: "a" })).toThrow("own project");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
