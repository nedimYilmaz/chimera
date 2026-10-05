import { makeFedHome } from "./fed-helpers.js";
import { Engine } from "../src/engine.js";
import { FakeAgentBackend } from "../src/backends/fake.js";
import { rmSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { ContextLinksRpc } from "../src/rpc/context-links-rpc.js";
import type { ContextLinkStore } from "../src/context-links.js";
import { ContextLinkCreateSchema, ContextLinkTargetSchema } from "@chimera/protocol";
it("strict requests reject identity/authority forgery and qualified source IDs", () => {
  expect(ContextLinkTargetSchema.safeParse({ id: "e3b11b08-2ae3-4df6-a13c-f8885edfd0fb", operator: true }).success).toBe(false);
  expect(ContextLinkCreateSchema.safeParse({ from: { kind: "agent-summary", ref: "peer:a" }, toAgentId: "b" }).success).toBe(false);
});
describe("context RPC authority", () => {
  it("omitting caller identity never means operator authority", () => {
    const store = { list: vi.fn() }; const rpc = new ContextLinksRpc(store as unknown as ContextLinkStore);
    expect(() => rpc.handlers["contextlink.list"]({})).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(store.list).not.toHaveBeenCalled(); rpc.operator("contextlink.list", {}); expect(store.list).toHaveBeenCalledWith({}, { operator: true });
  });
  it("even on operator transport a caller field retains agent scope; notification sends ID only", async () => {
    const store = { create: vi.fn(() => ({ id: "link-id" })), list: vi.fn() }, notify = vi.fn(async () => {});
    const rpc = new ContextLinksRpc(store as unknown as ContextLinkStore, notify);
    rpc.operator("contextlink.list", { callerAgentId: "a" }); expect(store.list).toHaveBeenCalledWith({ callerAgentId: "a" }, { agentId: "a" });
    await rpc.handlers["contextlink.create"]({ from: { kind: "agent-summary", ref: "a" }, toAgentId: "b", notify: true, callerAgentId: "a" });
    expect(notify).toHaveBeenCalledWith("b", "link-id");
  });
});
it("notification success reports queued, not provider consumption; failure leaves the shared ID reviewable", async () => {
  const store = { create: vi.fn(() => ({ id: "stable-id" })) } as unknown as ContextLinkStore;
  const input = { from: { kind: "agent-summary" as const, ref: "a" }, toAgentId: "b", callerAgentId: "a", notify: true };
  expect(await new ContextLinksRpc(store).handlers["contextlink.create"](input)).toMatchObject({ id: "stable-id", notification: "queued" });
  const rpc = new ContextLinksRpc(store, async () => { throw new Error("provider unavailable"); });
  expect(await rpc.handlers["contextlink.create"](input)).toMatchObject({ id: "stable-id", notification: "failed" });
});

it("registered peers cannot access context RPCs even with forged local authority", async () => {
  const home = makeFedHome({ id: "context-host", peers: [{ engineId: "peer", publicKey: "test-key", socketPath: "/tmp/unused-context-peer.sock" }] });
  const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([])]]) });
  try {
    for (const method of ["contextlink.create", "contextlink.list", "contextlink.get", "contextlink.revoke"]) await expect(engine.handlePeer("peer", method, { trustedLocalClient: true, callerAgentId: "a" })).rejects.toMatchObject({ code: "protocol" });
  } finally { await engine.federation?.stop(); rmSync(home, { recursive: true, force: true }); }
});
