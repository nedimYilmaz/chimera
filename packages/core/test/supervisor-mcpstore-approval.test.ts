import { describe, it, expect } from "vitest";
import { UnknownAgentError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";

// TRUST-TIER: AgentSupervisor.requestMcpStoreApproval — the entry point engine.ts's
// "mcpstore.call" gate uses when broker.decideMcpStoreCall classifies an untrusted server's
// write-capable tool call as "prompt". Mirrors decidePermission()'s pendingPermissions
// register-before-emit + timeout discipline but as a standalone method (see its doc comment
// for why it doesn't reuse decidePermission itself).

describe("AgentSupervisor.requestMcpStoreApproval", () => {
  it("throws UnknownAgentError for a ghost/unknown agentId — caller must treat this as a denial (fail closed)", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.requestMcpStoreApproval("ghost-agent-id", { server: "gateway", tool: "slack__post", reason: "x" }))
      .rejects.toThrow(UnknownAgentError);
  });

  it("emits a permission_request event reusing the SAME event kind decidePermission uses — zero new UI surface needed", async () => {
    const { sup, events } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);

    const pending = sup.requestMcpStoreApproval(rec.agentId, { server: "gateway", tool: "slack__slack_post_message", reason: "untrusted + write-capable" });
    const tail = events.tail(rec.agentId, 50);
    const req = tail.find((e) => e.kind === "permission_request");
    expect(req).toBeTruthy();
    expect(req?.data["toolName"]).toBe("mcp_store:gateway__slack__slack_post_message");
    expect(req?.data["input"]).toMatchObject({ server: "gateway", tool: "slack__slack_post_message" });

    sup.respondPermission(String(req?.data["requestId"]), true);
    expect(await pending).toBe(true);
  });

  it("respondPermission(false) resolves the approval to false (a human explicitly denied)", async () => {
    const { sup, events } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);

    const pending = sup.requestMcpStoreApproval(rec.agentId, { server: "gateway", tool: "slack__slack_post_message", reason: "x" });
    const req = events.tail(rec.agentId, 50).find((e) => e.kind === "permission_request");
    sup.respondPermission(String(req?.data["requestId"]), false);
    expect(await pending).toBe(false);
  });

  // FAIL CLOSED: unlike decidePermission's Bash/foreign-MCP timeout (which falls back to the
  // profile's autoDecision), a timeout here resolves false — there is no "safe default profile"
  // for an untrusted server's write-capable call to fall back to.
  it("times out to false (never true) when nobody answers, and stamps a timedOut status event", async () => {
    const { sup, events } = makeSupervisor([[{ end: { resultText: "done" } }]]);   // permissionTimeoutMs: 100 (helpers.ts)
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);

    const allow = await sup.requestMcpStoreApproval(rec.agentId, { server: "gateway", tool: "slack__slack_post_message", reason: "x" });
    expect(allow).toBe(false);

    const tail = events.tail(rec.agentId, 50);
    const resolved = tail.find((e) => e.kind === "status" && e.data["permissionResolved"] === true);
    expect(resolved?.data).toMatchObject({ allow: false, timedOut: true });
  });
});
