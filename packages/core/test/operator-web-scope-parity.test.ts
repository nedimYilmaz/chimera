import { expect, it } from "vitest";
import { RPC_CONTRACT } from "@chimera/protocol/contract";
import { OPERATOR_WEB_ALLOW, OPERATOR_WEB_DENIED, webRequest } from "../src/operator-web-scopes.js";
function unclassified(contract: Record<string, unknown>) {
  return Object.keys(contract).filter(k => !Object.hasOwn(OPERATOR_WEB_ALLOW, k) && !Object.hasOwn(OPERATOR_WEB_DENIED, k));
}
it("classifies every contract RPC and fails for newly added methods", () => {
  expect(unclassified(RPC_CONTRACT)).toEqual([]);
  expect(unclassified({ ...RPC_CONTRACT, "new.unsafe": {} })).toEqual(["new.unsafe"]);
  expect(Object.keys(OPERATOR_WEB_DENIED).filter(k => !Object.hasOwn(RPC_CONTRACT, k))).toEqual([]);
});
it("denies provider settings, executable overrides, impersonation and arbitrary methods", () => {
  for (const method of ["agent.spawn", "config.patch", "terminal.write", "operatorweb.enable", "stt.install", "mcpstore.call", "new.unsafe"]) expect(() => webRequest(method, {})).toThrow();
  expect(() => webRequest("agent.send", { agentId: "a", text: "hi", from: "admin" })).toThrow();
  expect(() => webRequest("queue.push", { queue: "q", prompt: "hi", overrides: { permissionProfile: "full" } })).toThrow();
  expect(() => webRequest("review.decide", { taskId: "t", status: "accepted", summary: "ok", actorAgentId: "a" })).toThrow();
});
it.each(["agent.forkCapabilities", "agent.fork"] as const)("explicitly denies %s to browser sessions", method => {
  expect(OPERATOR_WEB_DENIED[method]).toContain("not authorized for browser sessions");
  expect(() => webRequest(method, { agentId: "parent", upToSeq: 17, mode: "snapshot", task: "Inspect an alternative", callerAgentId: "parent" }))
    .toThrowError(expect.objectContaining({ status: 403 }));
});

it.each(["group.list", "group.create", "group.update", "group.delete", "agent.setGroups", "agent.addGroups", "agent.removeGroups"] as const)("explicitly denies global Inspector operation %s to project-scoped browser sessions", method => {
  expect(OPERATOR_WEB_DENIED[method]).toMatch(/Inspector/);
  expect(() => webRequest(method, {})).toThrowError(expect.objectContaining({ status: 403 }));
});
