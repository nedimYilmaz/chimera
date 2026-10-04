import type { ToolPolicyMode, CapabilityAction, CapabilityDecisionKind, CapabilityDecisionEvent, ExplainCheck } from "@chimera/protocol";
import type { WorktreeWriteBlock, WorktreeWriteCaller } from "./worktree-lease.js";

// The one method decideWorktreeWrite needs from WorktreeLeaseStore. Narrowed to an interface so
// the broker depends on the QUESTION, not on the store's persistence/liveness machinery.
export type WorktreeLeaseEvaluator = {
  evaluateWrite: (caller: WorktreeWriteCaller, targets: string[]) => { blocked: WorktreeWriteBlock | null };
};

// FEATURE-6: the capability broker (Policy Decision Point). The single choke point
// EVERY capability-exercising action's allow/deny/prompt decision routes through, so
// authorization stops being scattered across supervisor.ts's Bash gate and (previously
// ungated) engine.ts's mcpstore.call handler. This is deliberately a thin PDP: the
// underlying policy lookups (Policy Information Points) stay exactly where they already
// lived — ToolPolicyStore.modeFor for host tools, injected as a function seam (same DI
// convention every other supervisor seam uses) — the broker's job is to turn a resolved
// mode into a decision, attribute it to a principal, and emit ONE structured audit event
// per decision. See PLAN.md for the full design + why MCP-store calls stay unconditional
// allow in this slice (no policy dimension exists for them yet — tracked follow-up).

function modeToDecision(mode: ToolPolicyMode): CapabilityDecisionKind {
  return mode === "deny" ? "deny" : mode === "ask" ? "prompt" : "allow";
}

const MCP_PREFIX = "mcp__";

// The server-level policy key for a foreign MCP tool. Tool names are
// "mcp__<server>__<tool>"; the server key is everything up to (excluding) the "__" that
// separates <server> from <tool> — e.g. "mcp__plugin_atlassian_atlassian__getJiraIssue" →
// "mcp__plugin_atlassian_atlassian". A server key in toolPolicy governs ALL of that server's
// tools; an exact tool-name key beats it (see ToolPolicyStore.modeForMcpMaybe). A malformed
// name with no second "__" yields itself, so exact==server and the lookup still resolves.
export function mcpServerKey(tool: string): string {
  const sep = tool.indexOf("__", MCP_PREFIX.length);
  return sep === -1 ? tool : tool.slice(0, sep);
}

export class CapabilityBroker {
  constructor(
    private hostToolMode: (tool: string, profile: string | null) => ToolPolicyMode,
    private emit: (event: CapabilityDecisionEvent) => void,
    // MCP-FOREIGN-POLICY: the ToolPolicyStore lookup for a FOREIGN MCP tool
    // (mcp__<server>__<tool>, never mcp__chimera__*). Returns null when NO policy key
    // matches — which decideMcpTool maps to "prompt", the deliberate ask-by-default for
    // ungoverned host MCP access. OPTIONAL: absent ⇒ decideMcpTool returns null and the
    // whole foreign-MCP gate is inert (byte-identical to before this feature for any broker
    // wired without it — e.g. older test harnesses that only exercise the Bash gate).
    private mcpToolMode?: (tool: string, serverKey: string) => ToolPolicyMode | null,
    // GATED-BUT-ALLOWED-INVISIBLE: optional ToolPolicyStore.hasExplicitPolicy seam — absent
    // ⇒ decideHostTool never stamps `explicitPolicy` (byte-identical to before this feature
    // for every existing broker construction, including every pre-existing test). A SEPARATE
    // seam from hostToolMode (rather than widening its return shape) specifically so no
    // existing `(tool, profile) => ToolPolicyMode` call site/test needs to change at all.
    private hostToolExplicit?: (tool: string) => boolean,
    // F22 (single-writer worktree lease): the WorktreeLeaseStore's evaluate seam and the config
    // mode. Structurally typed rather than importing the class so broker.ts keeps its
    // zero-runtime-dependency import list (type-only, same as @chimera/protocol above) and tests
    // can pass a two-line stub. Both OPTIONAL: absent ⇒ decideWorktreeWrite returns null and the
    // gate is inert, which is exactly what task 1 of this card ships — every existing broker
    // construction stays byte-identical.
    private worktreeLeases?: WorktreeLeaseEvaluator,
    private worktreeLeaseMode?: () => "enforce" | "warn" | "off",
  ) {}

  // Host-tool (Bash) decision — the SAME modeFor lookup ToolPolicyStore always did, now
  // the single choke point supervisor's toolPolicyGate calls per parsed Bash segment.
  decideHostTool(
    principal: string | null, tool: string, profile: string | null, command: string,
  ): { decision: CapabilityDecisionKind; reason: string } {
    const mode = this.hostToolMode(tool, profile);
    const decision = modeToDecision(mode);
    const resource = profile ? `${tool}:${profile}` : tool;
    const reason = decision === "deny" ? `host tool policy denies "${resource}"`
      : decision === "prompt" ? `host tool policy requires confirmation for "${resource}"`
      : `host tool policy allows "${resource}"`;
    const action: CapabilityAction = "host_tool";
    // GATED-BUT-ALLOWED-INVISIBLE: only meaningful (and only computed) for "allow" — deny/
    // prompt can only be reached via an explicit row in the first place (modeFor's hardcoded
    // fallback is unconditionally "allow"), so there's nothing to disambiguate there.
    // Omit rather than stamp `false` — same "absent means no" convention as every other
    // optional flag in this codebase (landingPermissionDenied, toolPolicyDenied, ...); the
    // classifier only ever checks `=== true`, so a bare false carries no information a
    // missing key doesn't already carry, and omitting keeps the common (ungated) case's
    // event payload byte-identical to before this feature.
    const explicitPolicy = decision === "allow" && (this.hostToolExplicit?.(tool) ?? false);
    this.emit({ principal, action, resource, decision, reason, tool, profile, command, ...(explicitPolicy ? { explicitPolicy: true as const } : {}) });
    return { decision, reason };
  }

  // Foreign-MCP-tool decision — the MCP analogue of decideHostTool. An EXPLICIT policy
  // (allow/ask/deny) applies uniformly to every profile, exactly like the Bash gate (which
  // denies/prompts even a full/bypass agent). The only profile-sensitive axis is the UNSET
  // default, supplied by the caller as `unsetDefault`: "prompt" for the ordinary case so an
  // ungoverned foreign MCP tool surfaces a permission card (grantable from the TUI/app) instead
  // of the pre-fix silent autoDecision deny — but "allow" for a full-trust (bypass) agent, which
  // must keep frictionless foreign-MCP access, mirroring the Bash gate's allow-by-default for an
  // unlisted tool (its modeFor returns "allow"). The caller (supervisor.mcpPolicyGate) has
  // already established this is a foreign MCP tool; this method turns the resolved mode into a
  // decision, attributes it to a principal, and emits ONE audit event. Returns null ONLY when the
  // mcpToolMode seam is absent (feature not wired), letting the caller no-op cleanly.
  decideMcpTool(
    principal: string | null, tool: string, unsetDefault: "prompt" | "allow" = "prompt",
  ): { decision: CapabilityDecisionKind; reason: string } | null {
    if (!this.mcpToolMode) return null;
    const serverKey = mcpServerKey(tool);
    const mode = this.mcpToolMode(tool, serverKey);
    const decision: CapabilityDecisionKind = mode === null ? unsetDefault : modeToDecision(mode);
    const unset = mode === null;
    const reason = decision === "deny" ? `mcp tool policy denies "${tool}"`
      : decision === "prompt" ? (unset ? `no policy set for "${tool}" — prompting` : `mcp tool policy requires confirmation for "${tool}"`)
      : (unset ? `no policy set for "${tool}" — allowed by full profile` : `mcp tool policy allows "${tool}"`);
    // GATED-BUT-ALLOWED-INVISIBLE: unlike host_tool, every mcp_tool decision is ALREADY
    // meaningful — chimera's own tools never reach this broker at all (mcpPolicyGate excludes
    // them before decideMcpTool is ever called), so there's no argv-parsing-noise case to
    // filter out here. An "allow" is either an admin's explicit row OR (the `unset` branch) a
    // full-profile silently bypassing what would otherwise prompt — both are exactly the kind
    // of "gated but auto-allowed" access the UI should make visible, so this is always true on
    // allow (only meaningful there, same convention as decideHostTool above).
    this.emit({ principal, action: "mcp_tool", resource: tool, decision, reason, server: serverKey, mcpTool: tool, ...(decision === "allow" ? { explicitPolicy: true } : {}) });
    return { decision, reason };
  }

  // TRUST-TIER: MCP store call gate. Every call is attributed (principal) and audited, same as
  // before -- what's new is the classification itself: a WRITE-CAPABLE tool on an UNTRUSTED
  // server, called by an actual AGENT (principal !== null), routes to "prompt" instead of the
  // previous unconditional "allow". Everything else stays allow, so this is byte-identical to
  // the pre-trust-tier behavior for the overwhelmingly common case (trust:"full", the default
  // every pre-existing mcpstore.json entry gets):
  //   - trust "full"                              -> allow, regardless of readOnlyHint
  //   - trust "untrusted" + tool IS read-only      -> allow (nothing to gate — reading is the
  //                                                    whole point of installing the server)
  //   - trust "untrusted" + write-capable + principal null (a UI/RPC-originated call, i.e. a
  //     human directly driving mcpstore.call, not an autonomous agent) -> allow (a human already
  //     IS the approval)
  //   - trust "untrusted" + write-capable + a real agent principal    -> "prompt": the caller
  //     (engine.ts) must route this through Supervisor.requestMcpStoreApproval before the call
  //     proceeds, and BLOCK (not allow) if that approval flow itself throws/fails — see its doc.
  // FAIL CLOSED, TWICE (both happen upstream of this method, not here — noted for the reader):
  // an unrecognised `trust` string parses to "untrusted" (McpStoreTrustSchema's `.catch`), and a
  // missing/non-boolean `readOnlyHint` is passed in here as `undefined`, which `writeCapable`
  // below treats as write-capable (only `=== true` counts as read-only).
  decideMcpStoreCall(
    principal: string | null, server: string, tool: string,
    trust: "full" | "untrusted" = "full", readOnlyHint?: boolean,
  ): { decision: CapabilityDecisionKind; reason: string } {
    const writeCapable = readOnlyHint !== true;
    const gated = trust === "untrusted" && writeCapable && principal !== null;
    const decision: CapabilityDecisionKind = gated ? "prompt" : "allow";
    const reason = gated
      ? `mcp store server "${server}" is untrusted and tool "${tool}" is write-capable — requires approval`
      : trust === "untrusted"
        ? (writeCapable
            ? `mcp store server "${server}" is untrusted but call has no agent principal — allowed`
            : `mcp store server "${server}" is untrusted but tool "${tool}" is read-only — allowed`)
        : `mcp store server "${server}" is trust:full — allowed`;
    const action: CapabilityAction = "mcp_store_call";
    this.emit({ principal, action, resource: `${server}:${tool}`, decision, reason, server, mcpTool: tool });
    return { decision, reason };
  }

  // F22: the single-writer worktree gate. `caller` is the caller's OWN workdirKey together with
  // the resolved worktree dir that key names in ITS checkout (null for a non-worktree agent or a
  // human-driven RPC) — the pair, because a key alone repeats across main checkouts; `targets`
  // are the absolute write targets already extracted by hosttools'
  // bashWriteTargets/editToolTargetPath.
  //
  // Returns null — and emits NOTHING — for every allowed write. That is deliberate and load-
  // bearing: virtually every write an agent makes is into its own worktree, so emitting an
  // "allow" event per decision here would put a capability_decision on the ledger for essentially
  // every Bash command in the fleet. The audit value is entirely in the refusals; the read-only
  // surface (worktree.leaseList for who holds what, worktree.explainWrite for the same checks
  // evaluated without acting) covers "why was this allowed".
  //
  // warn mode still emits the SAME event with decision "allow" — that is the whole point of warn:
  // observe what enforce would have refused, on the real ledger, before turning it on.
  decideWorktreeWrite(
    principal: string | null, caller: WorktreeWriteCaller, targets: string[],
  ): { decision: CapabilityDecisionKind; reason: string; check: ExplainCheck; workdirKey: string; owner: string; ownerState: "active" | "retained"; target: string } | null {
    const mode = this.worktreeLeaseMode?.() ?? "off";
    if (!this.worktreeLeases || mode === "off" || targets.length === 0) return null;
    const { blocked } = this.worktreeLeases.evaluateWrite(caller, targets);
    if (!blocked) return null;
    const decision: CapabilityDecisionKind = mode === "enforce" ? "deny" : "allow";
    const action: CapabilityAction = "worktree_write";
    // reason IS check.detail, not a paraphrase — the ledger and the refusal the agent reads must
    // be the same sentence, or an operator debugging a denial has two stories to reconcile.
    this.emit({
      principal, action, resource: `${blocked.workdirKey}:${blocked.owner}`,
      decision, reason: blocked.check.detail,
      workdirKey: blocked.workdirKey, owner: blocked.owner, ownerState: blocked.ownerState,
    });
    return { decision, reason: blocked.check.detail, ...blocked };
  }
}
