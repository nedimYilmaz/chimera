import { describe, it, expect } from "vitest";
import type { ToolPolicyMode, CapabilityDecisionEvent } from "@chimera/protocol";
import { CapabilityBroker, mcpServerKey } from "@chimera/core/broker";

// FEATURE-6: unit tests for CapabilityBroker in isolation — no supervisor/engine
// involved. supervisor-toolpolicy.test.ts and engine-mcpstore.test.ts cover the
// broker wired into the real decidePermission/mcpstore.call call sites.

function makeBroker(mode: ToolPolicyMode | ((tool: string, profile: string | null) => ToolPolicyMode)) {
  const events: CapabilityDecisionEvent[] = [];
  const hostToolMode = typeof mode === "function" ? mode : () => mode;
  const broker = new CapabilityBroker(hostToolMode, (e) => events.push(e));
  return { broker, events };
}

describe("CapabilityBroker.decideHostTool", () => {
  it("allow mode -> decision allow, resource has no profile suffix when profile is null", () => {
    const { broker, events } = makeBroker("allow");
    const result = broker.decideHostTool("agent-1", "git", null, "git status");
    expect(result.decision).toBe("allow");
    expect(events).toEqual([{
      principal: "agent-1", action: "host_tool", resource: "git",
      decision: "allow", reason: expect.stringContaining("allow"),
      tool: "git", profile: null, command: "git status",
    }]);
  });

  it("deny mode -> decision deny, resource includes the profile", () => {
    const { broker, events } = makeBroker("deny");
    const result = broker.decideHostTool("agent-1", "kubectl", "prod", "kubectl --context prod get pods");
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("kubectl:prod");
    expect(events).toEqual([{
      principal: "agent-1", action: "host_tool", resource: "kubectl:prod",
      decision: "deny", reason: expect.stringContaining("kubectl:prod"),
      tool: "kubectl", profile: "prod", command: "kubectl --context prod get pods",
    }]);
  });

  it("ask mode -> decision prompt", () => {
    const { broker, events } = makeBroker("ask");
    const result = broker.decideHostTool("agent-1", "terraform", null, "terraform apply");
    expect(result.decision).toBe("prompt");
    expect(events[0]?.decision).toBe("prompt");
  });

  it("principal null (no known caller) is passed through untouched", () => {
    const { broker, events } = makeBroker("allow");
    broker.decideHostTool(null, "git", null, "git status");
    expect(events[0]?.principal).toBeNull();
  });

  it("consults the injected hostToolMode seam with the exact (tool, profile) given", () => {
    const calls: Array<[string, string | null]> = [];
    const { broker } = makeBroker((tool, profile) => { calls.push([tool, profile]); return "allow"; });
    broker.decideHostTool("a", "aws", "staging", "aws s3 ls");
    expect(calls).toEqual([["aws", "staging"]]);
  });
});

// GATED-BUT-ALLOWED-INVISIBLE: hostToolExplicit is a SEPARATE optional 4th constructor seam
// (not a widened hostToolMode return shape) specifically so the tests above — every one of
// which constructs a broker WITHOUT it — stay byte-identical (proven by the exact toEqual
// checks above still passing unmodified).
describe("CapabilityBroker.decideHostTool — explicitPolicy (GATED-BUT-ALLOWED-INVISIBLE)", () => {
  it("absent hostToolExplicit seam: never stamps explicitPolicy, even on allow", () => {
    const events: CapabilityDecisionEvent[] = [];
    const broker = new CapabilityBroker(() => "allow", (e) => events.push(e));
    broker.decideHostTool("a", "head", null, "head -150");
    expect(events[0]).not.toHaveProperty("explicitPolicy");
  });

  it("hostToolExplicit(tool) false (no configured row at all — argv noise): allow stays unstamped", () => {
    const events: CapabilityDecisionEvent[] = [];
    const broker = new CapabilityBroker(() => "allow", (e) => events.push(e), undefined, () => false);
    broker.decideHostTool("a", "wc", null, "wc -l");
    expect(events[0]).not.toHaveProperty("explicitPolicy");
  });

  it("hostToolExplicit(tool) true (an explicit row exists) + allow: stamps explicitPolicy true", () => {
    const events: CapabilityDecisionEvent[] = [];
    const broker = new CapabilityBroker(() => "allow", (e) => events.push(e), undefined, () => true);
    broker.decideHostTool("a", "kubectl", "eks-devops", "kubectl --context eks-devops get pods");
    expect(events[0]?.explicitPolicy).toBe(true);
  });

  it("hostToolExplicit(tool) true but decision is DENY: not stamped (deny is already visible via policy_denied)", () => {
    const events: CapabilityDecisionEvent[] = [];
    const broker = new CapabilityBroker(() => "deny", (e) => events.push(e), undefined, () => true);
    broker.decideHostTool("a", "kubectl", "prod", "kubectl --context prod get pods");
    expect(events[0]).not.toHaveProperty("explicitPolicy");
  });

  it("hostToolExplicit(tool) true but decision is PROMPT: not stamped (prompt is already visible via permission_request)", () => {
    const events: CapabilityDecisionEvent[] = [];
    const broker = new CapabilityBroker(() => "ask", (e) => events.push(e), undefined, () => true);
    broker.decideHostTool("a", "terraform", null, "terraform apply");
    expect(events[0]).not.toHaveProperty("explicitPolicy");
  });

  it("consults hostToolExplicit with the tool name only (no profile dimension)", () => {
    const calls: string[] = [];
    const broker = new CapabilityBroker(() => "allow", () => {}, undefined, (tool) => { calls.push(tool); return true; });
    broker.decideHostTool("a", "aws", "staging", "aws s3 ls");
    expect(calls).toEqual(["aws"]);
  });
});

describe("CapabilityBroker.decideMcpStoreCall", () => {
  it("always allows today (no mcp store policy dimension exists yet) and emits an audit event", () => {
    const { broker, events } = makeBroker("allow");   // hostToolMode is irrelevant here
    const result = broker.decideMcpStoreCall("agent-1", "chrome-devtools", "navigate_page");
    expect(result.decision).toBe("allow");
    expect(events).toEqual([{
      principal: "agent-1", action: "mcp_store_call", resource: "chrome-devtools:navigate_page",
      decision: "allow", reason: expect.any(String),
      server: "chrome-devtools", mcpTool: "navigate_page",
    }]);
  });

  it("principal null (no agentId threaded through) still allows and audits with a null principal", () => {
    const { broker, events } = makeBroker("allow");
    const result = broker.decideMcpStoreCall(null, "echo-server", "echo");
    expect(result.decision).toBe("allow");
    expect(events[0]?.principal).toBeNull();
  });
});

// TRUST-TIER: adversarial coverage for the classification decideMcpStoreCall now does. The
// happy-path default (trust "full", the value every pre-existing entry gets) is proven
// unaffected by the two tests above (called with no trust/readOnlyHint args at all).
describe("CapabilityBroker.decideMcpStoreCall — trust tiers", () => {
  it("untrusted server + write-capable tool (readOnlyHint absent) + real agent principal -> prompt", () => {
    const { broker, events } = makeBroker("allow");
    const result = broker.decideMcpStoreCall("agent-1", "gateway", "slack__slack_post_message", "untrusted", undefined);
    expect(result.decision).toBe("prompt");
    expect(events[0]?.decision).toBe("prompt");
  });

  it("untrusted server + write-capable tool (readOnlyHint explicitly false) + agent principal -> prompt", () => {
    const { broker } = makeBroker("allow");
    const result = broker.decideMcpStoreCall("agent-1", "gateway", "slack__slack_post_message", "untrusted", false);
    expect(result.decision).toBe("prompt");
  });

  it("untrusted server + READ-ONLY tool (readOnlyHint true) + agent principal -> allow (nothing to gate)", () => {
    const { broker } = makeBroker("allow");
    const result = broker.decideMcpStoreCall("agent-1", "gateway", "slack__slack_read_channel", "untrusted", true);
    expect(result.decision).toBe("allow");
  });

  it("untrusted server + write-capable tool + NULL principal (UI/RPC-originated, not an agent) -> allow", () => {
    const { broker } = makeBroker("allow");
    const result = broker.decideMcpStoreCall(null, "gateway", "slack__slack_post_message", "untrusted", undefined);
    expect(result.decision).toBe("allow");
  });

  it("trust full + write-capable tool + agent principal -> allow (default tier is unaffected)", () => {
    const { broker } = makeBroker("allow");
    const result = broker.decideMcpStoreCall("agent-1", "gateway", "slack__slack_post_message", "full", undefined);
    expect(result.decision).toBe("allow");
  });

  it("gated prompt decision's reason names the server, tool, and untrusted+write-capable cause", () => {
    const { broker } = makeBroker("allow");
    const result = broker.decideMcpStoreCall("agent-1", "gateway", "slack__slack_post_message", "untrusted", undefined);
    expect(result.reason).toContain("gateway");
    expect(result.reason).toContain("slack__slack_post_message");
    expect(result.reason.toLowerCase()).toContain("untrusted");
  });
});

// MCP-FOREIGN-POLICY: decideMcpTool turns a foreign-MCP toolPolicy verdict into a decision.
// Its DEFAULT differs from decideHostTool: an unset policy (seam → null) resolves to "prompt",
// so an ungoverned host MCP tool asks rather than silently allowing or denying.
function makeMcpBroker(mcpMode: ((tool: string, serverKey: string) => ToolPolicyMode | null) | undefined) {
  const events: CapabilityDecisionEvent[] = [];
  const broker = new CapabilityBroker(() => "allow", (e) => events.push(e), mcpMode);
  return { broker, events };
}

describe("mcpServerKey", () => {
  it("extracts the server key from a full mcp tool name (server may contain single underscores)", () => {
    expect(mcpServerKey("mcp__plugin_atlassian_atlassian__getJiraIssue")).toBe("mcp__plugin_atlassian_atlassian");
    expect(mcpServerKey("mcp__ekb__search")).toBe("mcp__ekb");
    expect(mcpServerKey("mcp__gateway__call")).toBe("mcp__gateway");
  });

  it("a malformed name with no second '__' yields itself (exact==server, lookup still resolves)", () => {
    expect(mcpServerKey("mcp__weird")).toBe("mcp__weird");
  });
});

describe("CapabilityBroker.decideMcpTool", () => {
  it("allow policy -> decision allow, audited with action mcp_tool and the full tool name as resource", () => {
    const { broker, events } = makeMcpBroker(() => "allow");
    const result = broker.decideMcpTool("agent-1", "mcp__ekb__search");
    expect(result?.decision).toBe("allow");
    expect(events).toEqual([{
      principal: "agent-1", action: "mcp_tool", resource: "mcp__ekb__search",
      decision: "allow", reason: expect.stringContaining("allows"),
      server: "mcp__ekb", mcpTool: "mcp__ekb__search",
      // GATED-BUT-ALLOWED-INVISIBLE: every mcp_tool "allow" is stamped explicitPolicy — see
      // that describe block below for the full rationale (no ungated-noise case exists for
      // foreign MCP the way argv-parsing junk does for Bash).
      explicitPolicy: true,
    }]);
  });

  it("deny policy -> decision deny", () => {
    const { broker, events } = makeMcpBroker(() => "deny");
    const result = broker.decideMcpTool("agent-1", "mcp__ekb__search");
    expect(result?.decision).toBe("deny");
    expect(events[0]?.decision).toBe("deny");
  });

  it("ask policy -> decision prompt", () => {
    const { broker } = makeMcpBroker(() => "ask");
    expect(broker.decideMcpTool("agent-1", "mcp__ekb__search")?.decision).toBe("prompt");
  });

  it("UNSET policy (seam returns null) -> decision prompt, NOT deny (ask-by-default for foreign MCP)", () => {
    const { broker, events } = makeMcpBroker(() => null);
    const result = broker.decideMcpTool("agent-1", "mcp__ekb__search");
    expect(result?.decision).toBe("prompt");
    expect(events[0]?.reason).toContain("no policy set");
  });

  it("UNSET policy with unsetDefault='allow' (full profile) -> decision allow (frictionless for full-trust)", () => {
    const { broker, events } = makeMcpBroker(() => null);
    const result = broker.decideMcpTool("agent-1", "mcp__ekb__search", "allow");
    expect(result?.decision).toBe("allow");
    expect(events[0]?.reason).toContain("full profile");
  });

  it("unsetDefault does NOT override an EXPLICIT policy (a deny stays a deny even for full)", () => {
    const { broker } = makeMcpBroker(() => "deny");
    expect(broker.decideMcpTool("agent-1", "mcp__ekb__search", "allow")?.decision).toBe("deny");
  });

  it("consults the seam with (fullToolName, serverKey)", () => {
    const calls: Array<[string, string]> = [];
    const { broker } = makeMcpBroker((tool, key) => { calls.push([tool, key]); return "allow"; });
    broker.decideMcpTool("a", "mcp__plugin_atlassian_atlassian__getJiraIssue");
    expect(calls).toEqual([["mcp__plugin_atlassian_atlassian__getJiraIssue", "mcp__plugin_atlassian_atlassian"]]);
  });

  it("returns null (and emits nothing) when the mcpToolMode seam is absent — feature not wired", () => {
    const { broker, events } = makeMcpBroker(undefined);
    expect(broker.decideMcpTool("a", "mcp__ekb__search")).toBeNull();
    expect(events).toHaveLength(0);
  });
});
