import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { CooldownTracker } from "@chimera/core/failover";
import { MailboxStore } from "@chimera/core/mailbox";
import { EventLog } from "@chimera/core/events";
import { CredentialResolver } from "@chimera/core/credentials";
import { AccountRegistry } from "@chimera/core/accounts";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ENGINE_TOOL_NAMES } from "@chimera/protocol/engine-help";
import { AgentSupervisor, CAPABILITY_BLOCK_TOOLS, buildCapabilityBlock } from "@chimera/core/supervisor";

// CAPABILITY-BLOCK-DRIFT: the supervisor's spawn-time AWARENESS capability block used to be
// a hand-written prose literal (packages/core/src/supervisor.ts) naming specific tools from
// memory, with nothing checking it against the actual MCP catalog (@chimera/protocol/
// engine-help's ENGINE_TOOL_NAMES — the same source server.ts/tui/app already generate from,
// per F07). A tool renamed or removed there silently made every spawned agent's system prompt
// wrong, with no failing test and no typecheck error.
//
// CAPABILITY_BLOCK_TOOLS is typed `satisfies Record<string, EngineToolName>` in supervisor.ts,
// so `tsc -b packages/core` already fails on a renamed/removed tool. This test is the runtime
// backstop (protects plain `vitest` runs) and, more importantly, PROVES the guard: it asserts
// every name the block references is still a live catalog member, so deleting/renaming an entry
// in ENGINE_TOOL_NAMES without updating supervisor.ts turns this red.
describe("supervisor — capability block drift guard", () => {
  it("every tool the capability block references is a live engine_help catalog entry", () => {
    const catalog = new Set(ENGINE_TOOL_NAMES);
    for (const [key, name] of Object.entries(CAPABILITY_BLOCK_TOOLS)) {
      expect(catalog.has(name), `capability block references "${name}" (as ${key}) — missing from ENGINE_TOOL_NAMES`).toBe(true);
    }
  });

  // Pins the exact generated prose so a catalog edit that leaves every referenced name
  // intact (renaming nothing, removing nothing) but is otherwise unnoticed still shows up
  // as a visible diff here for review — and so this run's cache-prefix-change disclosure
  // has a concrete byte-for-byte anchor.
  // TOOL-AWARENESS-OVER-REGISTRATION: the last four tools were added because NAMING a tool is what
  // makes deferring it free — an agent that knows the name calls it in one turn whether or not it
  // was registered, and only an agent that has to search first pays an extra whole-context read.
  // answer_question and subscribe are reactive (an agent does not go looking for them; they become
  // necessary when something arrives), and terminal_read/terminal_write were shipped recently and
  // named nowhere — which is how an agent came to insist it could not see a terminal that was open
  // under it, while the daemon held that terminal's output the whole time.
  // TOOL-TAGS: the trailing subject list is GENERATED from the catalog, so this literal doubles as
  // a drift guard on the vocabulary — add a subject with two or more tools and this turns red until
  // the block advertising it is regenerated. That is the point: a subject no agent is told about is
  // a subject no agent ever searches, and nothing else fails when it goes missing.
  // F25.QA: "review" joined the subject list when F25 added review_get/review_finding_add/
  // review_finding_resolve (three tools ⇒ over the count>=2 floor). That is a CACHE-PREFIX
  // CHANGE for every spawned agent — regenerating this literal is the conscious acknowledgement
  // the guard exists to force, and F25's task-2 verify list never ran packages/core, so it
  // landed on main red.
  // F22 (conductor, 2026-09-04): it happened AGAIN, same way — "worktree" joined the subject list
  // when [F22.2] added worktree_lease_handoff/worktree_lease_release/worktree_lease_list (three
  // tools ⇒ over the count>=2 floor), and F22's verify lists ran scoped core tests, never
  // packages/core, so main went red on landing. The literal below is regenerated from
  // buildCapabilityBlock(), which IS the acknowledgement: every spawned agent's system prompt now
  // advertises the worktree subject, and that is wanted — an agent refused by the single-writer
  // lease can only find worktree_lease_handoff if it knows the subject exists. If you are here
  // because this test is red again: the change is probably correct, but regenerate it DELIBERATELY
  // and say in your report which tools moved the vocabulary.
  // MAIN.capability-block (2026-09-05): F22 and F13.1 both landed clean but each reshuffled the
  // ENTIRE subject list, not just added their own subject — mcpToolTags() sorted by count first,
  // so a tool landing on "history" (F13.1) moved "artifact" relative to it even though artifact
  // gained nothing. That made this guard red for every agent spawned between those landings, from
  // a change neither PR's scoped verify list could see. mcpToolTags() now sorts by tag name only
  // (see the CACHE-PREFIX STABILITY comment on it in mcp-tools.ts); a subject's position is fixed
  // regardless of how many tools carry it, so only a genuinely new/removed subject can move these
  // bytes going forward. packages/protocol/test/mcp-tool-tags.test.ts has the test proving it.
  // VOICE (2026-09-1x): native-voice tools (voice_conversation_start/stop, voice_room_*) crossed
  // the count>=2 floor and joined the subject list between "team" and "workflow" (alphabetical).
  // Landed red the same way F25/F22 did — the landing PR's verify list never ran packages/core.
  it("generates the exact byte-for-byte AWARENESS block (cache-prefix-stable text)", () => {
    expect(buildCapabilityBlock()).toBe(
      "Chimera MCP tools available: agent_spawn/agent_status/agent_result/agent_wait to run sub-agents; ask_agent, agent_send, ask_team, my_team to reach teammates; ask_human to escalate. memory_search/memory_add (kind: decision|fact|todo) share durable knowledge across agents — search before starting related work. team_list + queue_push (set deliverTo to avoid polling) for task handoff. DISCOVER, don't preload: your context is lean by design — Skill and ToolSearch lazy-load skills/tools on demand. A chimera tool your brief names but you cannot see is DEFERRED, never missing: chimera_tools finds it by keyword and chimera_call runs it, with the same args. Never reach past this — chimera's daemon socket, its RPC framing and its source are not an interface, and hand-rolling a client for a tool that already exists is always the wrong turn. mcp_store_tools + mcp_store_call reach foreign MCP servers (Slack/Gmail/EKB/etc); engine_help describes this engine. CHIMERA-FIRST MCP ROUTING: before using any provider-native or directly configured MCP tool, use an already discovered suitable Chimera tool, or discover one via chimera_tools/chimera_call (engine tools) and mcp_store_tools/mcp_store_call (external services, browser and desktop computer use). Reuse discovery results within the task; do not search before every action. Use native MCP only when discovery confirms Chimera has no suitable tool for the required capability; briefly state the missing capability before falling back. A tool absent from your initial list may be deferred. A permission denial, busy desktop lease, connection failure or timeout is NOT a missing capability: resolve or report it, never bypass it through native tools. Keep desktop observation and actions on the Chimera route so ownership and activity remain visible. When a question or signal arrives for you, answer_question replies and subscribe sets up standing ones. terminal_read/terminal_write read and type into a terminal the operator opened under you. rename_self names you; daemon_status reports the engine's health. Tool subjects you can ask chimera_tools for: accounts, agent, artifact, ask, checkpoint, config, engine, events, history, hook, host, job, mcp, memory, plugins, project, queue, review, role, secrets, skills, team, terminal, usage, voice, workflow, worktree. BATCH INDEPENDENT TOOL CALLS: when the next calls do not need each other's output, put them in ONE message and read every result together. A second turn re-reads your entire context, so three separate calls cost three times what one batched turn does."
    );
  });
});

// Exercise the shared spawn boundary, including providers that do not use Claude's system prompt.
describe("Chimera-first MCP routing across providers", () => {
  it.each(["claude", "codex", "kimi", "openai"])("delivers the routing rule to %s without changing the stored task instructions", async (provider) => {
    const home = mkdtempSync(join(tmpdir(), "chimera-mcp-routing-"));
    const backend = new FakeAgentBackend([], provider);
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(ChimeraConfigSchema.parse({
        accounts: [{ name: "test", provider, auth: { type: "keychain", service: "test", injectAs: "TEST_KEY" } }],
        autoOrder: ["test"],
      })),
      credentials: new CredentialResolver(async () => ({ stdout: "test-key", code: 0 })),
      backends: new Map([[provider, backend]]), events: new EventLog(home), mailboxes: new MailboxStore(home),
      cooldowns: new CooldownTracker(60_000), permissionTimeoutMs: 100,
    });
    const agent = await sup.spawn({ prompt: "task", instructions: "role instructions", cwd: home, isolation: "none", orchestration: { allow: true } });
    const delivered = backend.spawns[0]!.instructions!;
    expect(delivered).toContain("CHIMERA-FIRST MCP ROUTING");
    expect(delivered).toContain("browser and desktop computer use");
    expect(delivered).toContain("Use native MCP only when discovery confirms Chimera has no suitable tool");
    expect(delivered).toContain("permission denial, busy desktop lease, connection failure or timeout is NOT a missing capability");
    expect(delivered.indexOf("CHIMERA-FIRST MCP ROUTING")).toBeLessThan(delivered.indexOf("role instructions"));
    expect(sup.status(agent.agentId).spec.instructions).toBe("role instructions");
    await sup.waitFor(agent.agentId, 1000);
  });
});
