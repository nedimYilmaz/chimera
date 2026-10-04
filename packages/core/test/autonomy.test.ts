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

// AGENT-AUTONOMY carve-out: autonomy:"full" silences ask_human/ask_agent/ask_team and
// AskUserQuestion dialogs, but must NOT touch the three toolPolicy-forced-ask gates
// (CLOUD-MUTATION-GATE, host toolPolicy "ask", foreign-MCP "prompt") — those put a human in
// front of a SPECIFIC dangerous action regardless of autonomy, a deliberately different concern
// than "stop asking my opinion". Mirrors supervisor-cloud-mutation-gate.test.ts's and
// supervisor-toolpolicy.test.ts's own setup, just with autonomy:"full" added to the spec.

function makeSupervisorWithPolicy(
  scenarios: FakeStep[][],
  policy: (tool: string, profile: string | null) => ToolPolicyMode,
  mcpPolicy?: (tool: string, serverKey: string) => ToolPolicyMode | null,
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-autonomy-polsup-"));
  const fake = new FakeAgentBackend(scenarios);
  const events = new EventLog(dir);
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
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    capabilityBroker,
  });
  return { sup, events, dir };
}

// full autonomy + full permission profile + auto policy: the worst case for enforcement —
// without a forced-ask gate, every tool call auto-allows with no human touchpoint at all.
const FULL_AUTONOMY_FULL_AUTO = {
  prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
  permissionProfile: "full", on: { permissionRequest: "auto" }, autonomy: "full",
} as const;

const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });
const mcp = (toolName: string): FakeStep => ({ askPermission: { toolName, input: {} } });
const JIRA_TOOL = "mcp__plugin_atlassian_atlassian__getJiraIssue";

describe("AGENT-AUTONOMY carve-out: forced-ask gates still fire under autonomy:\"full\"", () => {
  it("CLOUD-MUTATION-GATE still forces the ask flow for a mutating cloud command", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl delete pod mypod"), { end: { resultText: "done" } }]],
      () => "allow",
    );
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(FULL_AUTONOMY_FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "tool_call")).toBe(true);   // approved, so it ran
  });

  it("host toolPolicy \"ask\" still forces the standard permission_request flow", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("gh --hostname ghe.corp pr list"), { end: { resultText: "d" } }]],
      (tool) => (tool === "gh" ? "ask" : "allow"),
    );
    let sawRequest = false;
    events.subscribe((e) => {
      if (e.kind !== "permission_request") return;
      sawRequest = true;
      expect(e.data).toMatchObject({ policyAsk: true, tool: "gh", profile: "ghe.corp" });
      sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(FULL_AUTONOMY_FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(sawRequest).toBe(true);
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  it("foreign-MCP \"prompt\" still forces the standard permission_request flow", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => "ask",
    );
    let sawRequest = false;
    events.subscribe((e) => {
      if (e.kind !== "permission_request") return;
      sawRequest = true;
      expect(e.data).toMatchObject({ policyAsk: true, tool: JIRA_TOOL });
      sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(FULL_AUTONOMY_FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(sawRequest).toBe(true);
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  it("an unanswered forced-ask under autonomy:\"full\" still times out to autoDecision, never hangs", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("aws ec2 terminate-instances --instance-ids i-1"), { end: { resultText: "d" } }]],
      () => "allow",
    );
    // no responder subscribed → the 100ms permissionTimeoutMs fires
    const rec = await sup.spawn(FULL_AUTONOMY_FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.some((e) => e.kind === "permission_request")).toBe(true);
    // fallback is autoDecision(permissionProfile:"full") → allow, same as the non-autonomy case
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });
});
