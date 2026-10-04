import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolPolicyMode } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { CapabilityBroker } from "@chimera/core/broker";
import { CFG, fakeExec } from "./helpers.js";

// DENIED-TOOL-CALL-INVISIBLE: a host-tool-policy deny used to reach the agent as an opaque
// generic refusal, leave no trace on AgentRecord, and never reach a deliverTo conductor —
// exactly the gap that let 10 kubectl policy_denied events during 2026-08-14's incident go
// completely unnoticed by the operator, the agent, and the conductor alike. This proves the
// fix: the agent gets an actionable message naming the tool/profile, AgentRecord.toolPolicyDenied
// (+lastToolPolicyDenial detail) is stamped as DATA, and a deliverTo conductor's mailbox message
// carries the flag too — generalizing the exact landingPermissionDenied pattern
// (supervisor-landing-permission-denied.test.ts) from one denial class to any host-tool-policy deny.

function makeSupervisorWithPolicy(
  scenarios: FakeStep[][],
  policy: (tool: string, profile: string | null) => ToolPolicyMode,
  mcpPolicy?: (tool: string, serverKey: string) => ToolPolicyMode | null,
  deliverTo?: string,
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-poldenied-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
  const mailboxes = new MailboxStore(dir);
  const capabilityBroker = new CapabilityBroker(
    policy,
    (event) => events.append({ agentId: event.principal ?? "capability", kind: "capability_decision", data: event }),
    mcpPolicy,
  );
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes,
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    capabilityBroker,
  });
  return { sup, events, mailboxes, dir };
}

const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });
const mcp = (toolName: string): FakeStep => ({ askPermission: { toolName, input: {} } });

const FULL_AUTO = {
  prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
  permissionProfile: "full", on: { permissionRequest: "auto" },
} as const;

describe("DENIED-TOOL-CALL-INVISIBLE: toolPolicyDenied stamping + agent-facing message", () => {
  it("Bash deny with a NAMED profile: record stamped, message names tool+profile, no shell-var flag", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl --context eks-qa get pods"), { end: { resultText: "I'm blocked, stopping." } }]],
      (tool, profile) => (tool === "kubectl" && profile === "eks-qa" ? "deny" : "allow"),
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const status = sup.status(rec.agentId);
    expect(status.toolPolicyDenied).toBe(true);
    expect(status.lastToolPolicyDenial).toMatchObject({ tool: "kubectl", profile: "eks-qa" });
    expect(status.lastToolPolicyDenial?.profileUnresolved).toBeUndefined();
    const denied = events.tail(rec.agentId, 50).find((e) => e.kind === "status" && e.data["denied"] === true);
    const message = String(denied?.data["message"] ?? "");
    expect(message).toContain("kubectl");
    expect(message).toContain("eks-qa");
    expect(message).toContain("Denied by host-tool policy");
    expect(message.toLowerCase()).toContain("do not retry");
  });

  it("Bash deny with NO profile in the command: message says so, profileUnresolved not set", async () => {
    const { sup } = makeSupervisorWithPolicy(
      [[bash("kubectl get pods"), { end: { resultText: "done" } }]],
      (tool) => (tool === "kubectl" ? "deny" : "allow"),
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const status = sup.status(rec.agentId);
    expect(status.toolPolicyDenied).toBe(true);
    expect(status.lastToolPolicyDenial?.profile).toBeNull();
    expect(status.lastToolPolicyDenial?.profileUnresolved).toBeUndefined();
  });

  it("Bash deny with an UNRESOLVED shell-variable profile ($ctx): flagged distinctly from a plain no-profile deny", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl --context $ctx get pods"), { end: { resultText: "done" } }]],
      () => "deny",
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const status = sup.status(rec.agentId);
    expect(status.lastToolPolicyDenial?.profile).toBe("$ctx");
    expect(status.lastToolPolicyDenial?.profileUnresolved).toBe(true);
    const denied = events.tail(rec.agentId, 50).find((e) => e.kind === "policy_denied");
    expect(denied?.data["profileUnresolved"]).toBe(true);
    const deniedStatus = events.tail(rec.agentId, 50).find((e) => e.kind === "status" && e.data["denied"] === true);
    expect(String(deniedStatus?.data["message"])).toContain("UNRESOLVED shell variable");
  });

  it("foreign MCP deny: record stamped with tool, profile null, message names the tool", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp("mcp__ekb__search"), { end: { resultText: "done" } }]],
      () => "allow",
      () => "deny",
    );
    const rec = await sup.spawn({ ...FULL_AUTO, permissionProfile: "acceptEdits" });
    await sup.waitFor(rec.agentId, 1000);
    const status = sup.status(rec.agentId);
    expect(status.toolPolicyDenied).toBe(true);
    expect(status.lastToolPolicyDenial).toMatchObject({ tool: "mcp__ekb__search", profile: null });
    const denied = events.tail(rec.agentId, 50).find((e) => e.kind === "status" && e.data["denied"] === true);
    expect(String(denied?.data["message"])).toContain("mcp__ekb__search");
  });

  it("is NOT set on a clean finish with no policy denial", async () => {
    const { sup } = makeSupervisorWithPolicy(
      [[bash("kubectl get pods"), { end: { resultText: "done" } }]],
      () => "allow",
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.status(rec.agentId).toolPolicyDenied).toBeUndefined();
    expect(sup.status(rec.agentId).lastToolPolicyDenial).toBeUndefined();
  });

  it("propagates to a deliverTo conductor's mailbox on the SAME well-formed-result path that previously hid the give-up", async () => {
    const { sup, mailboxes } = makeSupervisorWithPolicy(
      [[bash("kubectl --context eks-qa get pods"), { end: { resultText: "I hit a policy denial and I'm stopping." } }]],
      (tool, profile) => (tool === "kubectl" && profile === "eks-qa" ? "deny" : "allow"),
    );
    const rec = await sup.spawn({ ...FULL_AUTO, deliverTo: "conductor-1" });
    await sup.waitFor(rec.agentId, 1000);
    const drained = mailboxes.drain("conductor-1");
    const childResult = drained.find((m) => m.kind === "child_result");
    expect(childResult?.meta?.["toolPolicyDenied"]).toBe(true);
  });
});
