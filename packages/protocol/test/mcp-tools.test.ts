import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CORE_MCP_TOOL_NAMES, EXTENDED_MCP_TOOL_NAMES, MCP_TOOL_TABLE, estimateChimeraMcpToolSurface, grantedChimeraToolNames, mcpToolTags } from "../src/mcp-tools.js";
import { createChimeraMcpServer } from "../src/mcp-server-factory.js";
import { TopicFilterSchema, TopicSchema } from "../src/index.js";

// TOKEN-OPT-P2: role-scope the full chimera MCP schema behind a small "core" set,
// eagerly registered, plus chimera_tools/chimera_call fronting everything else ("extended").
describe("mcp-tools tiering (TOKEN-OPT-P2)", () => {
  it("every tool has a tier, and core/extended partition the table with no overlap", () => {
    for (const t of MCP_TOOL_TABLE) expect(["core", "extended"]).toContain(t.tier);
    const core = new Set(CORE_MCP_TOOL_NAMES);
    const extended = new Set(EXTENDED_MCP_TOOL_NAMES);
    expect(core.size + extended.size).toBe(MCP_TOOL_TABLE.length);
    for (const name of core) expect(extended.has(name)).toBe(false);
  });

  it("chimera_tools and chimera_call are themselves core tier (always present when orchestration is granted)", () => {
    expect(CORE_MCP_TOOL_NAMES).toContain("chimera_tools");
    expect(CORE_MCP_TOOL_NAMES).toContain("chimera_call");
  });

  it("pins the eager core at the minimal orientation/response surface", () => {
    // New tools default to extended, and promotions must be deliberate: silently growing
    // this list charges every agent at spawn even when provider-side schema deferral works.
    expect(CORE_MCP_TOOL_NAMES.length).toBeLessThan(EXTENDED_MCP_TOOL_NAMES.length);
    expect(CORE_MCP_TOOL_NAMES).toEqual([
      "daemon_status",
      "agent_spawn", "agent_status", "agent_result", "agent_wait", "agent_send",
      // TERMINAL-READBACK: the promotion this test exists to make deliberate. Reachable-only via
      // chimera_tools was tried first and observed to fail — asked what was in the terminal open
      // under it, the agent replied that it could not see the operator's terminal and never went
      // looking. The operator asking about a terminal they opened under this agent IS the feature.
      // (Position follows MCP_TOOL_TABLE order, which this list is derived from.)
      "memory_add", "terminal_read", "terminal_write", "rename_self", "memory_search",
      "ask_human", "ask_agent", "ask_team", "answer_question",
      "subscribe", "engine_help",
      "team_list", "my_team", "queue_push",
      "mcp_store_tools", "mcp_store_call",
      "chimera_tools", "chimera_call",
    ]);
  });

  it("keeps eager discovery copy concise without dropping its routing vocabulary", () => {
    const coreTools = MCP_TOOL_TABLE
      .filter((t) => t.tier === "core")
      .map(({ name, description }) => ({ name, description }));
    // TOOL-SURFACE-IS-MORE-THAN-COPY: this used to measure name + description only, which is 36% of
    // what actually reaches the model — the registered inputSchema goes with every tool and is the
    // OTHER 64%. So the guard has been protecting the smaller half: agent_spawn's schema alone is
    // 2,234 characters against its 1,487-character description, and no budget here would have
    // noticed a schema doubling. Measured as it ships now.
    const eagerPayload = JSON.stringify({
      instructions: null,
      tools: MCP_TOOL_TABLE.filter((t) => t.tier === "core").map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ? z.toJSONSchema(z.object(t.inputSchema)) : { type: "object", properties: {} },
      })),
    });
    // Leaves room for W2-1's resultSchema sentence while preventing a return to the
    // pre-W2-5 8.7K-character payload. SESSION-TIER's rename_self promotion nudged this
    // budget up once (5000 -> 5200); REBIND's one-shot-guard sentence on rename_self's own
    // description nudges it again (5200 -> 5300) rather than trimming an unrelated tool's copy.
    // TASK-TAGS adds one clause to queue_push (5300 -> 5400): tags are the ONLY thing a
    // hook/subscription tag filter can match, so an agent that never learns they exist can't
    // route or audit its own work — the clause is deliberately terse for exactly this budget.
    // MEMORY-NO-DUPLICATES adds one to memory_add (5400 -> 5500): the store now REFUSES a
    // restatement, and a refusal an agent could not see coming reads as a broken tool. This
    // clause is what makes it read as the expected path instead — it has to be in the EAGER
    // copy, since by the time the agent could look the tool up it has already been refused.
    // TOKEN-OPT-SEARCH-EXCERPT adds one to memory_search (5500 -> 5600): a hit's text is now an
    // excerpt, and a caller who does not know that will treat a truncated note as the whole note
    // — the one failure mode worse than the tokens this saves.
    // SLASH-IS-EXPLICIT adds one clause to agent_send (5600 -> 5800): agent_send is CORE, and an
    // agent that does not know about `slash` sends "/compact" as prose — it arrives behind the
    // "[from …]" attribution prefix, the backend never sees a command, and nothing says so. That
    // silent no-op is precisely the bug this clause prevents, so it has to be in the eager copy.
    // (The APP infers it from the operator's own leading "/" instead — a person typing a slash
    // means a command. An AGENT keeps the explicit flag: it forwards paths and quoted text, where
    // a leading "/" is not intent.)
    // TERMINAL-READBACK promotes terminal_read (5800 -> 6050). Verified live before this was
    // done: with the tool merely reachable through chimera_tools, the agent was asked what was in
    // the terminal open under it and replied "I cannot see your terminal window" — it never went
    // looking. A capability the agent cannot SEE reads as one that does not exist, which is the
    // same failure CONDUCTOR_TOOL_NAMES documents, and the operator asking about a terminal they
    // opened under this agent IS the feature. Its description is the tersest of any core tool for
    // exactly this reason.
    // TERMINAL-WRITE joins it (6050 -> 6400). The pair is one capability: an agent that can read
    // the operator's terminal but cannot type into it can only ever report, and a write tool the
    // agent cannot see fails the same way the read one just did.
    // Raised from 6_400 with the measure, not the surface: the number grew because it now counts
    // the schemas that were shipping all along, and the whole point of moving it is that a schema
    // doubling should trip this the way a description doubling always did.
    expect(eagerPayload.length).toBeLessThanOrEqual(17_500);
    for (const tool of coreTools) expect(tool.description.trim().length).toBeGreaterThan(0);

    const descriptionOf = (name: string) => coreTools.find((t) => t.name === name)!.description;
    // TOOL-TAGS: the routing vocabulary is no longer prose to keep in sync by hand — it is the tag
    // list chimera_tools actually searches. Asserted by DERIVING it, so a new subject cannot be
    // added to the catalog and forgotten in the copy that is supposed to advertise it. Only tags
    // worth navigating to are required: "core"/"extended" are tiers, and a subject with a single
    // tool is not a category anyone browses.
    // Only the subjects worth naming up front: four or more tools. A one- or two-tool subject is
    // not a category anyone browses, and requiring all 23 here would just make the copy longer than
    // the tools it advertises. The tail is covered a better way — chimera_tools hands back the full
    // tag vocabulary when a tag matches nothing, so a wrong guess is corrected rather than read as
    // "this subject has no tools" (asserted below).
    const navigable = mcpToolTags().filter((t) => t.count >= 4 && !["core", "extended", "conductor", "discovery"].includes(t.tag));
    for (const { tag } of navigable) {
      expect(descriptionOf("chimera_tools"), `chimera_tools must name the "${tag}" subject`).toContain(tag);
    }

    // The correction path for everything not named above.
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "chimera_tools")!;
    const miss = entry.resolve({ tag: "not-a-subject" }, { depth: 0 });
    expect(miss.kind).toBe("local");
    const value = (miss as { kind: "local"; value: { tools: unknown[]; tags?: unknown[] } }).value;
    expect(value.tools).toEqual([]);
    expect((value.tags ?? []).length).toBeGreaterThan(10);
    for (const term of ["instead of polling", "agent.settled", "gate.verdict", "once:true", "deliver", "resume"]) {
      expect(descriptionOf("subscribe")).toContain(term);
    }
  });

  it("createChimeraMcpServer registers EXACTLY the core tier", async () => {
    const server = await createChimeraMcpServer(async () => ({}), { depth: 0 });
    // McpServer doesn't expose a public "list my own registered tools" API outside a
    // transport round-trip in this SDK version, so reach into the internal registry the
    // same way registerTool populates it -- this is the one place a private field read is
    // justified: it's the only way to assert registration without spinning up a full
    // client/transport pair for a pure unit test.
    const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(new Set(registered)).toEqual(new Set(CORE_MCP_TOOL_NAMES));
  });

  it("AGENT-AUTONOMY: ctx.autonomy:\"full\" registers every core tool EXCEPT ask_human/ask_agent/ask_team", async () => {
    const server = await createChimeraMcpServer(async () => ({}), { depth: 0, autonomy: "full" });
    const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const expected = CORE_MCP_TOOL_NAMES.filter((n) => !["ask_human", "ask_agent", "ask_team"].includes(n));
    expect(new Set(registered)).toEqual(new Set(expected));
    expect(registered).toContain("answer_question");   // the reply-side tool stays — only the ask side is gone
  });

  it("AGENT-AUTONOMY: ctx.autonomy left unset (or \"ask\") is byte-identical to today's full core registration", async () => {
    const server = await createChimeraMcpServer(async () => ({}), { depth: 0, autonomy: "ask" });
    const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(new Set(registered)).toEqual(new Set(CORE_MCP_TOOL_NAMES));
  });

  it("AGENT-AUTONOMY: engine_help's catalog drops ask_human/ask_agent/ask_team and swaps askRule for a full-autonomy caller", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "engine_help")!;
    const full = entry.resolve({}, { depth: 0, autonomy: "full" }) as { kind: "local"; value: { tools: string[]; askRule: string } };
    expect(full.value.tools).not.toContain("ask_human");
    expect(full.value.tools).not.toContain("ask_agent");
    expect(full.value.tools).not.toContain("ask_team");
    expect(full.value.askRule).not.toContain("Call ask_human");
    expect(full.value.askRule.toLowerCase()).toContain("no human");

    const ask = entry.resolve({}, { depth: 0, autonomy: "ask" }) as { kind: "local"; value: { tools: string[]; askRule: string } };
    expect(ask.value.tools).toContain("ask_human");
    expect(ask.value.askRule).toContain("ask_human");
  });

  it("chimera_tools discovers exactly the extended set (tag- or query-filtered) and never core tools", () => {
    // A BARE call no longer enumerates: unfiltered, this returned all 117 tools with their schemas,
    // ~18,000 tokens — five times the entire eager tool surface, and re-read on every later turn of
    // whichever agent asked. It answers with the subject vocabulary instead (asserted below), and
    // the full enumeration stays reachable through the tag that means it.
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "chimera_tools")!;
    const all = entry.resolve({ tag: "extended" }, { depth: 0 }) as { kind: "local"; value: { tools: Array<{ name: string }> } };
    const names = all.value.tools.map((t) => t.name);
    expect(new Set(names)).toEqual(new Set(EXTENDED_MCP_TOOL_NAMES));

    const bare = entry.resolve({}, { depth: 0 }) as { kind: "local"; value: { tools?: unknown[]; tags?: unknown[] } };
    expect(bare.value.tools).toBeUndefined();
    expect((bare.value.tags ?? []).length).toBeGreaterThan(10);
    for (const coreName of CORE_MCP_TOOL_NAMES) expect(names).not.toContain(coreName);

    const filtered = entry.resolve({ query: "job_" }, { depth: 0 }) as { kind: "local"; value: { tools: Array<{ name: string }> } };
    expect(filtered.value.tools.map((t) => t.name).sort()).toEqual(
      ["job_create", "job_list", "job_status", "job_update", "job_delete", "job_run_now", "job_requeue"].sort(),
    );
  });

  it("chimera_call resolves a valid extended tool call to that tool's own RPC", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "chimera_call")!;
    const result = entry.resolve({ tool: "config_get", args: {} }, { depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "config.get", params: {} });
  });

  it("chimera_call rejects a core-tier tool name (reachable directly, not via the meta-pair)", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "chimera_call")!;
    const result = entry.resolve({ tool: "agent_spawn", args: { prompt: "x", cwd: "/tmp" } }, { depth: 0 });
    expect(result.kind).toBe("error");
  });

  it("chimera_call rejects an unknown tool name", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "chimera_call")!;
    const result = entry.resolve({ tool: "not_a_real_tool", args: {} }, { depth: 0 });
    expect(result.kind).toBe("error");
  });

  it("chimera_call validates args against the target tool's own schema before dispatching", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "chimera_call")!;
    // host_set_policy requires tool/profile/mode (mode is an enum) -- an invalid mode must
    // be rejected here, the same way the MCP SDK would reject a direct call's bad input.
    const result = entry.resolve({ tool: "host_set_policy", args: { tool: "git", profile: "*", mode: "bogus" } }, { depth: 0 });
    expect(result.kind).toBe("error");
  });

  // FEATURE-6: mcp_store_call threads ctx.agentId into its RPC params when present, and
  // stays byte-identical to before when absent (every existing caller/test).
  it("mcp_store_call omits agentId when ctx has none", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "mcp_store_call")!;
    const result = entry.resolve({ server: "s", tool: "t", args: { x: 1 } }, { depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "mcpstore.call", params: { server: "s", tool: "t", args: { x: 1 } } });
  });

  it("mcp_store_call threads ctx.agentId into its RPC params when present", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "mcp_store_call")!;
    const result = entry.resolve({ server: "s", tool: "t", args: { x: 1 } }, { agentId: "a1", depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "mcpstore.call", params: { server: "s", tool: "t", args: { x: 1 }, agentId: "a1" } });
  });
});

// AGENT-RESUME-TOOLS: agent_spawn's resolver whitelist historically DROPPED maxTurns/
// turnLimitPolicy/resume/resumeOnly (they exist on AgentSpecSchema but were never spread into
// the RPC spec). These pin the passthrough, and the new agent_resume tool's resolver shape.
describe("AGENT-RESUME-TOOLS", () => {
  const spawn = () => MCP_TOOL_TABLE.find((t) => t.name === "agent_spawn")!;
  const resume = () => MCP_TOOL_TABLE.find((t) => t.name === "agent_resume")!;

  it("agent_spawn forwards maxTurns/turnLimitPolicy/resume/resumeOnly into the spec", () => {
    const result = spawn().resolve(
      { prompt: "go", cwd: "/repo", maxTurns: 200, turnLimitPolicy: "soft", resume: "sess-123", resumeOnly: true },
      { depth: 0 },
    ) as { kind: "rpc"; method: string; params: { spec: Record<string, unknown> } };
    expect(result.method).toBe("agent.spawn");
    expect(result.params.spec).toMatchObject({
      prompt: "go", cwd: "/repo", maxTurns: 200, turnLimitPolicy: "soft", resume: "sess-123", resumeOnly: true,
    });
  });

  it("agent_spawn omits the four fields entirely when unset (byte-identical to before)", () => {
    const result = spawn().resolve({ prompt: "go", cwd: "/repo" }, { depth: 0 }) as {
      kind: "rpc"; params: { spec: Record<string, unknown> };
    };
    const spec = result.params.spec;
    expect("maxTurns" in spec).toBe(false);
    expect("turnLimitPolicy" in spec).toBe(false);
    expect("resume" in spec).toBe(false);
    expect("resumeOnly" in spec).toBe(false);
  });

  it("resumeOnly:false is forwarded (not confused with unset — it's a real boolean)", () => {
    const result = spawn().resolve({ prompt: "go", cwd: "/repo", resumeOnly: false }, { depth: 0 }) as {
      kind: "rpc"; params: { spec: Record<string, unknown> };
    };
    expect(result.params.spec).toMatchObject({ resumeOnly: false });
  });

  it("agent_resume maps to the agent.resume RPC, forwarding only the args given", () => {
    const result = resume().resolve(
      { agentId: "a1", prompt: "keep going", maxTurns: 100, turnLimitPolicy: "fail", deliverTo: "conductor" },
      { depth: 0 },
    );
    expect(result).toEqual({
      kind: "rpc",
      method: "agent.resume",
      params: { agentId: "a1", prompt: "keep going", maxTurns: 100, turnLimitPolicy: "fail", deliverTo: "conductor" },
    });
  });

  it("agent_resume omits optional overrides when unset (server applies its own defaults)", () => {
    const result = resume().resolve({ agentId: "a1", prompt: "keep going" }, { depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "agent.resume", params: { agentId: "a1", prompt: "keep going" } });
  });

  it("agent_resume stays discoverable in the extended tier", () => {
    expect(CORE_MCP_TOOL_NAMES).not.toContain("agent_resume");
    expect(EXTENDED_MCP_TOOL_NAMES).toContain("agent_resume");
  });
});

describe("W2-4 PER-AGENT-TOOL-ALLOWLIST", () => {
  const spawn = () => MCP_TOOL_TABLE.find((t) => t.name === "agent_spawn")!;

  it("agent_spawn forwards mcpToolAllowlist into the AgentSpec, including an empty map", () => {
    for (const mcpToolAllowlist of [{ chimera: ["my_team", "memory_search"] }, {}]) {
      const result = spawn().resolve(
        { prompt: "go", cwd: "/repo", mcpToolAllowlist },
        { depth: 0 },
      ) as { kind: "rpc"; params: { spec: Record<string, unknown> } };
      expect(result.params.spec["mcpToolAllowlist"]).toEqual(mcpToolAllowlist);
    }
  });

  it("agent_spawn omits mcpToolAllowlist when unset (existing RPC bytes stay unchanged)", () => {
    const result = spawn().resolve({ prompt: "go", cwd: "/repo" }, { depth: 0 }) as {
      kind: "rpc"; params: { spec: Record<string, unknown> };
    };
    expect("mcpToolAllowlist" in result.params.spec).toBe(false);
  });
});

describe("LEAN-AGENT-MCPS: agent_spawn strictMcpConfig", () => {
  const spawn = () => MCP_TOOL_TABLE.find((t) => t.name === "agent_spawn")!;

  it("agent_spawn forwards strictMcpConfig (true and false) into the AgentSpec", () => {
    for (const strictMcpConfig of [true, false]) {
      const result = spawn().resolve(
        { prompt: "go", cwd: "/repo", strictMcpConfig },
        { depth: 0 },
      ) as { kind: "rpc"; params: { spec: Record<string, unknown> } };
      expect(result.params.spec["strictMcpConfig"]).toBe(strictMcpConfig);
    }
  });

  it("agent_spawn omits strictMcpConfig when unset (existing RPC bytes stay unchanged)", () => {
    const result = spawn().resolve({ prompt: "go", cwd: "/repo" }, { depth: 0 }) as {
      kind: "rpc"; params: { spec: Record<string, unknown> };
    };
    expect("strictMcpConfig" in result.params.spec).toBe(false);
  });
});

// MEM-3: memory tools grow title/folder (add/edit) + folder/mode (search); new memory_get is a
// extended-tier 1-hop link/backlink read. These pin the resolver shapes and the byte-identical
// omit-when-unset behavior that keeps every existing memory_add/search call unchanged.
describe("MEM-3: memory tool resolvers", () => {
  const tool = (name: string) => MCP_TOOL_TABLE.find((t) => t.name === name)!;

  it("memory_add forwards title/folder when given (author from ctx)", () => {
    const result = tool("memory_add").resolve(
      { text: "note body", title: "GATE-WAIT-DEATH", folder: "ops/failure-modes", kind: "decision" },
      { agentId: "a1", treeId: "t1", depth: 0 },
    );
    expect(result).toEqual({
      kind: "rpc", method: "memory.add",
      params: { author: "a1", text: "note body", treeId: "t1", title: "GATE-WAIT-DEATH", folder: "ops/failure-modes", kind: "decision" },
    });
  });

  it("memory_add omits title/folder entirely when unset (byte-identical to pre-MEM-3)", () => {
    const result = tool("memory_add").resolve({ text: "body" }, { agentId: "a1", depth: 0 }) as {
      kind: "rpc"; params: Record<string, unknown>;
    };
    expect("title" in result.params).toBe(false);
    expect("folder" in result.params).toBe(false);
    expect(result.params).toEqual({ author: "a1", text: "body" });
  });

  // F35.1 case 21: supersedes forwards like any other optional field — present when given,
  // absent (not `supersedes: undefined`) when not, matching the omit-when-unset test above.
  it("F35.1: memory_add forwards supersedes when given", () => {
    const result = tool("memory_add").resolve(
      { text: "prod runs on eu-central-1", supersedes: "m1" },
      { agentId: "a1", depth: 0 },
    );
    expect(result).toEqual({
      kind: "rpc", method: "memory.add",
      params: { author: "a1", text: "prod runs on eu-central-1", supersedes: "m1" },
    });
  });

  it("F35.1: memory_add omits supersedes entirely when unset", () => {
    const result = tool("memory_add").resolve({ text: "body" }, { agentId: "a1", depth: 0 }) as {
      kind: "rpc"; params: Record<string, unknown>;
    };
    expect("supersedes" in result.params).toBe(false);
  });

  it("MEMORY-TEAM-TAGS: memory_add auto-tags with team:<name> from ctx.team", () => {
    const result = tool("memory_add").resolve(
      { text: "body" },
      { agentId: "a1", depth: 0, team: "chimera-dev" },
    );
    expect(result).toEqual({
      kind: "rpc", method: "memory.add",
      params: { author: "a1", text: "body", tags: ["team:chimera-dev"] },
    });
  });

  it("MEMORY-TEAM-TAGS: does not duplicate an already-present team tag", () => {
    const result = tool("memory_add").resolve(
      { text: "body", tags: ["team:chimera-dev", "other"] },
      { agentId: "a1", depth: 0, team: "chimera-dev" },
    );
    expect(result).toEqual({
      kind: "rpc", method: "memory.add",
      params: { author: "a1", text: "body", tags: ["team:chimera-dev", "other"] },
    });
  });

  it("MEMORY-TEAM-TAGS: no team ctx leaves tags untouched", () => {
    const result = tool("memory_add").resolve({ text: "body" }, { agentId: "a1", depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "memory.add", params: { author: "a1", text: "body" } });
  });

  it("memory_edit forwards explicit null to CLEAR title/folder", () => {
    const result = tool("memory_edit").resolve(
      { id: "m1", title: null, folder: null },
      { agentId: "a2", depth: 0 },
    );
    expect(result).toEqual({ kind: "rpc", method: "memory.edit", params: { id: "m1", title: null, folder: null, author: "a2" } });
  });

  // F36 case 27: pinning is reachable from the MCP surface, and only through EDIT — a note is
  // pinned once it has proved durable, which is never true at birth.
  it("memory_edit forwards pinned", () => {
    const result = tool("memory_edit").resolve({ id: "x", pinned: true }, { agentId: "a1", depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "memory.edit", params: { id: "x", pinned: true, author: "a1" } });
  });

  it("memory_edit omits pinned when unset", () => {
    const result = tool("memory_edit").resolve({ id: "x", text: "t" }, { agentId: "a1", depth: 0 });
    // Absent, not `pinned: false` — an edit that says nothing about pinning must not silently unpin.
    expect(result).toEqual({ kind: "rpc", method: "memory.edit", params: { id: "x", text: "t", author: "a1" } });
  });

  it("memory_search forwards folder + mode when given", () => {
    const result = tool("memory_search").resolve({ query: "retry", folder: "ops", mode: "semantic" }, { depth: 0 });
    // TOKEN-OPT-SEARCH-EXCERPT: the agent-facing tool always asks for excerpts — a searcher is
    // scanning, and memory_get reads the one it picks in full.
    // F34.FIX: no explicit scope was given, so a postDispatch hook is attached (see below) —
    // asserted here only by shape, its empty-result behavior is covered separately.
    expect(result).toMatchObject({ kind: "rpc", method: "memory.search", params: { query: "retry", folder: "ops", mode: "semantic", excerpt: true } });
    expect((result as { postDispatch?: unknown }).postDispatch).toBeTypeOf("function");
  });

  describe("F34.FIX memory_search postDispatch — empty-scope hint", () => {
    it("non-empty result passes through byte-identical (no postDispatch mutation)", async () => {
      const result = tool("memory_search").resolve({ query: "x" }, { agentId: "a1", depth: 0 }) as {
        postDispatch: (r: unknown, d: (m: string, p: unknown) => Promise<unknown>) => Promise<unknown>;
      };
      const hits = [{ record: { id: "1", scope: "alpha", text: "t" } }];
      const dispatch = vi.fn();
      const out = await result.postDispatch(hits, dispatch);
      expect(out).toBe(hits);
      expect(dispatch).not.toHaveBeenCalled();
    });

    it("empty result + N=0 elsewhere ⇒ 'nothing anywhere' wording", async () => {
      const result = tool("memory_search").resolve({ query: "x" }, { agentId: "a1", depth: 0 }) as {
        postDispatch: (r: unknown, d: (m: string, p: unknown) => Promise<unknown>) => Promise<unknown>;
      };
      const dispatch = vi.fn().mockResolvedValue([]);
      const out = await result.postDispatch([], dispatch) as { hits: unknown[]; hint: string };
      expect(out.hits).toEqual([]);
      expect(out.hint).toMatch(/nothing.*anywhere|anywhere else/i);
      expect(dispatch).toHaveBeenCalledWith("memory.search", expect.objectContaining({ scope: "*" }));
    });

    it('empty result + N>0 elsewhere ⇒ count + scope:"*" retry instruction, distinct from N=0 wording', async () => {
      const result = tool("memory_search").resolve({ query: "x" }, { agentId: "a1", depth: 0 }) as {
        postDispatch: (r: unknown, d: (m: string, p: unknown) => Promise<unknown>) => Promise<unknown>;
      };
      const dispatch = vi.fn().mockResolvedValue([{ record: { id: "1" } }, { record: { id: "2" } }]);
      const out = await result.postDispatch([], dispatch) as { hits: unknown[]; hint: string };
      expect(out.hits).toEqual([]);
      expect(out.hint).toContain("2");
      expect(out.hint).toMatch(/scope:"\*"/);
      expect(out.hint).not.toMatch(/nothing.*anywhere/i);
    });

    it("explicit scope skips the postDispatch hook entirely", () => {
      const result = tool("memory_search").resolve({ query: "x", scope: "beta" }, { agentId: "a1", depth: 0 });
      expect((result as { postDispatch?: unknown }).postDispatch).toBeUndefined();
    });

    // F34-SCOPE-FILTER: an explicit scopeMode is the same kind of deliberate choice as an
    // explicit scope ("I know what I'm asking for") — the elsewhere-hint probe must stay silent.
    it("explicit scopeMode skips the postDispatch hook entirely, even without a scope", () => {
      const result = tool("memory_search").resolve({ query: "x", scopeMode: "global" }, { agentId: "a1", depth: 0 });
      expect((result as { postDispatch?: unknown }).postDispatch).toBeUndefined();
    });
  });

  // F34-SCOPE-FILTER: the exact-membership filter, orthogonal to the widening `scope` param above.
  it("memory_search forwards scopeMode when given", () => {
    const result = tool("memory_search").resolve({ query: "x", scopeMode: "project" }, { agentId: "a1", depth: 0 });
    expect(result).toEqual({
      kind: "rpc", method: "memory.search",
      params: { query: "x", scopeMode: "project", agentId: "a1", excerpt: true },
    });
  });

  it("memory_search forwards scope + scopeMode together", () => {
    const result = tool("memory_search").resolve({ query: "x", scope: "alpha", scopeMode: "project" }, { agentId: "a1", depth: 0 });
    expect(result).toEqual({
      kind: "rpc", method: "memory.search",
      params: { query: "x", scope: "alpha", scopeMode: "project", agentId: "a1", excerpt: true },
    });
  });

  it("memory_search omits scopeMode entirely when unset (byte-identical to pre-F34-SCOPE-FILTER)", () => {
    const result = tool("memory_search").resolve({ query: "x" }, { agentId: "a1", depth: 0 }) as {
      params: Record<string, unknown>;
    };
    expect("scopeMode" in result.params).toBe(false);
  });

  // F34: the tool stamps the CALLER's id so the engine can resolve a default scope server-side.
  // The case above is the omit-when-unset regression gate — a ctx without an agentId (the app,
  // the TUI, a test) must still produce no `agentId` and no `scope` key at all.
  it("memory_search forwards an explicit scope and stamps agentId from ctx", () => {
    const result = tool("memory_search").resolve({ query: "x", scope: "*" }, { agentId: "a1", depth: 0 });
    expect(result).toEqual({
      kind: "rpc", method: "memory.search",
      params: { query: "x", scope: "*", agentId: "a1", excerpt: true },
    });
  });

  it("memory_get maps to the memory.get RPC by id and stays discoverable in the extended tier", () => {
    expect(tool("memory_get").resolve({ id: "m9" }, { depth: 0 })).toEqual({
      kind: "rpc", method: "memory.get", params: { id: "m9" },
    });
    expect(CORE_MCP_TOOL_NAMES).not.toContain("memory_get");
    expect(EXTENDED_MCP_TOOL_NAMES).toContain("memory_get");
  });
});

type RegisteredTools = Record<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }>;
function registeredTools(server: unknown): RegisteredTools {
  return (server as { _registeredTools: RegisteredTools })._registeredTools;
}

// MCP-STORE-DIRECT-TOGGLE: a `direct:true` store server's live tools are additionally
// registered as NATIVE, server-prefixed tools on the SAME chimera MCP server, routed
// through dispatch("mcpstore.call", ...) -- the identical shared daemon connection
// mcp_store_call already uses. Presentation-only: no separate connection/process.
describe("MCP-STORE-DIRECT-TOGGLE: native direct-store tools", () => {
  it("registers a server-prefixed native tool for a direct:true server, scoped to ONLY direct servers, routed through mcpstore.call", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const dispatch = async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "mcpstore.list") return [{ name: "chrome-devtools", direct: true }, { name: "telegram", direct: false }];
      if (method === "mcpstore.tools") {
        return {
          servers: [{
            server: "chrome-devtools", connected: true,
            tools: [{ name: "navigate_page", description: "Navigate to a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }],
          }],
        };
      }
      return { text: "ok" };
    };
    const server = await createChimeraMcpServer(dispatch, { depth: 0 });
    const registered = registeredTools(server);

    expect(Object.keys(registered)).toContain("chrome-devtools__navigate_page");
    expect(Object.keys(registered).some((k) => k.startsWith("telegram__"))).toBe(false); // not direct -> no native tool

    // the scan itself was narrowed to only the direct server(s) -- telegram is never connected.
    expect(calls.find((c) => c.method === "mcpstore.tools")?.params).toEqual({ servers: ["chrome-devtools"] });

    // invoking the native tool forwards to mcpstore.call through the SAME dispatch (shared connection).
    calls.length = 0;
    await registered["chrome-devtools__navigate_page"]!.handler({ url: "https://example.com" });
    expect(calls).toEqual([{ method: "mcpstore.call", params: { server: "chrome-devtools", tool: "navigate_page", args: { url: "https://example.com" } } }]);
  });

  // FEATURE-6: ctx.agentId, when given, is threaded into the mcpstore.call dispatch so
  // core's CapabilityBroker can attribute the audit event to a real principal.
  it("threads ctx.agentId into the mcpstore.call dispatch when present", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const dispatch = async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "mcpstore.list") return [{ name: "chrome-devtools", direct: true }];
      if (method === "mcpstore.tools") {
        return {
          servers: [{
            server: "chrome-devtools", connected: true,
            tools: [{ name: "navigate_page", description: "Navigate to a URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }],
          }],
        };
      }
      return { text: "ok" };
    };
    const server = await createChimeraMcpServer(dispatch, { agentId: "a1", depth: 0 });
    const registered = registeredTools(server);

    calls.length = 0;
    await registered["chrome-devtools__navigate_page"]!.handler({ url: "https://example.com" });
    expect(calls).toEqual([{ method: "mcpstore.call", params: { server: "chrome-devtools", tool: "navigate_page", args: { url: "https://example.com" }, agentId: "a1" } }]);
  });

  // MCPSTORE-LIFECYCLE-UI: a disabled server must be fully inert to agents, even when
  // direct:true -- disable is not just "hide the native-tool shortcut", it's "never surface
  // this server's tools at all".
  it("direct:true but enabled:false yields no native store tools", async () => {
    const server = await createChimeraMcpServer(async (method) => (method === "mcpstore.list" ? [{ name: "chrome-devtools", direct: true, enabled: false }] : {}), { depth: 0 });
    expect(new Set(Object.keys(registeredTools(server)))).toEqual(new Set(CORE_MCP_TOOL_NAMES));
  });

  it("direct:false (the default) yields no native store tools -- only the core chimera set, proxy-only", async () => {
    const server = await createChimeraMcpServer(async (method) => (method === "mcpstore.list" ? [{ name: "telegram", direct: false }] : {}), { depth: 0 });
    expect(new Set(Object.keys(registeredTools(server)))).toEqual(new Set(CORE_MCP_TOOL_NAMES));
  });

  it("no store servers installed at all -> no extra RPC beyond the cheap mcpstore.list check, no native tools", async () => {
    const calls: string[] = [];
    const server = await createChimeraMcpServer(async (method) => { calls.push(method); return method === "mcpstore.list" ? [] : {}; }, { depth: 0 });
    expect(new Set(Object.keys(registeredTools(server)))).toEqual(new Set(CORE_MCP_TOOL_NAMES));
    expect(calls).toEqual(["mcpstore.list"]);   // never calls mcpstore.tools when there's nothing direct
  });

  it("degrades gracefully when the direct-server lookup fails -- core tools (incl. the mcp_store_call proxy) are unaffected", async () => {
    const dispatch = async (method: string): Promise<unknown> => {
      if (method === "mcpstore.list") return [{ name: "chrome-devtools", direct: true }];
      if (method === "mcpstore.tools") throw new Error("daemon unreachable");
      return {};
    };
    const server = await createChimeraMcpServer(dispatch, { depth: 0 });
    const registered = registeredTools(server);
    expect(new Set(Object.keys(registered))).toEqual(new Set(CORE_MCP_TOOL_NAMES));
    expect(Object.keys(registered)).toContain("mcp_store_call");
  });

  it("an unreachable direct server (connected:false) contributes no native tools", async () => {
    const dispatch = async (method: string): Promise<unknown> => {
      if (method === "mcpstore.list") return [{ name: "chrome-devtools", direct: true }];
      if (method === "mcpstore.tools") return { servers: [{ server: "chrome-devtools", connected: false, tools: [] }] };
      return {};
    };
    const server = await createChimeraMcpServer(dispatch, { depth: 0 });
    expect(new Set(Object.keys(registeredTools(server)))).toEqual(new Set(CORE_MCP_TOOL_NAMES));
  });
});

describe("rename_self (Ad-hoc sessions design §5)", () => {
  it("stamps the caller's own agentId, never a param", () => {
    const tool = MCP_TOOL_TABLE.find((t) => t.name === "rename_self")!;
    const result = tool.resolve({ name: "gitops PR 246 — helm values drift" }, { agentId: "caller-1", depth: 0 });
    // OPERATOR-RENAME: `self: true` is what keeps THIS path one-shot. The operator surfaces call
    // the same RPC without it and may rename any agent, any number of times — so the flag is not
    // decoration, it is the whole distinction.
    expect(result).toEqual({
      kind: "rpc", method: "agent.rename",
      params: { agentId: "caller-1", displayLabel: "gitops PR 246 — helm values drift", self: true },
    });
  });
});

// Ad-hoc sessions design §4: agent_spawn's `role` param rides as a TOP-LEVEL RPC param
// (sibling to depth/engine), never inside `spec` — resolved server-side against the session
// role registry, not something the MCP layer merges itself.
describe("agent_spawn role param", () => {
  const spawn = () => MCP_TOOL_TABLE.find((t) => t.name === "agent_spawn")!;

  it("forwards role as a top-level RPC param, not inside spec", () => {
    const result = spawn().resolve({ prompt: "go", cwd: "/repo", role: "review" }, { depth: 0 }) as {
      kind: "rpc"; params: Record<string, unknown>;
    };
    expect(result.params["role"]).toBe("review");
    expect("role" in (result.params["spec"] as Record<string, unknown>)).toBe(false);
  });

  it("omits role entirely when unset (byte-identical to before)", () => {
    const result = spawn().resolve({ prompt: "go", cwd: "/repo" }, { depth: 0 }) as {
      kind: "rpc"; params: Record<string, unknown>;
    };
    expect("role" in result.params).toBe(false);
  });
});

// ROLE-TOOLS-FOR-AGENTS: role_create/role_list/role_update promoted onto the agent-facing MCP
// surface (mcp-parity.test.ts's INTENTIONALLY_EXCLUDED_RPCS no longer names them) so an agent
// building a recurring system defines a role ONCE in the global library and binds it wherever
// needed, instead of reaching for team_create as the only door into "define a role". role.delete
// stays operator-only — see that test's updated comment for the asymmetry.
describe("ROLE-TOOLS-FOR-AGENTS: role_create/role_list/role_update", () => {
  const tool = (name: string) => MCP_TOOL_TABLE.find((t) => t.name === name)!;

  it("role_create maps to the role.create RPC, forwarding the caller's spec unmodified", () => {
    const spec = { name: "finder", instructions: "grep the codebase for X" };
    expect(tool("role_create").resolve({ spec }, { depth: 0 })).toEqual({
      kind: "rpc", method: "role.create", params: { spec },
    });
  });

  it("role_create's description documents the dotted-name rejection so an agent doesn't hand-type a qualified name", () => {
    expect(tool("role_create").description).toMatch(/dotted/i);
    expect(tool("role_create").description).toMatch(/team-role migration|team-qualified/i);
  });

  it("role_list maps to the role.list RPC with no params", () => {
    expect(tool("role_list").resolve({}, { depth: 0 })).toEqual({ kind: "rpc", method: "role.list", params: {} });
  });

  it("role_update maps to the role.update RPC, forwarding name + patch", () => {
    const patch = { instructions: "grep the codebase for X, faster" };
    expect(tool("role_update").resolve({ name: "finder", patch }, { depth: 0 })).toEqual({
      kind: "rpc", method: "role.update", params: { name: "finder", patch },
    });
  });

  it("role_create/role_list/role_update are extended tier — setup-time tools, not eagerly billed on every spawn", () => {
    for (const name of ["role_create", "role_list", "role_update"]) expect(tool(name).tier).toBe("extended");
  });

  it("role.delete was NOT promoted — stays reachable only as an excluded/operator RPC, no role_delete tool exists", () => {
    expect(MCP_TOOL_TABLE.some((t) => t.name === "role_delete")).toBe(false);
  });

  it("full flow: define a role globally once, then bind it — to a team, and to that team's job target — without ever inlining an AgentSpec into team_create", () => {
    const roleSpec = { name: "finder", instructions: "grep the codebase for X" };
    expect(tool("role_create").resolve({ spec: roleSpec }, { depth: 0 })).toEqual({
      kind: "rpc", method: "role.create", params: { spec: roleSpec },
    });

    expect(tool("role_list").resolve({}, { depth: 0 })).toEqual({ kind: "rpc", method: "role.list", params: {} });

    // team_create's roles map REFERENCES the library role by name + overrides — it never
    // re-authors the template inline.
    const teamSpec = { name: "finders", roles: { primary: { role: "finder", overrides: {} } } };
    const teamResult = tool("team_create").resolve({ spec: teamSpec }, { agentId: "conductor-1", depth: 0 }) as {
      kind: "rpc"; params: { spec: Record<string, unknown> };
    };
    expect(teamResult.params.spec["roles"]).toEqual({ primary: { role: "finder", overrides: {} } });

    // job_create's team target inherits that team's role bindings — no separate role wiring needed.
    const jobSpec = { name: "finder-job", schedule: { cron: "0 * * * *" }, target: { team: "finders" }, prompt: "run the sweep" };
    expect(tool("job_create").resolve({ spec: jobSpec }, { depth: 0 })).toEqual({
      kind: "rpc", method: "job.create", params: { spec: jobSpec },
    });
  });
});

// TOOL-SURFACE-MEASURE: the estimate this feeds (claude.ts's spawn-time "toolSurface" status
// event) exists to make a previously-invisible cost visible — these tests pin that the number
// stays STABLE (same inputs -> same output, no clock/random) and SMALL (a plain core-tier grant
// with no ambient MCP catalog reports a modest figure, not something that would mask a real
// bloat regression).
describe("estimateChimeraMcpToolSurface", () => {
  it("is deterministic for the same autonomy input", () => {
    expect(estimateChimeraMcpToolSurface({ autonomy: "ask" })).toEqual(estimateChimeraMcpToolSurface({ autonomy: "ask" }));
    expect(estimateChimeraMcpToolSurface(undefined)).toEqual(estimateChimeraMcpToolSurface({ autonomy: "ask" }));
  });

  it("counts exactly the core-tier tools for autonomy:ask (the default)", () => {
    const est = estimateChimeraMcpToolSurface({ autonomy: "ask" });
    expect(est.toolCount).toBe(CORE_MCP_TOOL_NAMES.length);
    expect(est.approxChars).toBeGreaterThan(0);
    expect(est.approxTokens).toBe(Math.round(est.approxChars / 4));
  });

  it("autonomy:full drops the three ask_* tools and reports a smaller surface", () => {
    const ask = estimateChimeraMcpToolSurface({ autonomy: "ask" });
    const full = estimateChimeraMcpToolSurface({ autonomy: "full" });
    expect(full.toolCount).toBe(ask.toolCount - 3);
    expect(full.approxChars).toBeLessThan(ask.approxChars);
  });

  it("a plain core-tier grant (no ambient MCP catalog) reports a small number — regression guard", () => {
    // TOKEN-OPT-P2's own doc comment estimates the core tier at "~2K tok" — generous headroom
    // above that so a small, deliberate tool addition doesn't flake this test, while still
    // catching the kind of order-of-magnitude bloat the hermes-agent audit measured (46,558
    // cache-write tokens for an ambient catalog this function never even looks at).
    expect(estimateChimeraMcpToolSurface({ autonomy: "ask" }).approxTokens).toBeLessThan(10_000);
  });

  // TOOL-SURFACE-GRANT: grantedChimeraToolNames is now the ONE granting decision, shared by
  // createChimeraMcpServer (registration) and this estimator (measurement) — these cases pin
  // that they can never silently diverge again, and that the previously-invisible conductor
  // surface is now counted.
  it("grantedChimeraToolNames matches the estimator's toolCount for the same grant", () => {
    const grant = { autonomy: "ask" as const, conductor: true };
    expect(grantedChimeraToolNames(grant).length).toBe(estimateChimeraMcpToolSurface(grant).toolCount);
  });

  it("conductor:true grants strictly more tools than a plain core grant", () => {
    const core = estimateChimeraMcpToolSurface({ autonomy: "ask" });
    const conductor = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true });
    expect(conductor.toolCount).toBeGreaterThan(core.toolCount);
    expect(conductor.approxTokens).toBeGreaterThan(core.approxTokens);
  });

  it("a conductor grant's toolCount equals core tools plus every conductor-tagged tool", () => {
    const core = estimateChimeraMcpToolSurface({ autonomy: "ask" });
    const conductor = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true });
    const coreNames = new Set(grantedChimeraToolNames({ autonomy: "ask" }));
    const conductorOnlyCount = MCP_TOOL_TABLE.filter((t) => t.tags.includes("conductor") && !coreNames.has(t.name)).length;
    expect(conductor.toolCount).toBe(core.toolCount + conductorOnlyCount);
  });

  it("bySource rows sum exactly to the top-level totals, with no tool double-counted", () => {
    const est = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true });
    const sumCount = est.bySource.reduce((n, s) => n + s.toolCount, 0);
    const sumChars = est.bySource.reduce((n, s) => n + s.approxChars, 0);
    expect(sumCount).toBe(est.toolCount);
    expect(sumChars).toBe(est.approxChars);
  });

  // QA of F41: approxTokens was the one column that did NOT sum -- each row rounded chars/4
  // independently, so a multi-row grant published rows that added up to one token less than the
  // total beside them. The operator reads both numbers in the same detail panel, so every
  // reachable grant shape is checked, not just the conductor one.
  it("bySource approxTokens sums exactly to the top-level approxTokens for every tag/conductor grant", () => {
    const tags = [...new Set(MCP_TOOL_TABLE.flatMap((t) => t.tags))].sort();
    const mismatches: string[] = [];
    for (const tag of tags) {
      for (const conductor of [false, true]) {
        const est = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor, toolTags: [tag] });
        const sum = est.bySource.reduce((n, s) => n + s.approxTokens, 0);
        if (sum !== est.approxTokens) mismatches.push(`tag=${tag} conductor=${conductor} rows=${sum} total=${est.approxTokens}`);
        expect(est.approxTokens).toBe(Math.round(est.approxChars / 4));
      }
    }
    expect(mismatches).toEqual([]);
  });

  // QA of F41: the memo hands the SAME object to every caller (pinned by the test below), so an
  // unfrozen estimate let any one consumer poison claude.ts's real per-spawn cost event.
  it("hands out a deeply frozen estimate so one consumer cannot poison the shared memo", () => {
    const est = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true });
    expect(Object.isFrozen(est)).toBe(true);
    expect(Object.isFrozen(est.bySource)).toBe(true);
    expect(est.bySource.every((row) => Object.isFrozen(row))).toBe(true);
    expect(() => { (est as { approxTokens: number }).approxTokens = -1; }).toThrow();
    expect(estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true }).approxTokens).toBeGreaterThan(0);
  });

  // QA of F41: attribution bills a multi-tag tool to the FIRST requested tag, so tag ORDER is a
  // real input -- the memo key must not collapse two orders onto whichever ran first.
  it("respects toolTags order rather than serving a cached estimate keyed on the sorted set", () => {
    const first = estimateChimeraMcpToolSurface({ autonomy: "ask", toolTags: ["team", "queue"] });
    const second = estimateChimeraMcpToolSurface({ autonomy: "ask", toolTags: ["queue", "team"] });
    expect(first.bySource.map((s) => s.source)).toEqual(["chimera-core", "chimera-tag:team", "chimera-tag:queue"]);
    expect(second.bySource.map((s) => s.source)).toEqual(["chimera-core", "chimera-tag:queue", "chimera-tag:team"]);
    expect(second.approxChars).toBe(first.approxChars);
  });

  it("bySource has a chimera-core row and a chimera-conductor row when conductor:true", () => {
    const est = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true });
    const sources = est.bySource.map((s) => s.source);
    expect(sources).toContain("chimera-core");
    expect(sources).toContain("chimera-conductor");
  });

  it("bySource has no chimera-conductor row when conductor is not true", () => {
    const est = estimateChimeraMcpToolSurface({ autonomy: "ask" });
    expect(est.bySource.map((s) => s.source)).not.toContain("chimera-conductor");
  });

  it("a toolTags entry contributes its own chimera-tag:<tag> row", () => {
    const someTag = MCP_TOOL_TABLE.find((t) => t.tier === "extended" && !t.tags.includes("conductor"))?.tags[0];
    expect(someTag).toBeTruthy();
    const est = estimateChimeraMcpToolSurface({ autonomy: "ask", toolTags: [someTag as string] });
    expect(est.bySource.map((s) => s.source)).toContain(`chimera-tag:${someTag}`);
  });

  it("is memoized: repeated calls with an equivalent grant return the same object reference", () => {
    const a = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true });
    const b = estimateChimeraMcpToolSurface({ autonomy: "ask", conductor: true });
    expect(a).toBe(b);
  });
});

// F15: task_explain is a diagnostic reached on demand (chimera_tools/chimera_call), not part of
// the eager core surface every agent pays for at spawn.
describe("F15: task_explain tool-table entry", () => {
  it("is in the table, extended tier, and resolves to queue.explainTask", () => {
    const entry = MCP_TOOL_TABLE.find((t) => t.name === "task_explain");
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe("extended");
    expect(entry!.resolve({ taskId: "t1" }, {} as never)).toEqual({ kind: "rpc", method: "queue.explainTask", params: { taskId: "t1" } });
  });

  it("is NOT in CORE_MCP_TOOL_NAMES", () => {
    expect(CORE_MCP_TOOL_NAMES).not.toContain("task_explain");
    expect(EXTENDED_MCP_TOOL_NAMES).toContain("task_explain");
  });
});

// F22.2: worktree_lease_handoff/worktree_lease_release must always inject the caller's REAL
// agentId from ctx, never trust a caller-supplied one — that's what makes the engine's
// operator-or-holder-only refusal (engine-contract-worktree.test.ts) unforgeable via MCP.
describe("F22.2: worktree_lease_list/worktree_lease_handoff/worktree_lease_release tool-table entries", () => {
  const list = () => MCP_TOOL_TABLE.find((t) => t.name === "worktree_lease_list")!;
  const handoff = () => MCP_TOOL_TABLE.find((t) => t.name === "worktree_lease_handoff")!;
  const release = () => MCP_TOOL_TABLE.find((t) => t.name === "worktree_lease_release")!;

  it("all three are in the table, extended tier, not core", () => {
    expect(list()).toBeDefined();
    expect(handoff()).toBeDefined();
    expect(release()).toBeDefined();
    expect(list().tier).toBe("extended");
    expect(handoff().tier).toBe("extended");
    expect(release().tier).toBe("extended");
    expect(CORE_MCP_TOOL_NAMES).not.toContain("worktree_lease_list");
    expect(CORE_MCP_TOOL_NAMES).not.toContain("worktree_lease_handoff");
    expect(CORE_MCP_TOOL_NAMES).not.toContain("worktree_lease_release");
    expect(EXTENDED_MCP_TOOL_NAMES).toContain("worktree_lease_list");
    expect(EXTENDED_MCP_TOOL_NAMES).toContain("worktree_lease_handoff");
    expect(EXTENDED_MCP_TOOL_NAMES).toContain("worktree_lease_release");
  });

  // QA of F22: the tool used to send no params at all, so the engine answered with EVERY tenant's
  // lease — holder agentIds, labels and absolute worktree dirs — to any agent that asked.
  it("worktree_lease_list forces ctx.agentId as callerAgentId so the engine can scope the answer", () => {
    const result = list().resolve({}, { agentId: "real-caller", depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "worktree.leaseList", params: { callerAgentId: "real-caller" } });
  });

  it("worktree_lease_handoff resolves to worktree.leaseHandoff with ctx.agentId as callerAgentId, ignoring any caller-supplied one", () => {
    const result = handoff().resolve(
      { workdirKey: "k1", toAgentId: "other", callerAgentId: "spoofed" },
      { agentId: "real-caller", depth: 0 },
    );
    expect(result).toEqual({
      kind: "rpc",
      method: "worktree.leaseHandoff",
      params: { workdirKey: "k1", toAgentId: "other", callerAgentId: "real-caller" },
    });
  });

  it("worktree_lease_release resolves to worktree.leaseRelease with ctx.agentId as callerAgentId and force defaulted to false", () => {
    const result = release().resolve({ workdirKey: "k1" }, { agentId: "real-caller", depth: 0 });
    expect(result).toEqual({
      kind: "rpc",
      method: "worktree.leaseRelease",
      params: { workdirKey: "k1", force: false, callerAgentId: "real-caller" },
    });
  });

  it("worktree_lease_release forwards force:true when requested", () => {
    const result = release().resolve({ workdirKey: "k1", force: true }, { agentId: "real-caller", depth: 0 });
    expect(result).toEqual({
      kind: "rpc",
      method: "worktree.leaseRelease",
      params: { workdirKey: "k1", force: true, callerAgentId: "real-caller" },
    });
  });
});

// F49.QA-FIX2 (finding #4): daemon_status used to be a bare `rpc("daemon.status", {})`
// passthrough, so every agent — not just the operator UIs — saw the mcpListener block's bind
// port and every OTHER tenant's grant roster. Mirrors F22's worktree_lease_list fix exactly.
describe("F49.QA-FIX2: daemon_status tool-table entry forces ctx.agentId as callerAgentId", () => {
  const daemonStatus = () => MCP_TOOL_TABLE.find((t) => t.name === "daemon_status")!;

  it("daemon_status forces ctx.agentId as callerAgentId so the engine can scope mcpListener.grants", () => {
    const result = daemonStatus().resolve({}, { agentId: "real-caller", depth: 0 });
    expect(result).toEqual({ kind: "rpc", method: "daemon.status", params: { callerAgentId: "real-caller" } });
  });
});

// F46 §3.4 item 3: the durable fix for the three-place duplication the catalog flagged. The
// subscribe tool's topic enum and filter shape are literal mirrors of TopicSchema/
// TopicFilterSchema (re-declared, not imported, to dodge the mcp-tools.js <-> index.js import
// cycle) — this test fails the instant a topic or filter key is added to one side and not
// the other, instead of the mirror silently going stale and stripping a valid caller rule.
describe("F46: subscribe tool's topic enum and filter shape mirror TopicSchema/TopicFilterSchema exactly", () => {
  const subscribe = () => MCP_TOOL_TABLE.find((t) => t.name === "subscribe")!;

  it("topic enum options equal TopicSchema.options as a set", () => {
    const mirrored = subscribe().inputSchema!["topic"] as z.ZodEnum<[string, ...string[]]>;
    expect(new Set(mirrored.options)).toEqual(new Set(TopicSchema.options));
  });

  it("filter shape keys equal TopicFilterSchema's shape keys as a set", () => {
    const filterField = subscribe().inputSchema!["filter"] as z.ZodOptional<z.ZodObject<z.ZodRawShape>>;
    const mirroredKeys = Object.keys(filterField.unwrap().shape);
    expect(new Set(mirroredKeys)).toEqual(new Set(Object.keys(TopicFilterSchema.shape)));
  });

  // F46.QA: the subscribe mirror was guarded; the HOOK mirror (HookFilterShape, used by both
  // hook_create's rule.filter and hook_update's filter) was NOT — dropping `contains` from it
  // left the whole protocol suite green. It is a NON-strict z.object, so a missing key is
  // silently STRIPPED rather than rejected: an agent that supplies filter.contains on an
  // agent.output rule would get "requires filter.contains" back from the daemon it just sent
  // it to. Key-set equality is what makes that drift impossible.
  // hook_create nests the filter under `rule`, hook_update under `patch` (where it is
  // additionally .nullable(), the "clear my filter" affordance) — peel whatever wrappers each
  // site happens to use rather than hardcoding one shape, so this guard survives either
  // gaining or losing an optional/nullable wrapper.
  const unwrapAll = (f: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> => {
    let cur: z.ZodTypeAny = f;
    while (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap();
    return cur as z.ZodObject<z.ZodRawShape>;
  };
  const hookFilterShape = (tool: string, outer: "rule" | "patch") => {
    const input = MCP_TOOL_TABLE.find((t) => t.name === tool)!.inputSchema!;
    return unwrapAll((input[outer] as z.ZodObject<z.ZodRawShape>).shape["filter"]!);
  };

  it.each([["hook_create", "rule"], ["hook_update", "patch"]] as const)(
    "%s's filter shape keys equal TopicFilterSchema's shape keys as a set",
    (tool, path) => {
      expect(new Set(Object.keys(hookFilterShape(tool, path).shape)))
        .toEqual(new Set(Object.keys(TopicFilterSchema.shape)));
    },
  );

  // F46.QA: a key-set test can never catch a missing REFINEMENT, so each mirror is also
  // exercised behaviourally. A NUL needle is the sharp case: topics.ts elides a long output
  // into `head + NUL + tail`, so before this refinement a needle of "A\0B" matched a blob whose
  // head ended in A and whose tail began with B — a phantom hit on text no agent ever emitted.
  it.each([
    ["TopicFilterSchema", (f: unknown) => TopicFilterSchema.safeParse(f).success],
    ["subscribe", (f: unknown) => (subscribe().inputSchema!["filter"] as z.ZodTypeAny).safeParse(f).success],
    ["hook_create", (f: unknown) => hookFilterShape("hook_create", "rule").safeParse(f).success],
    ["hook_update", (f: unknown) => hookFilterShape("hook_update", "patch").safeParse(f).success],
  ])("%s rejects a control-character needle and still accepts a regex-shaped literal one", (_name, accepts) => {
    expect(accepts({ contains: `A${String.fromCharCode(0)}B` })).toBe(false);
    expect(accepts({ contains: "\nERROR" })).toBe(false);
    expect(accepts({ contains: "build failed (a|b)+ .*" })).toBe(true);
  });
});


describe("computer-use MCP delivery", () => {
  it.each(["claude-agent", "codex-agent"])("delivers real images and errors through proxy and direct tools for %s", async (agentId) => {
    const img = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const dispatch = async (method: string, params: any) => {
      if (method === "mcpstore.list") return [{ name: "desktop", direct: true }];
      if (method === "mcpstore.tools") return { servers: [{ server: "desktop", connected: true, tools: [{ name: "screenshot", description: "Screenshot", inputSchema: { type: "object" } }] }] };
      expect(params.agentId).toBe(agentId);
      return { text: "screen", images: [img], structuredContent: { capture_id: "capture-1" }, isError: true };
    };
    const server = await createChimeraMcpServer(dispatch, { depth: 0, agentId });
    const registered = registeredTools(server);
    for (const [name, args] of [["mcp_store_call", { server: "desktop", tool: "screenshot" }], ["desktop__screenshot", {}]] as const) {
      const result = await registered[name]!.handler(args);
      expect(result).toEqual({ content: [{ type: "text", text: JSON.stringify({ text: "screen", isError: true }) }, img], structuredContent: { capture_id: "capture-1" }, isError: true });
    }
    await server.close();
  });

  it("stamps session ownership from context, including deferred discovery", () => {
    const entry = MCP_TOOL_TABLE.find(t => t.name === "chimera_call")!;
    expect(entry.resolve({ tool: "mcp_store_session", args: { server: "desktop", action: "release" } }, { depth: 0, agentId: "codex" }))
      .toMatchObject({ method: "mcpstore.session", params: { server: "desktop", action: "release", agentId: "codex" } });
  });
});
