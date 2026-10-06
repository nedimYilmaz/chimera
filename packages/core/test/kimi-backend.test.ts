import { createMessage } from "../src/message-delivery.js";
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpecSchema } from "@chimera/protocol";
import type { ChimeraEngineAccessor, ResolvedAgentSpec } from "@chimera/core/backend";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  KIMI_FANOUT_NOTE, KIMI_FANOUT_TOOL_TITLES,
  KimiAgentBackend, buildKimiAcpArgs, buildKimiMcpServers, closeOrphanedKimiToolCalls, describeKimiError, kimiModeFor,
  kimiModelOptions, mapKimiPermissionOptions, normalizeKimiEvent, resolveKimiCliPath, sanitizeKimiAcpLine,
  type KimiFactory, type KimiAcpUpdate, type KimiMapCtx, type KimiTextBlock,
} from "@chimera/core/backends/kimi";

function kmSpec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", provider: "kimi", ...over }),
    agentId: "km-1", accountName: "km-main", resolvedProvider: "kimi",
    env: { CHIMERA_AGENT_ID: "km-1", CHIMERA_DEPTH: "0" },
    depth: 0,
  } as ResolvedAgentSpec;
}

// KIMI-CLI-PROTOCOL: fakeKimi() mirrors the old SDK-shaped fixture's role -- a fully scripted
// fake KimiFactory, one "turn script" queued per prompt() call, so the run loop/event mapping
// gets exercised without a live `kimi acp` process. Unlike the old SDK's pull-based Turn iterator,
// ACP's prompt() is a single call that PUSHES updates via deps.onUpdate() before resolving with a
// stopReason -- the fake mirrors that push shape directly (deps.onUpdate/deps.decidePermission,
// not an async-iterable Turn object).
type ScriptedTurn = {
  updates?: KimiAcpUpdate[];
  permission?: { toolCallId: string; title: string; kind?: string; rawInput?: Record<string, unknown>; options: Array<{ optionId: string; kind: string; name: string }> };
  stopReason?: string;
  error?: string;
};
function fakeKimi(turnScripts: ScriptedTurn[]) {
  const prompts: string[] = [];
  const promptBlocks: KimiTextBlock[][] = [];
  const killCalls: number[] = [];
  const cancelCalls: number[] = [];
  const decideCalls: unknown[] = [];
  let turnIdx = 0;
  let sawResume: string | null | undefined;
  const factory: KimiFactory = (spec, _cwd, deps) => {
    sawResume = spec.resume;
    const ready = Promise.resolve().then(async () => ({
      sessionId: "sess-fake-1",
      prompt: async (content: KimiTextBlock[]) => {
        promptBlocks.push(content);
        prompts.push(content.map(block => block.text).join("\n\n"));
        const script = turnScripts[turnIdx++] ?? {};
        if (script.permission) {
          const decision = await deps.decidePermission({
            requestId: script.permission.toolCallId, toolName: script.permission.title, input: script.permission.rawInput ?? {},
          });
          decideCalls.push(decision);
        }
        for (const u of script.updates ?? []) deps.onUpdate(u);
        if (script.error) throw new Error(script.error);
        return { stopReason: script.stopReason ?? "end_turn" };
      },
      cancel: async () => { cancelCalls.push(1); },
      close: async () => {},
    }));
    return { ready, killNow: () => killCalls.push(1) };
  };
  return { factory, prompts, promptBlocks, killCalls, cancelCalls, decideCalls, resumeSeen: () => sawResume };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("normalizeKimiEvent — one case per ACP sessionUpdate variant", () => {
  const ctx = (): KimiMapCtx => ({ toolTitles: new Map(), toolClosed: new Set() });

  it("user_message_chunk -> status (echo of our own prompt, nothing to render)", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } } as never, ctx());
    expect(ev).toMatchObject({ kind: "status", data: { kimiEvent: "user_message_chunk" } });
  });

  it("agent_message_chunk -> message_delta", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } as never, ctx());
    expect(ev).toMatchObject({ kind: "message_delta", data: { text: "pong" } });
  });

  it("agent_message_chunk with no text -> null (nothing to emit)", () => {
    expect(normalizeKimiEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text" } } as never, ctx())).toBeNull();
  });

  it("agent_thought_chunk -> message_delta on the reasoning channel", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } } as never, ctx());
    expect(ev).toMatchObject({ kind: "message_delta", data: { text: "pondering", channel: "reasoning" } });
  });

  it("tool_call -> tool_call, carrying toolCallId as data.toolId and remembering the title for tool_call_update correlation", () => {
    const c = ctx();
    const ev = normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "read_file", kind: "read", rawInput: { path: "a.ts" } } as never, c);
    expect(ev).toMatchObject({ kind: "tool_call", data: { toolId: "tc-1", toolName: "read_file", input: { path: "a.ts" }, toolKind: "read" } });
    expect(c.toolTitles.get("tc-1")).toBe("read_file");
  });

  // KIMI-NATIVE-SUBAGENT-VISIBILITY: ACP carries no sub-agent/swarm lifecycle notification of any
  // kind (confirmed against the full sessionUpdate schema and a live capture -- see the module
  // header). AgentSwarm's fan-out crosses the wire as a single opaque tool_call with rawInput
  // absent; the honest, additive fix is an operator-facing note in `input`, not a fabricated
  // nesting tree.
  it("tool_call titled AgentSwarm -> tool_call annotated with the not-observable note in input, rawInput absent (matches the live wire capture)", () => {
    const c = ctx();
    const ev = normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-swarm", title: "AgentSwarm", kind: "other", status: "pending" } as never, c);
    expect(ev).toMatchObject({ kind: "tool_call", data: { toolId: "tc-swarm", toolName: "AgentSwarm", input: { note: KIMI_FANOUT_NOTE } } });
  });

  it("tool_call titled AgentSwarm preserves any real rawInput alongside the note (never overwrites CLI-sent args)", () => {
    const c = ctx();
    const ev = normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-swarm-2", title: "AgentSwarm", rawInput: { items: ["a", "b"] } } as never, c);
    expect(ev).toMatchObject({ kind: "tool_call", data: { input: { items: ["a", "b"], note: KIMI_FANOUT_NOTE } } });
  });

  it("a non-fanout tool_call never gets the AgentSwarm note (e.g. a single Agent delegation, which already surfaces fine)", () => {
    const c = ctx();
    const ev = normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-agent", title: "Agent", rawInput: { prompt: "do x" } } as never, c);
    expect(ev).toMatchObject({ kind: "tool_call", data: { input: { prompt: "do x" } } });
    expect((ev as { data: { input: Record<string, unknown> } }).data.input["note"]).toBeUndefined();
  });

  it("KIMI_FANOUT_TOOL_TITLES is the closed, explicit list this mapping keys off of", () => {
    expect(KIMI_FANOUT_TOOL_TITLES.has("AgentSwarm")).toBe(true);
    expect(KIMI_FANOUT_TOOL_TITLES.has("Agent")).toBe(false);
  });

  it("a pending re-send of an already-announced tool_call -> null (lifecycle status only, never a second tool_call)", () => {
    const c = ctx();
    normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Bash", status: "pending" } as never, c);
    expect(normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Running: ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" } } as never, c)).toBeNull();
  });

  it("a single-shot tool_call already carrying a terminal status -> [tool_call, tool_result] pair (codex file_change precedent)", () => {
    const c = ctx();
    const ev = normalizeKimiEvent({
      sessionUpdate: "tool_call", toolCallId: "tc-9", title: "Bash", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "out" } }],
    } as never, c);
    expect(Array.isArray(ev)).toBe(true);
    const [call, result] = ev as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(call).toMatchObject({ kind: "tool_call", data: { toolId: "tc-9", toolName: "Bash" } });
    expect(result).toMatchObject({ kind: "tool_result", data: { toolId: "tc-9", isError: false, result: "out" } });
  });

  it("tool_call_update(pending/in_progress) -> null (no chimera tool_result yet)", () => {
    expect(normalizeKimiEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "in_progress" } as never, ctx())).toBeNull();
  });

  it("tool_call_update(completed) -> tool_result, correlating toolCallId back to the title tool_call recorded", () => {
    const c = ctx();
    c.toolTitles.set("tc-1", "read_file");
    const ev = normalizeKimiEvent({
      sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "file contents" } }],
    } as never, c);
    expect(ev).toMatchObject({ kind: "tool_result", data: { toolId: "tc-1", toolName: "read_file", isError: false, result: "file contents" } });
  });

  it("tool_call_update(completed) with only rawOutput (the post-shim {text} shape) -> result falls back to rawOutput text", () => {
    const c = ctx();
    c.toolTitles.set("tc-2", "Bash");
    const ev = normalizeKimiEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed", rawOutput: { text: "probe-ok\n" } } as never, c);
    expect(ev).toMatchObject({ kind: "tool_result", data: { toolId: "tc-2", toolName: "Bash", result: "probe-ok\n" } });
  });

  it("tool_call_update(completed) with a raw STRING rawOutput (pre-shim wire shape, defensive) -> still renders", () => {
    const c = ctx();
    const ev = normalizeKimiEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-3", status: "completed", rawOutput: "raw-out" } as never, c);
    expect(ev).toMatchObject({ kind: "tool_result", data: { toolId: "tc-3", result: "raw-out" } });
  });

  it("a duplicate terminal tool_call_update for an already-closed id -> null (no double tool_result)", () => {
    const c = ctx();
    const u = { sessionUpdate: "tool_call_update", toolCallId: "tc-4", status: "completed", content: [{ type: "content", content: { type: "text", text: "x" } }] } as never;
    expect(normalizeKimiEvent(u, c)).not.toBeNull();
    expect(normalizeKimiEvent(u, c)).toBeNull();
  });

  it("tool_call_update(failed) -> tool_result with isError:true", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "tool_call_update", toolCallId: "unknown-id", status: "failed", rawOutput: { message: "boom" } } as never, ctx());
    expect(ev).toMatchObject({ kind: "tool_result", data: { toolName: "unknown-id", isError: true } });
  });

  it("plan -> status carrying the entries", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "plan", entries: [{ content: "step 1", status: "pending" }] } as never, ctx());
    expect(ev).toMatchObject({ kind: "status", data: { plan: [{ content: "step 1", status: "pending" }] } });
  });

  it("current_mode_update -> status carrying the new mode id", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "current_mode_update", currentModeId: "yolo" } as never, ctx());
    expect(ev).toMatchObject({ kind: "status", data: { kimiEvent: "current_mode_update", currentModeId: "yolo" } });
  });

  // SLASH-COMMANDS-ARE-PER-PROVIDER: this asserted the payload folded into a generic `status`
  // blob — which nothing consumes, so kimi advertised its commands and the operator never saw
  // one. It now emits the SAME commands_changed event claude does, which ui-state folds into
  // agent.slashCommands and the app's "/" autocomplete reads.
  it("available_commands_update -> commands_changed, the shared shape every provider's commands ride", () => {
    const ev = normalizeKimiEvent(
      { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "shrink the context" }] } as never,
      ctx(),
    );
    expect(ev).toMatchObject({ kind: "commands_changed", data: { commands: [{ name: "compact", description: "shrink the context" }] } });
  });

  it("an empty advertisement is still commands_changed — it CLEARS the list rather than leaving stale names", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "available_commands_update", availableCommands: [] } as never, ctx());
    expect(ev).toMatchObject({ kind: "commands_changed", data: { commands: [] } });
  });

  it("an unrecognized/vendor-extension update (e.g. Kimi's own config_option_update) folds into status, never throws", () => {
    const ev = normalizeKimiEvent({ sessionUpdate: "config_option_update", configOptions: [] } as never, ctx());
    expect(ev).toMatchObject({ kind: "status", data: { kimiEvent: "config_option_update" } });
  });
});

// KIMI-TOOL-EVENT-ORPHANS: the wire-level root cause -- the real CLI's terminal tool_call_update
// carries rawOutput as a STRING, which @zed-industries/agent-client-protocol@0.4.5's
// sessionNotificationSchema (`rawOutput: z.record(...)`) parse-rejected, silently dropping the
// ONLY "tool finished" notification. The shim rewrites it before the library parses the line.
// ACP-SDK-RENAME: the successor SDK fixed this (`rawOutput: defaultOnError(z.unknown().optional())`)
// and stopped exporting its zod schemas from the public API, so these no longer assert
// "the library rejects/accepts it" -- they assert the shim's OWN contract, which is what the
// backend still depends on (rawOutputText's object branch) and what must keep holding.
describe("sanitizeKimiAcpLine — rawOutput wire shim (KIMI-TOOL-EVENT-ORPHANS root cause)", () => {
  const acpLine = (update: unknown) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update } });

  it("a STRING rawOutput on a terminal tool_call_update is wrapped as {text}, leaving the rest of the line untouched", () => {
    // The exact shape the raw-wire probe captured from the real CLI on a completed Bash call.
    const line = acpLine({ sessionUpdate: "tool_call_update", toolCallId: "0:tool_X", status: "completed", content: [{ type: "content", content: { type: "text", text: "probe-ok\n" } }], rawOutput: "probe-ok\n" });
    const sanitized = sanitizeKimiAcpLine(line);
    expect(sanitized).not.toBe(line);
    const parsed = JSON.parse(sanitized);
    expect(parsed.params.update.rawOutput).toEqual({ text: "probe-ok\n" });
    // Everything OTHER than rawOutput survives byte-identically — the shim must never be able to
    // corrupt a notification while normalizing one field of it.
    const before = JSON.parse(line);
    delete before.params.update.rawOutput;
    const after = JSON.parse(sanitized);
    delete after.params.update.rawOutput;
    expect(after).toEqual(before);
  });

  it("an OBJECT rawOutput passes through byte-identical (already schema-valid)", () => {
    const line = acpLine({ sessionUpdate: "tool_call_update", toolCallId: "0:tool_X", status: "completed", rawOutput: { out: "x" } });
    expect(sanitizeKimiAcpLine(line)).toBe(line);
  });

  it("lines without rawOutput, non-session/update messages, and malformed JSON all pass through byte-identical", () => {
    const plain = acpLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    expect(sanitizeKimiAcpLine(plain)).toBe(plain);
    const response = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { rawOutput: "not-a-notification" } });
    expect(sanitizeKimiAcpLine(response)).toBe(response);
    const garbage = '{"rawOutput": not json';
    expect(sanitizeKimiAcpLine(garbage)).toBe(garbage);
  });
});

describe("closeOrphanedKimiToolCalls — no spinner may outlive a turn", () => {
  const ctx = (): KimiMapCtx => ({ toolTitles: new Map(), toolClosed: new Set() });

  it("a tool_call that never reached a terminal status gets a synthetic ERROR tool_result, correlated by toolId", () => {
    const c = ctx();
    normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Bash", status: "pending" } as never, c);
    const swept = closeOrphanedKimiToolCalls(c);
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ kind: "tool_result", data: { toolId: "tc-1", toolName: "Bash", isError: true } });
    expect(String(swept[0]!.data["result"])).toMatch(/without a terminal update/);
    // Idempotent: a second sweep emits nothing.
    expect(closeOrphanedKimiToolCalls(c)).toEqual([]);
  });

  it("skips calls already closed by a real terminal update, and dedupes a terminal update arriving AFTER the sweep", () => {
    const c = ctx();
    normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Bash", status: "pending" } as never, c);
    normalizeKimiEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] } as never, c);
    normalizeKimiEvent({ sessionUpdate: "tool_call", toolCallId: "tc-2", title: "Read", status: "pending" } as never, c);
    const swept = closeOrphanedKimiToolCalls(c);
    expect(swept.map((e) => e.data["toolId"])).toEqual(["tc-2"]);   // tc-1 closed for real; only the orphan is swept
    // The late terminal update for the swept id is dropped, not double-emitted.
    expect(normalizeKimiEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "completed" } as never, c)).toBeNull();
  });
});

describe("buildKimiAcpArgs", () => {
  it("passes --model before the acp subcommand, falling back to the catalog default", () => {
    expect(buildKimiAcpArgs(kmSpec({}))).toEqual(["--model", "kimi-k3", "acp"]);
    expect(buildKimiAcpArgs(kmSpec({ model: "kimi-k3-preview" }))).toEqual(["--model", "kimi-k3-preview", "acp"]);
  });

  it("threads providerOptions.skillsDir/addDir as repeated global flags, and extraArgs verbatim", () => {
    const args = buildKimiAcpArgs(kmSpec({
      providerOptions: { skillsDir: ["/a/skills", "/b/skills"], addDir: "/extra/dir", extraArgs: ["--plan"] },
    }));
    expect(args).toEqual(["--model", "kimi-k3", "--skills-dir", "/a/skills", "--skills-dir", "/b/skills", "--add-dir", "/extra/dir", "--plan", "acp"]);
  });
});

describe("buildKimiMcpServers — CROSS-PROVIDER-MCP-STORE ACP mcpServers wiring (KIMI-STDIO-MCP-UNSUPPORTED: stdio is never wired, only withheld)", () => {
  it("orchestration.allow:false, no spec.mcpServers -> empty array, no notice (byte-identical to before this field existed)", () => {
    const { mcpServers, notice } = buildKimiMcpServers(kmSpec({}));
    expect(mcpServers).toEqual([]);
    expect(notice).toEqual({ mcpServersWithheld: [], settingSourcesUnsupported: false });
  });

  it("orchestration.allow:true withholds the chimera grant with reason stdio-unsupported instead of wiring a doomed stdio entry (kimi CLI v0.37.2 rejects every stdio mcpServers entry at session/new)", () => {
    const spec = { ...kmSpec({ orchestration: { allow: true, maxDepth: 3 } }), env: { CHIMERA_AGENT_ID: "km-1", CHIMERA_DEPTH: "0", CHIMERA_TREE_ID: "tree-1", CHIMERA_TEAM: "chimera-dev" } };
    const { mcpServers, notice } = buildKimiMcpServers(spec);
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld).toEqual([{ name: "chimera", reason: "stdio-unsupported" }]);
  });

  it("spec.mcpServers with no mcpToolAllowlist is still withheld (stdio-unsupported), not wired through", () => {
    const spec = kmSpec({ mcpServers: { slack: { command: "slack-mcp", args: ["--foo"], env: { TOKEN: "x" } } } });
    const { mcpServers, notice } = buildKimiMcpServers(spec);
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld).toEqual([{ name: "slack", reason: "stdio-unsupported" }]);
  });

  it("a non-stdio (no `command`) spec.mcpServers entry is silently skipped, not withheld", () => {
    const spec = kmSpec({ mcpServers: { hosted: { url: "https://example.com/mcp" } } });
    const { mcpServers, notice } = buildKimiMcpServers(spec);
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld).toEqual([]);
  });

  it("mcpToolAllowlist configured (even {}) -> every external stdio server is withheld with reason allowlist (takes precedence over the generic stdio-unsupported reason)", () => {
    const spec = kmSpec({
      mcpServers: { slack: { command: "slack-mcp" }, github: { command: "github-mcp" } },
      mcpToolAllowlist: { slack: ["read_messages"] },
    });
    const { mcpServers, notice } = buildKimiMcpServers(spec);
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld.slice().sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "github", reason: "allowlist" },
      { name: "slack", reason: "allowlist" },
    ]);
  });

  it("mcpToolAllowlist configured still withholds chimera's own grant, but with reason stdio-unsupported (the allowlist never governed the chimera server on any provider)", () => {
    const spec = kmSpec({
      orchestration: { allow: true, maxDepth: 2 },
      mcpServers: { slack: { command: "slack-mcp" } },
      mcpToolAllowlist: {},
    });
    const { mcpServers, notice } = buildKimiMcpServers(spec);
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld).toEqual([
      { name: "chimera", reason: "stdio-unsupported" },
      { name: "slack", reason: "allowlist" },
    ]);
  });

  it("settingSourcesUnsupported reflects a non-empty inherit.settingSources (loadSettings resolved by supervisor.ts before reaching this backend)", () => {
    const spec = kmSpec({ inherit: { settingSources: ["project", "user"] } });
    const { notice } = buildKimiMcpServers(spec);
    expect(notice.settingSourcesUnsupported).toBe(true);
  });

  // KIMI-STDIO-CAPABILITY-LIVE: McpCapabilities has no `stdio` key in the published SDK type
  // today, so this stubs one on anyway (as an upstream CLI/protocol bump would) to prove the
  // withhold decision genuinely reads it rather than being hard-coded off.
  it("a stubbed initialize() response advertising stdio flips the withhold decision — servers are wired through, not withheld", () => {
    const spec = { ...kmSpec({ orchestration: { allow: true, maxDepth: 3 }, mcpServers: { slack: { command: "slack-mcp", args: ["--foo"], env: { TOKEN: "x" } } } }), env: { CHIMERA_AGENT_ID: "km-1", CHIMERA_DEPTH: "0" } };
    const stubbedCaps = { http: false, sse: false, stdio: true } as unknown as Parameters<typeof buildKimiMcpServers>[1];
    const { mcpServers, notice } = buildKimiMcpServers(spec, stubbedCaps);
    expect(notice.mcpServersWithheld).toEqual([]);
    expect(mcpServers.map((s) => s.name).sort()).toEqual(["chimera", "slack"]);
    const chimera = mcpServers.find((s) => s.name === "chimera")!;
    expect(chimera.command).toBe(process.execPath);
    const slack = mcpServers.find((s) => s.name === "slack")!;
    expect(slack).toMatchObject({ command: "slack-mcp", args: ["--foo"] });
  });

  it("no stdio capability advertised (e.g. {http:true, sse:true}, the real live shape) -> still withheld, unchanged from today", () => {
    const spec = kmSpec({ orchestration: { allow: true, maxDepth: 3 } });
    const { mcpServers, notice } = buildKimiMcpServers(spec, { http: true, sse: true });
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld).toEqual([{ name: "chimera", reason: "stdio-unsupported" }]);
  });
});

describe("kimiModeFor — permission-profile/autonomy -> ACP session mode", () => {
  it("readOnly/acceptEdits (non-full profiles) -> default, regardless of autonomy", () => {
    expect(kimiModeFor(kmSpec({ permissionProfile: "readOnly" }))).toBe("default");
    expect(kimiModeFor(kmSpec({ permissionProfile: "acceptEdits", autonomy: "full" }))).toBe("default");
  });

  it("permissionProfile:'full' with autonomy not 'full' -> yolo (auto-approve, may still ask)", () => {
    expect(kimiModeFor(kmSpec({ permissionProfile: "full" }))).toBe("yolo");
  });

  it("permissionProfile:'full' AND autonomy:'full' -> auto (fully autonomous)", () => {
    expect(kimiModeFor(kmSpec({ permissionProfile: "full", autonomy: "full" }))).toBe("auto");
  });
});

describe("mapKimiPermissionOptions — fail-closed mapping onto whatever options the live session offered", () => {
  const options = [
    { optionId: "opt-allow-once", kind: "allow_once" as const, name: "Allow once" },
    { optionId: "opt-allow-always", kind: "allow_always" as const, name: "Allow always" },
    { optionId: "opt-reject-once", kind: "reject_once" as const, name: "Reject once" },
  ];
  it("true -> the allow_once option", () => {
    expect(mapKimiPermissionOptions(options, true)).toBe("opt-allow-once");
  });
  it("false -> the reject_once option", () => {
    expect(mapKimiPermissionOptions(options, false)).toBe("opt-reject-once");
  });
  it("a string deny-reason -> reject, never coerced into an approval", () => {
    expect(mapKimiPermissionOptions(options, "Refused: this targets main, not your worktree")).toBe("opt-reject-once");
  });
  it("true with no allow-kind option offered falls through to reject rather than fabricating an allow", () => {
    const rejectOnly = [{ optionId: "opt-r", kind: "reject_once" as const, name: "Reject" }];
    expect(mapKimiPermissionOptions(rejectOnly, true)).toBe("opt-r");
  });
  it("throws rather than answering blind when the session offers zero options", () => {
    expect(() => mapKimiPermissionOptions([], true)).toThrow(/no options/);
  });
});

describe("resolveKimiCliPath — PATH TRAP (precedent d8387e2), unchanged by the transport swap", () => {
  it("an explicit CHIMERA_KIMI_CLI_PATH override always wins", () => {
    const prev = process.env.CHIMERA_KIMI_CLI_PATH;
    process.env.CHIMERA_KIMI_CLI_PATH = "/override/kimi";
    try {
      expect(resolveKimiCliPath()).toBe("/override/kimi");
    } finally {
      if (prev === undefined) delete process.env.CHIMERA_KIMI_CLI_PATH; else process.env.CHIMERA_KIMI_CLI_PATH = prev;
    }
  });

  it("never returns a bare PATH-relative 'kimi' when an absolute resolution is available", () => {
    const prev = process.env.CHIMERA_KIMI_CLI_PATH;
    delete process.env.CHIMERA_KIMI_CLI_PATH;
    try {
      expect(typeof resolveKimiCliPath()).toBe("string");
    } finally {
      if (prev !== undefined) process.env.CHIMERA_KIMI_CLI_PATH = prev;
    }
  });
});

describe("KimiAgentBackend.spawn — wiring, via a scripted fake ACP session", () => {
  it("emits agent_started AFTER the real session is ready, carrying its sessionId (RESUME fix: the old code never included one)", async () => {
    const { factory } = fakeKimi([{}]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs[0]).toMatchObject({ kind: "agent_started", data: { sessionId: "sess-fake-1", model: "kimi-k3" } });
  });

  it("a realistic tool-call turn emits exactly one tool_call and one tool_result, correlated by toolId (KIMI-TOOL-EVENT-ORPHANS acceptance)", async () => {
    // Mirrors the raw-wire probe of the real CLI: tool_call(pending) -> in_progress updates
    // (which must produce NOTHING) -> tool_call_update(completed) with content + shimmed rawOutput.
    const { factory } = fakeKimi([{
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "0:tool_A", title: "Bash", kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: "" } }] },
        { sessionUpdate: "tool_call_update", toolCallId: "0:tool_A", status: "in_progress", content: [{ type: "content", content: { type: "text", text: '{"command":"echo hi"}' } }] },
        { sessionUpdate: "tool_call_update", toolCallId: "0:tool_A", title: "Running: echo hi", kind: "execute", status: "in_progress", rawInput: { command: "echo hi" } },
        { sessionUpdate: "tool_call_update", toolCallId: "0:tool_A", status: "completed", content: [{ type: "content", content: { type: "text", text: "hi\n" } }], rawOutput: { text: "hi\n" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      ],
    }]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "tool_call", "tool_result", "message_delta", "turn_complete", "result"]);
    const call = evs.find((e) => e.kind === "tool_call")!;
    const result = evs.find((e) => e.kind === "tool_result")!;
    expect(call.data["toolId"]).toBe("0:tool_A");
    expect(result.data["toolId"]).toBe("0:tool_A");
    expect(result.data).toMatchObject({ toolName: "Bash", isError: false, result: "hi\n" });
  });

  it("a FAILED tool call still terminates: tool_result with isError:true, and the turn completes normally", async () => {
    const { factory } = fakeKimi([{
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "0:tool_B", title: "Bash", kind: "execute", status: "pending" },
        { sessionUpdate: "tool_call_update", toolCallId: "0:tool_B", status: "failed", content: [{ type: "content", content: { type: "text", text: "Process exited with code 7" } }], rawOutput: { text: "Process exited with code 7" } },
      ],
    }]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "tool_call", "tool_result", "turn_complete", "result"]);
    expect(evs.find((e) => e.kind === "tool_result")!.data).toMatchObject({ toolId: "0:tool_B", isError: true, result: "Process exited with code 7" });
  });

  it("a turn that settles with a tool call still open (interrupt/dropped update) sweeps it closed -- no permanent spinner", async () => {
    const { factory } = fakeKimi([{
      updates: [{ sessionUpdate: "tool_call", toolCallId: "0:tool_C", title: "Bash", kind: "execute", status: "pending" }],
      stopReason: "cancelled",
    }]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "tool_call", "tool_result", "turn_complete", "result"]);
    const swept = evs.find((e) => e.kind === "tool_result")!;
    expect(swept.data).toMatchObject({ toolId: "0:tool_C", isError: true });
    expect(evs.find((e) => e.kind === "turn_complete")!.data["interrupted"]).toBe(true);
  });

  it("normalizes a full turn and emits a result -- costUsd is always 0 (ACP has no usage telemetry), never fabricated", async () => {
    const { factory } = fakeKimi([{ updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } }] }]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    const result = evs.find((e) => e.kind === "result")!;
    expect(result).toBeDefined();
    expect(result.data["text"]).toBe("Hello");
    expect(result.data["model"]).toBe("kimi-k3");
    expect(result.data["costUsd"]).toBe(0);
    const turnComplete = evs.find((e) => e.kind === "turn_complete")!;
    expect(turnComplete.data["stopReason"]).toBe("end_turn");
  });

  it("a failed prompt() call ends the run without a result", async () => {
    const { factory } = fakeKimi([{ updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } }], error: "kimi blew up" }]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "message_delta", "error"]);
  });

  it("a connection failure (handshake rejects) surfaces a clean error, no agent_started", async () => {
    const factory: KimiFactory = () => ({ ready: Promise.reject(new Error("kimi acp exited with code 1: unknown option")), killNow: () => {} });
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs).toEqual([{ kind: "error", data: { message: "kimi acp exited with code 1: unknown option", phase: "handshake" } }]);
  });

  it("describeKimiError folds a RequestError's code+data into the message (jsonrpc.js's .message is always the generic spec text)", () => {
    const err = new RequestError(-32603, "Internal error", { cause: "kimi CLI protocol mismatch: unknown method newSession" });
    expect(describeKimiError(err)).toBe(
      'Internal error (code -32603) {"cause":"kimi CLI protocol mismatch: unknown method newSession"}',
    );
    expect(describeKimiError(new Error("plain failure"))).toBe("plain failure");
    expect(describeKimiError("not an error object")).toBe("not an error object");
  });

  it("a RequestError handshake rejection surfaces its .data detail in the error event, not a bare 'Internal error'", async () => {
    const factory: KimiFactory = () => ({
      ready: Promise.reject(new RequestError(-32603, "Internal error", { detail: "unknown method newSession" })),
      killNow: () => {},
    });
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(evs).toEqual([
      { kind: "error", data: { message: 'Internal error (code -32603) {"detail":"unknown method newSession"}', phase: "handshake" } },
    ]);
  });

  it("delivers a queued follow-up send() as a second prompt() call and reflects its own result", async () => {
    const { factory, prompts } = fakeKimi([
      {},
      { updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } }] },
    ]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const handle = backend.spawn(kmSpec({ persistent: true }), (e) => evs.push(e), async () => true);
    await settle();
    await handle.send("follow up");
    await settle();
    await handle.kill();
    expect(prompts).toEqual(["task", "follow up"]);
    expect(evs.some((e) => e.kind === "message_delta" && e.data["text"] === "second")).toBe(true);
  });

  it("send() rejects images/content blocks explicitly instead of silently dropping them (text-only send, unchanged scope)", async () => {
    const { factory } = fakeKimi([{}]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const handle = backend.spawn(kmSpec({ persistent: true }), () => {}, async () => true);
    await settle();
    await expect(handle.send("hi", [{ mediaType: "image/png", data: "AA==" }] as never)).rejects.toThrow(/does not support image content/);
  });

  it("send() after kill() rejects (input stream closed)", async () => {
    const { factory } = fakeKimi([{}]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const handle = backend.spawn(kmSpec({ persistent: true }), () => {}, async () => true);
    await settle();
    await handle.kill();
    await settle();   // let run()'s finally (loop.end()) land before send() -- codex.ts precedent
    await expect(handle.send("too late")).rejects.toThrow(/input stream closed/);
  });

  it("interrupt() sends session.cancel() on the in-flight turn (fire-and-forget, not a rejecting abort)", async () => {
    let resolveTurn: ((v: { stopReason: string }) => void) | null = null;
    const cancelCalls: number[] = [];
    const factory: KimiFactory = (_spec, _cwd, _deps) => ({
      ready: Promise.resolve({
        sessionId: "sess-1",
        prompt: () => new Promise((resolve) => { resolveTurn = resolve; }),
        cancel: async () => { cancelCalls.push(1); resolveTurn?.({ stopReason: "cancelled" }); },
        close: async () => {},
      }),
      killNow: () => {},
    });
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data?: Record<string, unknown> }> = [];
    const handle = backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
    await settle();
    expect(cancelCalls.length).toBe(0);
    await handle.interrupt();
    await settle();
    expect(cancelCalls.length).toBe(1);
    expect(evs.some((e) => e.kind === "turn_complete" && e.data?.["interrupted"] === true)).toBe(true);
    // The session stays alive after a cancelled turn (persistent contract) -- no result yet since
    // this spec isn't conductor/persistent, so the loop just idles out; nothing more to assert.
  });

  it("kill() reaches the real process immediately, even mid-handshake (killNow is available before `ready` settles)", async () => {
    const killCalls: number[] = [];
    let readyResolve: (() => void) | null = null;
    const factory: KimiFactory = () => ({
      ready: new Promise((resolve) => { readyResolve = () => resolve({ sessionId: "s", prompt: async () => ({ stopReason: "end_turn" }), cancel: async () => {}, close: async () => {} }); }),
      killNow: () => killCalls.push(1),
    });
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const handle = backend.spawn(kmSpec(), () => {}, async () => true);
    await handle.kill();   // called BEFORE the handshake ever resolves
    expect(killCalls.length).toBe(1);
    readyResolve?.();      // let the handshake finish late -- must not produce a result after kill
    await settle();
  });

  it("close() has the same hard-stop effect as kill()", async () => {
    const killCalls: number[] = [];
    const { factory } = fakeKimi([{}]);
    const wrapped: KimiFactory = (spec, cwd, deps) => {
      const inner = factory(spec, cwd, deps);
      return { ready: inner.ready, killNow: () => { killCalls.push(1); inner.killNow(); } };
    };
    const backend = new KimiAgentBackend({ kimiFactory: wrapped });
    const handle = backend.spawn(kmSpec({ persistent: true }), () => {}, async () => true);
    await handle.close?.();
    expect(killCalls.length).toBe(1);
  });

  it("CROSS-PROVIDER-MCP-STORE: a withheld-server spawn emits a capabilityNotice status event and appends one short line to the first prompt; a plain spawn emits neither", async () => {
    const { factory, prompts } = fakeKimi([{}]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const spec = kmSpec({ mcpServers: { slack: { command: "slack-mcp" } }, mcpToolAllowlist: { slack: ["read"] } });
    backend.spawn(spec, (e) => evs.push(e), async () => true);
    await settle();
    const notice = evs.find((e) => e.kind === "status" && "capabilityNotice" in e.data);
    expect(notice).toBeDefined();
    expect((notice!.data["capabilityNotice"] as { mcpServersWithheld: Array<{ name: string; reason: string }> }).mcpServersWithheld).toEqual([{ name: "slack", reason: "allowlist" }]);
    expect(prompts[0]).toContain("[chimera capability notice]");
    expect(prompts[0]).toContain("slack");

    const { factory: plainFactory, prompts: plainPrompts } = fakeKimi([{}]);
    const plainEvs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    new KimiAgentBackend({ kimiFactory: plainFactory }).spawn(kmSpec(), (e) => plainEvs.push(e), async () => true);
    await settle();
    expect(plainEvs.some((e) => e.kind === "status" && "capabilityNotice" in e.data)).toBe(false);
    expect(plainPrompts[0]).not.toContain("capability notice");
  });

  it("KIMI-STDIO-MCP-UNSUPPORTED: an orchestration.allow spawn — the actual incident path — surfaces the withheld chimera grant in BOTH the status event and the first prompt", async () => {
    // The pre-existing notice test only covers the allowlist/slack case; the path this fix
    // exists for (every chimera-granted kimi spawn now losing its native tools) was untested at
    // spawn level, so a regression that dropped the chimera entry from the notice would pass.
    const { factory, prompts } = fakeKimi([{}]);
    const evs: Array<{ kind: string; data: Record<string, unknown> }> = [];
    new KimiAgentBackend({ kimiFactory: factory })
      .spawn(kmSpec({ orchestration: { allow: true, maxDepth: 3 } }), (e) => evs.push(e), async () => true);
    await settle();
    const notice = evs.find((e) => e.kind === "status" && "capabilityNotice" in e.data);
    expect(notice).toBeDefined();
    const payload = notice!.data["capabilityNotice"] as { mcpServersWithheld: Array<{ name: string; reason: string }>; lines: string[] };
    expect(payload.mcpServersWithheld).toEqual([{ name: "chimera", reason: "stdio-unsupported" }]);
    // `lines` is what the reducer renders as the operator-facing system line — it must name the
    // server AND say what the agent lost, not just carry the structured pair.
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toContain("chimera");
    expect(payload.lines[0]).toMatch(/stdio/);
    expect(prompts[0]).toContain("[chimera capability notice]");
    expect(prompts[0]).toContain("chimera");
  });

  it("KIMI-ERROR-DATA-UNTRUSTED: describeKimiError scrubs secret-shaped values out of .data and caps its length (it lands verbatim in the durable event log)", () => {
    const leaky = describeKimiError(new RequestError(-32602, "Invalid params", {
      received: { env: [{ name: "SLACK_TOKEN", value: "sk-abcdefghijklmnop1234" }] },
    }));
    expect(leaky).not.toContain("sk-abcdefghijklmnop1234");
    expect(leaky).toContain("[REDACTED]");
    // The leading `message (code N)` is classifyError's substring surface — must stay byte-exact.
    expect(leaky.startsWith("Invalid params (code -32602) ")).toBe(true);

    const huge = describeKimiError(new RequestError(-32603, "Internal error", { blob: "x".repeat(50_000) }));
    expect(huge.length).toBeLessThan(4200);
    expect(huge).toContain("(truncated)");
    expect(huge.startsWith("Internal error (code -32603) ")).toBe(true);

    // Untrusted `.data` must never turn the error report itself into a second failure.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => describeKimiError(new RequestError(-32603, "Internal error", cyclic))).not.toThrow();
    expect(describeKimiError(new RequestError(-32603, "Internal error", () => {}))).not.toContain("undefined");
  });

  it("threads spec.resume through to the factory (loadSession path, verified structurally)", async () => {
    const { factory, resumeSeen } = fakeKimi([{}]);
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    backend.spawn(kmSpec({ resume: "sess-old-123", resumeOnly: true }), () => {}, async () => true);
    await settle();
    expect(resumeSeen()).toBe("sess-old-123");
  });

  it("refreshes instructions once after idle reattach, preserving native slash commands", async () => {
    const { factory, prompts } = fakeKimi([{}, {}, {}]);
    const handle = new KimiAgentBackend({ kimiFactory: factory }).spawn(
      kmSpec({ persistent: true, resume: "sess-old", resumeOnly: true, instructions: "Chimera MCP first." }), () => {}, async () => true,
    );
    await settle();
    expect(prompts).toEqual([]);
    await handle.send("/compact"); await settle();
    await handle.send("/tmp/project: new task"); await settle();
    await handle.send("follow up"); await settle();
    expect(prompts).toEqual(["/compact", "Chimera MCP first.\n\n/tmp/project: new task", "follow up"]);
    await handle.kill();
  });

  describe("requestPermission -> decidePermission round trip", () => {
    it("an allow decision (true) is asked with the tool_call's title/rawInput", async () => {
      const { factory, decideCalls } = fakeKimi([{
        permission: { toolCallId: "tc-1", title: "write_file", rawInput: { path: "a.ts" }, options: [] },
        updates: [],
      }]);
      const decideRequests: unknown[] = [];
      const backend = new KimiAgentBackend({ kimiFactory: factory });
      backend.spawn(kmSpec(), () => {}, async (req) => { decideRequests.push(req); return true; });
      await settle();
      expect(decideRequests).toEqual([{ requestId: "tc-1", toolName: "write_file", input: { path: "a.ts" } }]);
      expect(decideCalls).toEqual([true]);
    });

    it("does not itself sink a permission_request event -- decidePermission (supervisor.ts) owns emitting the canonical one", async () => {
      const { factory } = fakeKimi([{ permission: { toolCallId: "tc-2", title: "run_shell", options: [] } }]);
      const backend = new KimiAgentBackend({ kimiFactory: factory });
      const evs: Array<{ kind: string }> = [];
      backend.spawn(kmSpec(), (e) => evs.push(e), async () => true);
      await settle();
      expect(evs.some((e) => e.kind === "permission_request")).toBe(false);
    });
  });
});

describe("KimiAgentBackend.spawn — kill() against a REAL child OS process (§11-S2 acceptance, carried forward: test the process, not the stream)", () => {
  it("kill() actually terminates the real spawned kimi process, not merely the ACP connection", async () => {
    // A real, non-existent-handshake spawn target: this fixture ignores every argv
    // (--model/--skills-dir/acp/...) and never writes a byte to stdout, so initialize() never
    // resolves -- it stays alive to be genuinely killed while the handshake is still pending.
    const workdir = mkdtempSync(join(tmpdir(), "kimi-backend-test-"));
    const cliPath = fileURLToPath(new URL("./fixtures/kimi-hang-cli.mjs", import.meta.url));
    const backend = new KimiAgentBackend();   // the REAL default factory -- genuinely spawns a child process
    const spec = kmSpec({ cwd: workdir, providerOptions: { executable: cliPath } });
    const handle = backend.spawn(spec, () => {}, async () => true);

    let found = false;
    for (let i = 0; i < 100; i++) {
      try {
        const out = execFileSync("pgrep", ["-f", cliPath]).toString().trim();
        if (out) { found = true; break; }
      } catch { /* pgrep exits non-zero while nothing matches yet */ }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(found).toBe(true);

    await handle.kill();

    let stillAlive = true;
    for (let i = 0; i < 150; i++) {
      try {
        execFileSync("pgrep", ["-f", cliPath]);
      } catch {
        stillAlive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stillAlive).toBe(false);
  }, 10_000);
});

// DYNAMIC-MODEL-LISTS: kimi answers `session/new` with its own live model catalog as a
// configOptions select. It used to be discarded, so every chimera model picker showed the
// ONE-entry static catalog while the CLI itself offered four. The shapes below are the real
// wire payload captured from kimi 0.37.2.
describe("kimiModelOptions — the model list rides the newSession response", () => {
  const realPayload = [
    { type: "select", id: "model", name: "Model", category: "model", currentValue: "kimi-code/k3", options: [
      { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
      { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" },
      { value: "kimi-code/k3", name: "K3" },
      { value: "kimi-code/k3-256k", name: "K3-256k" },
    ] },
    { type: "select", id: "thinking", name: "Thinking", category: "thought_level", currentValue: "high", options: [{ value: "low", name: "Low" }] },
  ] as never;

  it("extracts every model with its id AND the provider's own display name", () => {
    expect(kimiModelOptions(realPayload)).toEqual([
      { value: "kimi-code/kimi-for-coding", displayName: "K2.7 Coding" },
      { value: "kimi-code/kimi-for-coding-highspeed", displayName: "K2.7 Coding Highspeed" },
      { value: "kimi-code/k3", displayName: "K3" },
      { value: "kimi-code/k3-256k", displayName: "K3-256k" },
    ]);
  });

  it("picks the option by CATEGORY, not by id — a vendor may name the id anything", () => {
    const renamed = [{ type: "select", id: "llm", name: "LLM", category: "model", options: [{ value: "m1", name: "M1" }] }] as never;
    expect(kimiModelOptions(renamed)).toEqual([{ value: "m1", displayName: "M1" }]);
  });

  it("flattens GROUPED select options (SessionConfigSelectOptions is a union of both shapes)", () => {
    const grouped = [{ type: "select", id: "model", category: "model", name: "Model", options: [
      { group: "fast", name: "Fast", options: [{ value: "a", name: "A" }] },
      { group: "deep", name: "Deep", options: [{ value: "b", name: "B", description: "slow" }] },
    ] }] as never;
    expect(kimiModelOptions(grouped)).toEqual([
      { value: "a", displayName: "A" },
      { value: "b", displayName: "B", description: "slow" },
    ]);
  });

  it("returns [] for every shape it cannot read, so a changed payload can never blank the picker", () => {
    expect(kimiModelOptions(undefined)).toEqual([]);
    expect(kimiModelOptions(null)).toEqual([]);
    expect(kimiModelOptions([] as never)).toEqual([]);
    expect(kimiModelOptions([{ type: "boolean", id: "model", category: "model", name: "Model", value: true }] as never)).toEqual([]);
    expect(kimiModelOptions([{ type: "select", id: "thinking", category: "thought_level", name: "T", options: [{ value: "low", name: "Low" }] }] as never)).toEqual([]);
  });
});

// F49 LOOPBACK-HTTP-MCP: chimera's own tool table reaches kimi over a per-agent, loopback-only
// HTTP MCP grant instead of the stdio child the CLI rejects. The unit block below pins the pure
// wiring decision; the real-child block after it pins the two things a pure function cannot show
// -- what actually lands on the ACP wire, and that the grant dies with the process.
const F49_GRANT = { url: "http://127.0.0.1:54321/mcp/11111111-1111-4111-8111-111111111111", token: "tok-f49" };

describe("buildKimiMcpServers — F49 loopback http MCP grant", () => {
  it("wires chimera as an ACP http MCP server when the CLI advertises http and a grant was issued", () => {
    const spec = kmSpec({ orchestration: { allow: true, maxDepth: 3 } });
    const { mcpServers, notice } = buildKimiMcpServers(spec, { http: true, sse: true }, F49_GRANT, true);
    expect(notice.mcpServersWithheld).toEqual([]);
    expect(mcpServers).toEqual([{
      type: "http", name: "chimera", url: F49_GRANT.url,
      headers: [{ name: "Authorization", value: `Bearer ${F49_GRANT.token}` }],
    }]);
  });

  it("prefers http over stdio when the CLI advertises both", () => {
    const spec = kmSpec({ orchestration: { allow: true, maxDepth: 3 } });
    const bothCaps = { http: true, sse: false, stdio: true } as unknown as Parameters<typeof buildKimiMcpServers>[1];
    const { mcpServers } = buildKimiMcpServers(spec, bothCaps, F49_GRANT, true);
    expect(mcpServers).toHaveLength(1);
    expect(mcpServers[0]).toMatchObject({ type: "http", name: "chimera" });
    // The stdio entry ships CHIMERA_AGENT_ID/DEPTH/... as env for a child to read back; the http
    // one carries identity server-side only. Wiring both would re-open the wider door.
    expect(mcpServers[0]).not.toHaveProperty("command");
  });

  it('withholds chimera with reason "listener-disabled" when the listener is enabled but the CLI advertises neither http nor stdio', () => {
    const spec = kmSpec({ orchestration: { allow: true, maxDepth: 3 } });
    const { mcpServers, notice } = buildKimiMcpServers(spec, { http: false, sse: true }, null, true);
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld).toEqual([{ name: "chimera", reason: "listener-disabled" }]);
  });

  it('keeps today\'s "stdio-unsupported" withhold when no engine accessor is present', () => {
    const spec = kmSpec({ orchestration: { allow: true, maxDepth: 3 } });
    const { mcpServers, notice } = buildKimiMcpServers(spec, { http: false, sse: true }, null, false);
    expect(mcpServers).toEqual([]);
    expect(notice.mcpServersWithheld).toEqual([{ name: "chimera", reason: "stdio-unsupported" }]);
  });

  it("leaves spec.mcpServers entries stdio-only and allowlist-fail-closed even when a grant is wired", () => {
    const spec = kmSpec({
      orchestration: { allow: true, maxDepth: 3 },
      mcpServers: { slack: { command: "slack-mcp" } },
      mcpToolAllowlist: { slack: ["read_messages"] },
    });
    const { mcpServers, notice } = buildKimiMcpServers(spec, { http: true, sse: true }, F49_GRANT, true);
    // The grant is chimera's OWN door: it never widens to third-party servers, which stay
    // withheld for exactly the reasons they were before F49.
    expect(mcpServers.map((s) => s.name)).toEqual(["chimera"]);
    expect(notice.mcpServersWithheld).toEqual([{ name: "slack", reason: "allowlist" }]);
  });
});

type GrantSpy = { calls: Array<Record<string, unknown>>; revokes: number };
function spyGrantEngine(spy: GrantSpy, grant: { url: string; token: string } | null = F49_GRANT): ChimeraEngineAccessor {
  return {
    get: () => ({
      mcpListener: {
        grant: async (ctx: Record<string, unknown>) => {
          spy.calls.push(ctx);
          return grant === null ? null : { ...grant, revoke: () => { spy.revokes++; } };
        },
      },
    }),
  } as unknown as ChimeraEngineAccessor;
}

describe("KimiAgentBackend — F49 grant ctx and first-turn notice", () => {
  function capturingKimi() {
    let captured: Parameters<KimiFactory>[2] | null = null;
    const prompts: string[] = [];
    const factory: KimiFactory = (_spec, _cwd, deps) => {
      captured = deps;
      const ready = Promise.resolve().then(async () => ({
        sessionId: "sess-cap-1",
        prompt: async (content: KimiTextBlock[]) => { prompts.push(content.map(block => block.text).join("\n\n")); return { stopReason: "end_turn" }; },
        cancel: async () => {},
        close: async () => {},
      }));
      return { ready, killNow: () => {} };
    };
    return { factory, prompts, deps: () => captured };
  }

  it("grants a ctx whose depth is spec.depth + 1 and whose maxDepthCap is spec.orchestration.maxDepth", async () => {
    const spy: GrantSpy = { calls: [], revokes: 0 };
    const cap = capturingKimi();
    const backend = new KimiAgentBackend({ kimiFactory: cap.factory, engine: spyGrantEngine(spy) });
    const spec = { ...kmSpec({ orchestration: { allow: true, maxDepth: 4 }, autonomy: "full" }), env: { CHIMERA_AGENT_ID: "km-1", CHIMERA_DEPTH: "0", CHIMERA_TREE_ID: "tree-9", CHIMERA_TEAM: "team-9" } } as ResolvedAgentSpec;
    backend.spawn(spec, () => {}, async () => true);
    await settle();
    await cap.deps()!.grantMcp!();
    // packages/mcp/src/server.ts derives its ctx depth as CHIMERA_DEPTH + 1, so the http grant
    // must carry spec.depth + 1 to be the same authority the stdio child would have had.
    expect(spy.calls[0]).toEqual({
      agentId: "km-1", depth: 1, maxDepthCap: 4, treeId: "tree-9", team: "team-9",
      autonomy: "full", provider: "kimi",
    });
  });

  it("never grants conductor or toolTags", async () => {
    const spy: GrantSpy = { calls: [], revokes: 0 };
    const cap = capturingKimi();
    const backend = new KimiAgentBackend({ kimiFactory: cap.factory, engine: spyGrantEngine(spy) });
    backend.spawn(kmSpec({ orchestration: { allow: true, maxDepth: 2 } }), () => {}, async () => true);
    await settle();
    await cap.deps()!.grantMcp!();
    // The stdio env block carries no equivalent of either, so an http agent must not be able to
    // acquire authority its stdio twin could never have had.
    expect("conductor" in spy.calls[0]!).toBe(false);
    expect("toolTags" in spy.calls[0]!).toBe(false);
  });

  it("builds the first-turn capability notice from the POST-handshake notice", async () => {
    const factory: KimiFactory = () => ({
      ready: Promise.resolve({
        sessionId: "sess-notice-1",
        // Pre-F49 the notice was built in spawn(), before initialize() -- always "stdio-unsupported".
        // Only the connection knows the live verdict, so the prompt must quote THIS, not a rebuild.
        mcpNotice: { mcpServersWithheld: [{ name: "chimera", reason: "listener-disabled" as const }], settingSourcesUnsupported: false },
        prompt: async (content: KimiTextBlock[]) => { prompts.push(content.map(block => block.text).join("\n\n")); return { stopReason: "end_turn" }; },
        cancel: async () => {},
        close: async () => {},
      }),
      killNow: () => {},
    });
    const prompts: string[] = [];
    const backend = new KimiAgentBackend({ kimiFactory: factory });
    backend.spawn(kmSpec({ orchestration: { allow: true, maxDepth: 2 } }), () => {}, async () => true);
    await settle();
    expect(prompts[0]).toContain("loopback HTTP MCP listener");
    expect(prompts[0]).not.toContain("rejects stdio-transport MCP servers");
  });
});

describe("KimiAgentBackend.spawn — F49 grant against a REAL ACP-speaking child process", () => {
  const cliPath = fileURLToPath(new URL("./fixtures/kimi-acp-cli.mjs", import.meta.url));

  function liveSpec(workdir: string, logPath: string, extraEnv: Record<string, string> = {}): ResolvedAgentSpec {
    return {
      ...kmSpec({ cwd: workdir, orchestration: { allow: true, maxDepth: 3 }, providerOptions: { executable: cliPath } }),
      env: { CHIMERA_AGENT_ID: "km-1", CHIMERA_DEPTH: "0", KIMI_FAKE_LOG: logPath, ...extraEnv },
    } as ResolvedAgentSpec;
  }

  async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
    for (let i = 0; i < ms / 25; i++) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return pred();
  }

  it("wires chimera as an ACP http MCP server when the CLI advertises http and a grant was issued", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "kimi-f49-"));
    const logPath = join(workdir, "acp.log");
    const spy: GrantSpy = { calls: [], revokes: 0 };
    const backend = new KimiAgentBackend({ engine: spyGrantEngine(spy) });   // REAL connectKimiAcp
    const handle = backend.spawn(liveSpec(workdir, logPath), () => {}, async () => true);

    const sawNewSession = await waitFor(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("session/new"));
    expect(sawNewSession).toBe(true);
    const newSession = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; params: { mcpServers?: unknown[] } }).find((m) => m.method === "session/new")!;
    expect(newSession.params.mcpServers).toEqual([{
      type: "http", name: "chimera", url: F49_GRANT.url,
      headers: [{ name: "Authorization", value: `Bearer ${F49_GRANT.token}` }],
    }]);
    await handle.kill();
  }, 15_000);

  it("revokes the grant when the agent is killed", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "kimi-f49-"));
    const logPath = join(workdir, "acp.log");
    const spy: GrantSpy = { calls: [], revokes: 0 };
    const backend = new KimiAgentBackend({ engine: spyGrantEngine(spy) });
    const handle = backend.spawn(liveSpec(workdir, logPath), () => {}, async () => true);

    expect(await waitFor(() => spy.calls.length === 1)).toBe(true);
    expect(spy.revokes).toBe(0);   // still live: the fixture never answers session/prompt
    await handle.kill();
    expect(await waitFor(() => spy.revokes >= 1)).toBe(true);
  }, 15_000);

  it("revokes the grant when the ACP child exits on its own", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "kimi-f49-"));
    const logPath = join(workdir, "acp.log");
    const spy: GrantSpy = { calls: [], revokes: 0 };
    const backend = new KimiAgentBackend({ engine: spyGrantEngine(spy) });
    // terminate() never runs on this path, so only the child's own exit handler can revoke --
    // a grant outliving the process holding its token is the one state this must never reach.
    const handle = backend.spawn(liveSpec(workdir, logPath, { KIMI_FAKE_EXIT_AFTER_NEW: "1" }), () => {}, async () => true);

    expect(await waitFor(() => spy.calls.length === 1)).toBe(true);
    expect(await waitFor(() => spy.revokes >= 1)).toBe(true);
    await handle.kill();
  }, 15_000);
});

it("keeps peer provenance and body in separate ACP content blocks", async () => {
  const { factory, prompts, promptBlocks } = fakeKimi([{}]);
  const handle = new KimiAgentBackend({ kimiFactory: factory }).spawn(kmSpec({ persistent: true, resumeOnly: true }), () => {}, async () => true);
  await settle();
  const metadata = { from: "peer-id", source: "agent" as const, kind: "user_message" as const, engineId: "local", label: "Reviewer" };
  await handle.send("Review this", undefined, undefined, { messages: [createMessage("Review this", metadata)] });
  await settle();
  expect(prompts).toEqual([JSON.stringify({ message: { from: metadata.from, source: metadata.source } }) + "\n\nReview this"]);
  expect(promptBlocks).toEqual([[{ type: "text", text: JSON.stringify({ message: { from: metadata.from, source: metadata.source } }) }, { type: "text", text: "Review this" }]]);
  await handle.kill();
});

it("preserves context, provenance and task as separate blocks on the real ACP wire", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "kimi-delivery-"));
  const logPath = join(workdir, "requests.jsonl");
  const metadata = { from: "conductor", source: "agent" as const, kind: "user_message" as const, engineId: "local" };
  const spec = {
    ...kmSpec({ cwd: workdir, instructions: "Review policy", providerOptions: { executable: fileURLToPath(new URL("./fixtures/kimi-acp-cli.mjs", import.meta.url)) } }),
    initialDelivery: { messages: [createMessage("task", metadata)] },
    env: { KIMI_FAKE_LOG: logPath },
  };
  const handle = new KimiAgentBackend().spawn(spec, () => {}, async () => true);
  try {
    await vi.waitFor(() => {
      const requests = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(requests.find(request => request.method === "session/prompt")?.params.prompt).toEqual([
        { type: "text", text: "Review policy" },
        { type: "text", text: JSON.stringify({ message: { from: metadata.from, source: metadata.source } }) },
        { type: "text", text: "task" },
      ]);
    }, { timeout: 5000 });
  } finally { await handle.kill(); }
});
