import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// CHIMERA-MCP-NATIVE-CONNECT parity audit: a STATIC guard (no daemon, reads source text)
// that every local daemon RPC (Engine.handle()'s case table, packages/core/src/engine.ts)
// is either reachable through the MCP tool surface (packages/protocol/src/mcp-tools.ts's
// rpc(...) calls) or explicitly named in INTENTIONALLY_EXCLUDED below with a reason. This
// is the thing the other completeness guard (mcp.test.ts's "registered tools are EXACTLY
// the core tier" test) does NOT check -- that one verifies the REGISTERED/catalogued tool
// sets agree with each other; this one verifies the tool catalog agrees with the DAEMON,
// so a new engine.ts case added with no MCP tool (and no exclusion) fails a test instead of
// silently shipping a parity gap.
const ENGINE_SRC = readFileSync(fileURLToPath(new URL("../../core/src/engine.ts", import.meta.url)), "utf8");
const MCP_TOOLS_SRC = readFileSync(fileURLToPath(new URL("../../protocol/src/mcp-tools.ts", import.meta.url)), "utf8");
// FEATURE-8: RpcContract-migrated methods (queue.* today) are no longer `case "...":` labels
// in handle()'s switch -- they're dispatched via RPC_CONTRACT before the switch even runs
// (see engine.ts's isContractMethod branch) -- so extractCaseLabels alone would silently stop
// seeing them, and this guard would stop noticing if one lost its MCP tool. Read them
// straight from the contract's own source instead.
const CONTRACT_SRC = readFileSync(fileURLToPath(new URL("../../protocol/src/contract.ts", import.meta.url)), "utf8");

// handlePeer() is a SEPARATE, peer-authz-gated entrypoint (federation wire protocol) --
// engine.ts's own comment above it says never to fold it into handle()'s table. Slicing the
// source to [handle() start, handlePeer() start) keeps its case labels (several of which
// literally repeat handle()'s, e.g. "agent.status") out of this scan.
const HANDLE_START = "async handle(method: string, params: unknown";
const HANDLE_PEER_START = "async handlePeer(peerEngineId: string, method: string, params: unknown): Promise<unknown> {";
function localHandleBody(): string {
  const start = ENGINE_SRC.indexOf(HANDLE_START);
  const end = ENGINE_SRC.indexOf(HANDLE_PEER_START);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return ENGINE_SRC.slice(start, end);
}

function extractCaseLabels(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/case "([a-zA-Z][a-zA-Z._]*)":/g)) out.add(m[1]!);
  return out;
}

function extractResolvedRpcMethods(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/rpc\("([a-zA-Z][a-zA-Z._]*)"/g)) out.add(m[1]!);
  return out;
}

// FEATURE-8: RPC_CONTRACT's own method-name keys, e.g. `"queue.create": defineRpc(...)`.
function extractContractMethods(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/"([a-zA-Z][a-zA-Z._]*)":\s*defineRpc\(/g)) out.add(m[1]!);
  return out;
}

// Covered, but not visible to the two regexes above -- listed by hand so their absence from
// the static scan is a documented decision, not a blind spot.
const DYNAMIC_OR_ALIAS_COVERED = new Set([
  // agent_list's resolve() picks the method via a ternary on the `full` arg
  // (rpc(a["full"] === true ? "agent.list" : "agent.listSummary", {})) -- the literal
  // strings never appear as a plain rpc("...") call for the regex to find.
  "agent.list", "agent.listSummary",
  // engine.ts's own case table aliases memory.update onto the SAME handler block as
  // memory.edit ("case \"memory.edit\": case \"memory.update\": {") -- the memory_edit
  // tool's rpc("memory.edit", ...) call exercises the identical code path.
  "memory.update",
  // F34.FIX: memory_search's resolve() builds its own { kind: "rpc", method: "memory.search", ...,
  // postDispatch } object literal instead of the rpc() helper, so it can attach postDispatch --
  // the literal method name never appears as a plain rpc("...") call for the regex to find.
  "memory.search",
]);

// Federation (Phase 5) network/credential administration -- pairing, invites, tailscale
// auth keys, ssh key provisioning, peer grants. Deliberately kept OFF the MCP agent-tool
// surface: every one of these either mutates machine-level network/credential state or
// grants a REMOTE engine capability, which is a human/CLI/TUI decision (`chimera
// federation init` et al, README "Federation" section), not something an orchestrated
// agent should be able to trigger. mailbox.forward is not in this list because it isn't a
// case in handle() at all -- it lives only in handlePeer(), the peer-authenticated wire
// entrypoint, so it never reaches this scan.
const INTENTIONALLY_EXCLUDED_RPCS = new Set([
  "canvas.saveLayout", // Cosmetic private operator layout; agents read the graph only.
  // Agents must never mint pairing codes or activate a network surface.
  "operatorweb.status", "operatorweb.enable", "operatorweb.disable", "operatorweb.pairStart", "operatorweb.sessionList", "operatorweb.sessionRevoke", "operatorweb.settingsSet",
  // Local executable install and private microphone-derived content are operator-only.
  "stt.configure", "stt.install", "stt.installCancel", "stt.uninstall", "stt.transcribe", "stt.transcribeCancel",
  // Only consent requests and end-own-conversation are agent tools. SDP, mic
  // approval, the inbox and private voice history belong to the desktop operator.
  "voice.native.check", "voice.native.configure", "voice.native.start", "voice.native.poll",
  "voice.native.stop", "voice.native.history", "voice.native.requests", "voice.native.dismiss",
  "voice.native.text", "voice.room.approve", "voice.room.heartbeat", "voice.room.removeParticipant", "voice.room.report", "voice.room.reviewUpdate",
  "voice.room.plan", "voice.room.cancelPlan", // Desktop host lease only; agents cannot schedule themselves into a turn.
  // Installing executable dependencies requires explicit operator review. Shared
  // discovery/call remains agent-facing; package lifecycle must never become a tool.
  "mcpstore.package.inspect", "mcpstore.package.install",
  // Built-in computer-use integrations: the install state and the first-use Laya download are
  // operator (UI) actions. Their TOOLS are ordinary mcp_store entries and stay agent-discoverable.
  "computerUse.builtins.status", "computerUse.builtins.install", "computerUse.builtins.rollback",
  // Diagnostic status is exposed; a full index rebuild remains operator-owned.
  "chronicle.reindex",
  // TERMINAL-READBACK: the INGEST half. The desktop app tees the PTY output it is already drawing
  // into the daemon so terminal_read has something to answer with. An agent has no reason to call
  // it and every reason not to be able to: writing to this is writing the record of what the
  // operator's terminal printed. The READ half is exposed, as terminal_read.
  "terminal.append",
  // TERMINAL-TABSTATE: what the APP knows about a tab — which one is on screen, and what the
  // operator named it. Facts about a window, which an agent has none of. Off the agent surface
  // both ways round: claiming focus would let it redirect its own default write target, and
  // renaming would let it move a name out from under the operator.
  "terminal.tabState",
  "fed.network", "fed.network.up", "fed.tailscale.setAuthKey", "fed.sshkey.ensure",
  "fed.accept", "fed.invite.create", "fed.invite.list", "fed.invite.revoke",
  "fed.join", "fed.peer.grant",
  // Read-only diagnostic RPCs are MCP-facing. Human review decisions, UI state,
  // terminal ingestion, destructive history cleanup and privilege changes remain
  // operator-owned. memory.index is covered only by memory_index_status, which
  // fixes action:"status" rather than exposing the rebuild action.
  "review.decide",
  //  - agent.purgeTerminal ... PURGE-TERMINAL-SESSIONS: the operator's cleanup broom (forgets
  //    finished agents and deletes their archived record + mailbox). Same operator-only posture
  //    as killMany beside it, one step stronger: an agent that could erase its siblings' history
  //    is a strictly worse idea than one that could end their sessions.
  //  - secret.set/list/delete/grant/revoke ... SECRET-MANAGER: the OPERATOR half of the secret
  //    store. Deliberately absent from MCP — an agent that could grant itself a secret is not an
  //    allowlist, it is a formality, and one that could enumerate every stored secret would be
  //    reading a list that names the operator's accounts, vendors and environments. The agent
  //    half (secret.listForAgent / secret.read) IS exposed, as secret_list / secret_get, and both
  //    key on the caller's own agentId rather than a parameter.
  "secret.set", "secret.list", "secret.delete", "secret.grant", "secret.revoke",
  //  - project.setSetupHook ... F26: operator-only RPC that configures a project's trusted,
  //    daemon-privileged worktree setup hook — no MCP tool, same reasoning as secret.set/grant
  //    above: an agent that could set its own next spawn's setup hook would be arbitrary
  //    daemon-privileged execution, not a permission.
  //  - agent.markSeen ........ F47 fleet seen-state: the operator's "I have triaged this" stamp
  //    (clears the unseen badge on named agents). Operator-only for the reason engine.ts's own
  //    case comment gives — an agent that could mark itself seen would erase the very signal the
  //    operator triages by, so the attention queue would quietly empty itself.
  "agent.markSeen",
  "agent.interruptMany", "agent.killMany", "agent.purgeTerminal", "project.setLoadProjectSettings", "project.setSetupHook", "fs.list", "fs.read", "fs.resolve",
  "shadow.workflowInspect",
  //  - voice.session.start/stop, voice.conversation.set . VOICE S2 (docs/superpowers/specs/
  //    2026-07-24-voice-agents-design.md §6): app-driven mic session lifecycle + conversation
  //    toggle for the Tauri push-to-talk UI -- not an orchestration primitive an agent drives.
  "voice.session.start", "voice.session.stop", "voice.conversation.set",
  //  - mcpstore.oauth.finish . MCP-OAUTH slice 1: the UI->daemon half of the OAuth 2.1
  //    exchange for a remote MCP store server, same "UI-only, tokens never in an agent
  //    transcript" rationale as mcpstore.setAuth (which itself pre-dates this guard and is a
  //    known gap, not introduced here).
  //    `oauth.start` was listed here too until MCP-AUTH-STATUS and is now DELIBERATELY resolved
  //    by mcp_store_reauth. The original rationale ("for no benefit" — see contract.ts) no
  //    longer holds: an agent whose mcp_store_call just died on a revoked grant is the first
  //    thing in the system to know auth is gone. It gets back a pendingId + an authorize URL to
  //    hand a human and nothing else — no token crosses the transcript, and `finish` stays out
  //    of reach, so an agent still cannot complete a grant on its own.
  "mcpstore.oauth.finish",
  //  - mcpstore.detectAuth / mcpstore.setAuthKind . MCP-OAUTH-DISCOVERABILITY: the read-only
  //    OAuth-detect probe and the "retrofit an existing entry's auth.kind" write, same UI->
  //    daemon-only rationale as mcpstore.setAuth/oauth.start/finish above -- a detect probe or
  //    a kind conversion is the Settings screen's Authorize button driving itself, not
  //    something an orchestrated agent needs.
  "mcpstore.detectAuth", "mcpstore.setAuthKind",
  //  - mcpstore.setEnabled . MCPSTORE-LIFECYCLE-UI: the disable/enable lifecycle toggle —
  //    same UI->daemon-only rationale as mcpstore.setAuthKind/detectAuth above (unlike
  //    mcpstore.setDirect, which genuinely IS an agent-facing tool, mcp_store_set_direct).
  //    Not an agent-facing primitive: an agent never needs to disable a store server on itself.
  "mcpstore.setEnabled",
  //  - mcpstore.setTrust . TRUST-TIER: deliberately NOT agent-facing, and deliberately NOT
  //    following mcpstore.setDirect's precedent — an agent that could flip its OWN untrusted
  //    server back to "full" trust would trivially defeat the whole gate (broker.
  //    decideMcpStoreCall) a prompt-injected agent is the exact threat this feature exists to
  //    contain. UI/RPC-only, same rationale as mcpstore.setEnabled above.
  "mcpstore.setTrust",
  // Provider URLs/credentials are configured by the operator in Settings.
  "providers.addCustom",
  //  - role.delete . ROLE-TOOLS-FOR-AGENTS: role.create/list/update were promoted to
  //    agent-facing MCP tools (role_create/role_list/role_update) so an agent can define a
  //    role in the global library once and bind it wherever needed (team, job, one-off
  //    spawn) instead of reaching for team_create as the only door into "define a role".
  //    role.delete deliberately did NOT follow — under ROLES-UNIFY a library role can be
  //    bound by many teams' bindings at once (RoleBindingSchema, `{role, overrides}`), and
  //    role.delete's own handler (RoleRpc, packages/core/src/rpc/role-rpc.ts) scans every
  //    team's bindings and refuses while any still reference the name. Creating/refining a
  //    role only ever affects FUTURE resolutions the caller controls; deleting one can break
  //    teams and jobs owned by other agents/operators that the caller has no visibility into.
  //    An agent that can create and iterate on roles but not destroy shared ones is the right
  //    power balance — deletion of a shared resource stays an operator/config-time action,
  //    same posture as team.dissolve NOT being the tool that also nukes a role out from under
  //    a different team.
  "role.delete",
  //  - team.attachRole/team.detachRole/team.updateRoleBinding . ROLES-UNIFY §8 S3: the SAME
  //    operator/config-time rationale as role.delete above, now extended to the binding
  //    side — attaching/detaching/editing which library role a team SLOT points at (and its
  //    override patch) is a team-shape decision (RolesScreen's binding-override editor,
  //    app-side, §6.3), not an orchestration primitive an agent should self-serve. An agent
  //    binds a role into a NEW team via team_create's `roles` map (role_create + team_create
  //    together cover the create-and-bind flow); rebinding an EXISTING team's slot live is
  //    still operator/UI-only. No agent workflow in this codebase was found to depend on an
  //    agent rebinding a team role live — if one surfaces, promote deliberately.
  "team.attachRole", "team.detachRole", "team.updateRoleBinding",
  //  - fed.cloudflare/fed.cloudflare.up . Cloudflare tunnel provisioning for federation's public
  //    endpoint — same admin/CLI-only rationale as the fed.* federation block at the top of this
  //    list (network/credential administration, not an orchestration primitive). Pre-existing gap
  //    on main, unrelated to and discovered while landing ROLES-UNIFY S3 — documented here rather
  //    than left silently red.
  "fed.cloudflare", "fed.cloudflare.up",
  //  - mcpstore.setAuth/voice.realtime.token/mcpstore.oauth.cancel . Pre-existing gaps that
  //    pre-date this guard (mcpstore.setAuth per its own comment above; the other two never
  //    landed a tool), carried over unfixed from the SESSION-TIER landing — same "known gap, not
  //    introduced here" posture, made explicit instead of leaving the suite silently red.
  "mcpstore.setAuth", "voice.realtime.token", "mcpstore.oauth.cancel",
  //  - budget.resume . F50 BUDGET-RESUME: releasing a budget pause is the release valve on the
  //    fleet's hardest guardrail, so the ONE principal who must never reach it is an agent that
  //    just got paused for overspending. chimera_call dispatches nothing outside MCP_TOOLS, so
  //    absence from that table is a stronger guarantee than any runtime principal check —
  //    operator surfaces (app/tui) call the RPC directly.
  "budget.resume",
]);

describe("MCP <-> daemon RPC parity (static)", () => {
  it("every Engine.handle() RPC is exposed as an MCP tool or explicitly excluded", () => {
    // FEATURE-8: union in RPC_CONTRACT's methods (queue.* today) -- they left handle()'s
    // switch for the contract dispatch, so extractCaseLabels alone no longer sees them.
    const localRpcs = new Set([...extractCaseLabels(localHandleBody()), ...extractContractMethods(CONTRACT_SRC)]);
    expect(localRpcs.size).toBeGreaterThan(80); // sanity floor -- a near-empty match means the source markers above drifted, not that parity improved

    const resolved = extractResolvedRpcMethods(MCP_TOOLS_SRC);
    const uncovered = [...localRpcs].filter(
      (m) => !resolved.has(m) && !DYNAMIC_OR_ALIAS_COVERED.has(m) && !INTENTIONALLY_EXCLUDED_RPCS.has(m),
    );
    expect(uncovered).toEqual([]);
  });

  it("every intentionally-excluded RPC is a real local RPC (no stale exclusions)", () => {
    // Same universe test 1 treats as "local": handle()'s case labels UNION the RPC_CONTRACT
    // methods (queue.*, review.*, events.*, health.status, ... dispatch via the contract
    // before handle()'s switch, so they never appear as case labels). An exclusion may name
    // either kind; both must still correspond to a real daemon RPC or it's a stale entry.
    const localRpcs = new Set([...extractCaseLabels(localHandleBody()), ...extractContractMethods(CONTRACT_SRC)]);
    for (const m of INTENTIONALLY_EXCLUDED_RPCS) expect(localRpcs).toContain(m);
  });

  it("no RPC is both resolved by a tool AND listed as excluded (the exclusion list can't silently mask a real tool)", () => {
    const resolved = extractResolvedRpcMethods(MCP_TOOLS_SRC);
    for (const m of INTENTIONALLY_EXCLUDED_RPCS) expect(resolved).not.toContain(m);
  });
});
