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
import { ToolPolicyStore } from "@chimera/core/hosttools";
import { CapabilityBroker } from "@chimera/core/broker";
import { CFG, fakeExec } from "./helpers.js";

// WD Stage 2 (coverage B14): toolPolicy ENFORCEMENT on the real decidePermission
// seam. The FakeAgentBackend's askPermission step drives the genuine
// canUseTool→decidePermission path, so these tests exercise the exact code the
// claude backend hits: deny → immediate rejection + policy_denied event; ask →
// the standard permission_request flow even under bypass/full+auto; allow →
// byte-identical to no policy at all.
// FEATURE-6: decidePermission now consults a CapabilityBroker instead of a bare
// toolPolicy function — this helper wraps the given `policy` fn in a broker (whose
// `emit` appends to the SAME EventLog as a capability_decision event) so every
// existing assertion below (about policy_denied/permission_request/tool_call) stays
// byte-identical; only the construction plumbing changed.

function makeSupervisorWithPolicy(
  scenarios: FakeStep[][],
  policy: (tool: string, profile: string | null) => ToolPolicyMode,
  // MCP-FOREIGN-POLICY: optional foreign-MCP seam. Absent ⇒ the broker's decideMcpTool returns
  // null and the foreign-MCP gate is inert (the pre-fix behavior every Bash test above relies on).
  mcpPolicy?: (tool: string, serverKey: string) => ToolPolicyMode | null,
) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-polsup-"));
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

// A full-profile, policy:"auto" spec — the WORST CASE for enforcement: without the
// gate, every tool call auto-allows without any event at all.
const FULL_AUTO = {
  prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
  permissionProfile: "full", on: { permissionRequest: "auto" },
} as const;

const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });
const mcp = (toolName: string): FakeStep => ({ askPermission: { toolName, input: {} } });

// MCP-FOREIGN-POLICY: an acceptEdits agent under policy "auto" — the ACTUAL profile team/queue
// workers default to (engine.ts), the whole point of the fix. Without the foreign-MCP gate, a
// mcp__<server>__<tool> call here falls to autoDecision → silent deny (not full, not chimera,
// not a READ/EDIT tool). The gate is what makes it grantable.
const ACCEPTEDITS_AUTO = {
  prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
  permissionProfile: "acceptEdits", on: { permissionRequest: "auto" },
} as const;

describe("toolPolicy enforcement in decidePermission (coverage B14)", () => {
  it("deny: the call is rejected immediately EVEN under full/auto, and policy_denied is emitted with tool+profile+command", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl --context prod get pods"), { end: { resultText: "done" } }]],
      (tool, profile) => (tool === "kubectl" && profile === "prod" ? "deny" : "allow"),
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    // rejected: the fake emits a denied status instead of tool_call
    expect(tail.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(true);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(0);
    // the audit event carries the parsed target and the full command
    const denied = tail.find((e) => e.kind === "policy_denied");
    expect(denied?.data).toMatchObject({ tool: "kubectl", profile: "prod", command: "kubectl --context prod get pods" });
    // and NO permission round-trip happened (deny is instant)
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
  });

  it("deny catches the tool in a LATER segment (cd /x && kubectl ...)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("cd /repo && kubectl --context=prod apply -f a.yaml"), { end: { resultText: "d" } }]],
      (tool, profile) => (tool === "kubectl" && profile === "prod" ? "deny" : "allow"),
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(events.tail(rec.agentId, 50).some((e) => e.kind === "policy_denied")).toBe(true);
  });

  it("deny via env-assignment profile detection (AWS_PROFILE=prod aws ...)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("AWS_PROFILE=prod aws s3 ls"), { end: { resultText: "d" } }]],
      (tool, profile) => (tool === "aws" && profile === "prod" ? "deny" : "allow"),
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const denied = events.tail(rec.agentId, 50).find((e) => e.kind === "policy_denied");
    expect(denied?.data).toMatchObject({ tool: "aws", profile: "prod" });
  });

  it("profile vs wildcard matrix on a REAL ToolPolicyStore: prod denied, staging (wildcard allow) passes", async () => {
    const store = new ToolPolicyStore(mkdtempSync(join(tmpdir(), "chimera-polstore-")), { kubectl: { "*": "allow", prod: "deny" } });
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl --context staging get pods"), bash("kubectl --context prod get pods"), { end: { resultText: "d" } }]],
      (tool, profile) => store.modeFor(tool, profile),
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);           // staging ran
    const denied = tail.filter((e) => e.kind === "policy_denied");
    expect(denied).toHaveLength(1);                                               // prod did not
    expect(denied[0]?.data).toMatchObject({ tool: "kubectl", profile: "prod" });
  });

  it("ask: forces the standard permission_request flow even under full/auto — answered allow, the call proceeds", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("gh --hostname ghe.corp pr list"), { end: { resultText: "d" } }]],
      (tool) => (tool === "gh" ? "ask" : "allow"),
    );
    let sawRequest = false;
    events.subscribe((e) => {
      if (e.kind !== "permission_request") return;
      sawRequest = true;
      // the additive policy stamps say WHY an auto/full agent got a prompt
      expect(e.data).toMatchObject({ policyAsk: true, tool: "gh", profile: "ghe.corp", toolName: "Bash" });
      sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(sawRequest).toBe(true);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("ask answered deny → the call is rejected through the standard flow (no policy_denied — that event is deny-mode only)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("terraform apply"), { end: { resultText: "d" } }]],
      (tool) => (tool === "terraform" ? "ask" : "allow"),
    );
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), false);
    });
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(true);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("ask under a policy that already routes (tui) stays ONE request — no double prompt", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl get pods"), { end: { resultText: "d" } }]],
      (tool) => (tool === "kubectl" ? "ask" : "allow"),
    );
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn({ ...FULL_AUTO, on: { permissionRequest: "tui" } });
    await sup.waitFor(rec.agentId, 1000);
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "permission_request")).toHaveLength(1);
  });

  it("READONLY-BASH-NO-PROMPT: a toolPolicy 'ask' rule still wins over the new read-only auto-allow (acceptEdits, kubectl get)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl get pods -n prod"), { end: { resultText: "d" } }]],
      (tool) => (tool === "kubectl" ? "ask" : "allow"),
    );
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "acceptEdits", on: { permissionRequest: "auto" },
    });
    await sup.waitFor(rec.agentId, 1000);
    // Without the toolPolicyGate (which runs BEFORE decidePermission's fast path),
    // isReadOnlyBash("kubectl get pods -n prod") === true would auto-allow this under
    // acceptEdits with no card at all — proving the "ask" policy still wins over it.
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "permission_request")).toHaveLength(1);
  });

  it("allow (and unlisted tools): behavior is byte-identical — no permission_request, no policy events, call auto-allowed", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("git status"), { end: { resultText: "d" } }]],
      () => "allow",
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "permission_request" || e.kind === "policy_denied")).toBe(false);
  });

  it("non-Bash tools NEVER consult the policy (a Read named 'kubectl' in input passes untouched)", async () => {
    let consulted = 0;
    const { sup, events } = makeSupervisorWithPolicy(
      [[{ askPermission: { toolName: "Read", input: { file_path: "kubectl --context prod" } } }, { end: { resultText: "d" } }]],
      () => { consulted++; return "deny"; },
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(consulted).toBe(0);
    expect(events.tail(rec.agentId, 50).filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  it("a Bash call with a NON-STRING command input skips the gate (defensive input handling)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[{ askPermission: { toolName: "Bash", input: { command: 42 } } }, { end: { resultText: "d" } }]],
      () => "deny",
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(events.tail(rec.agentId, 50).some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("no toolPolicy seam wired → the whole gate is absent (existing deployments byte-identical)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-nopol-"));
    const events = new EventLog(dir);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(CFG), credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", new FakeAgentBackend([[bash("kubectl --context prod get pods"), { end: { resultText: "d" } }]])]]),
      events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100,
    });
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied" || e.kind === "permission_request")).toBe(false);
  });
});

// FEATURE-6: the capability broker is now the thing decidePermission's toolPolicyGate
// actually calls (see makeSupervisorWithPolicy above) — these cases prove it's really in
// the loop (not just plumbed and ignored) by asserting the NEW capability_decision audit
// event it emits, on top of the untouched policy_denied/permission_request events the
// tests above already pin.
describe("capability_decision audit event (FEATURE-6)", () => {
  it("deny: a capability_decision event with decision:deny is emitted alongside policy_denied", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("kubectl --context prod get pods"), { end: { resultText: "done" } }]],
      (tool, profile) => (tool === "kubectl" && profile === "prod" ? "deny" : "allow"),
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    const decision = tail.find((e) => e.kind === "capability_decision");
    expect(decision?.data).toMatchObject({
      principal: rec.agentId, action: "host_tool", resource: "kubectl:prod",
      decision: "deny", tool: "kubectl", profile: "prod",
    });
  });

  it("ask: a capability_decision event with decision:prompt is emitted", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("gh --hostname ghe.corp pr list"), { end: { resultText: "d" } }]],
      (tool) => (tool === "gh" ? "ask" : "allow"),
    );
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const decision = events.tail(rec.agentId, 50).find((e) => e.kind === "capability_decision");
    expect(decision?.data).toMatchObject({ principal: rec.agentId, action: "host_tool", resource: "gh:ghe.corp", decision: "prompt" });
  });

  it("allow: a capability_decision event with decision:allow is STILL emitted (the broker sees every decision, not just deny/ask)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[bash("git status"), { end: { resultText: "d" } }]],
      () => "allow",
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const decision = events.tail(rec.agentId, 50).find((e) => e.kind === "capability_decision");
    expect(decision?.data).toMatchObject({ principal: rec.agentId, action: "host_tool", resource: "git", decision: "allow" });
  });
});

// MCP-FOREIGN-POLICY: the foreign (non-chimera) MCP tool decision matrix on the REAL
// decidePermission seam, for an acceptEdits+auto agent (the affected worker default). The bug:
// such a tool used to fall to autoDecision → silent deny with no way to grant it. Now toolPolicy
// governs it, and an UNSET policy ASKS (routes into permission_request) instead of denying.
const JIRA_TOOL = "mcp__plugin_atlassian_atlassian__getJiraIssue";
describe("foreign MCP toolPolicy enforcement (MCP-FOREIGN-POLICY)", () => {
  it("config allow → the tool runs with NO prompt and NO policy_denied, even though autoDecision would have denied it", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",                                          // host-tool (Bash) policy — irrelevant here
      (tool) => (tool === JIRA_TOOL ? "allow" : null),
    );
    const rec = await sup.spawn(ACCEPTEDITS_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "permission_request" || e.kind === "policy_denied")).toBe(false);
    // audited as an mcp_tool allow
    expect(tail.find((e) => e.kind === "capability_decision")?.data).toMatchObject({
      action: "mcp_tool", resource: JIRA_TOOL, decision: "allow",
    });
  });

  it("UNSET policy → a permission_request surfaces (answerable from TUI/app) with the full tool name; answered allow, the call proceeds", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => null,                                             // nothing configured for any MCP tool
    );
    let sawRequest = false;
    events.subscribe((e) => {
      if (e.kind !== "permission_request") return;
      sawRequest = true;
      expect(e.data).toMatchObject({ policyAsk: true, tool: JIRA_TOOL, toolName: JIRA_TOOL });
      sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(ACCEPTEDITS_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    expect(sawRequest).toBe(true);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("UNSET policy, request UNANSWERED → times out to autoDecision (deny for acceptEdits) — no hang, unattended-safe", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => null,
    );
    const rec = await sup.spawn(ACCEPTEDITS_AUTO);        // no responder subscribed → the 100ms timeout fires
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.some((e) => e.kind === "permission_request")).toBe(true);   // it ASKED (not an instant deny)
    expect(tail.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(true);  // then timed out → deny
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(0);
  });

  it("config deny → policy_denied (with the full tool name), no permission round-trip", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => "deny",
    );
    const rec = await sup.spawn(ACCEPTEDITS_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    const denied = tail.find((e) => e.kind === "policy_denied");
    expect(denied?.data).toMatchObject({ tool: JIRA_TOOL });
    expect(denied?.data["command"]).toBeUndefined();   // an MCP call has no command/profile
    expect(denied?.data["profile"]).toBeUndefined();
    expect(tail.some((e) => e.kind === "permission_request")).toBe(false);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(0);
  });

  it("config ask → forces the standard permission_request flow (like a Bash ask)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => "ask",
    );
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(ACCEPTEDITS_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(1);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  it("full profile + UNSET policy → frictionless (allowed instantly, NO 120s prompt) — mirrors the Bash gate's allow-by-default for full", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => null,                                            // nothing configured
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "permission_request" || e.kind === "policy_denied")).toBe(false);
    // audited as an allow (the unset-default resolved to allow for full)
    expect(tail.find((e) => e.kind === "capability_decision")?.data).toMatchObject({ action: "mcp_tool", decision: "allow" });
  });

  it("full profile + EXPLICIT deny → still denied (an operator deny overrides even full, like the Bash gate)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => "deny",
    );
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(true);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(0);
  });

  it("full profile + EXPLICIT ask → still prompts (defense-in-depth applies to full, like the Bash gate)", async () => {
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp(JIRA_TOOL), { end: { resultText: "d" } }]],
      () => "allow",
      () => "ask",
    );
    events.subscribe((e) => {
      if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true);
    });
    const rec = await sup.spawn(FULL_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(1);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  it("mcp__chimera__* is NEVER gated — auto-allowed under acceptEdits, the MCP seam is not even consulted", async () => {
    let mcpConsulted = 0;
    const { sup, events } = makeSupervisorWithPolicy(
      [[mcp("mcp__chimera__memory_add"), { end: { resultText: "d" } }]],
      () => "allow",
      () => { mcpConsulted++; return "deny"; },      // would deny IF consulted — it must NOT be
    );
    const rec = await sup.spawn(ACCEPTEDITS_AUTO);
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(mcpConsulted).toBe(0);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "permission_request" || e.kind === "policy_denied")).toBe(false);
  });
});
