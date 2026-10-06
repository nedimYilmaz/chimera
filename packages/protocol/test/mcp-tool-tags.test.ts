import { describe, expect, it } from "vitest";
import { MCP_TOOL_TABLE, mcpToolTags, mcpToolsByTag, tagsForTool } from "../src/mcp-tools.js";
import type { McpToolEntry } from "../src/mcp-tools.js";

// TOOL-TAGS — a tool's SUBJECT, so a caller can ask for what it needs instead of guessing names,
// and so granting an agent a wider surface is naming a subject rather than editing a list.
//
// Derived from the names the tools already have, not hand-listed. A hand-kept tag map would be a
// second catalog to forget to update, which is the exact failure ENGINE_TOOL_NAMES was made
// derived to avoid — and it would rot silently, because nothing breaks when a tag is merely
// missing. What is pinned here is that the derivation covers everything, that the overrides only
// fire where the name genuinely lies, and that granting by tag hands out the same tools the
// hand-kept sets used to.

describe("tags are derived from the catalog", () => {
  it("gives every tool at least one subject and its tier", () => {
    for (const t of MCP_TOOL_TABLE) {
      expect(t.tags.length, t.name).toBeGreaterThanOrEqual(2);   // a subject plus the tier
      expect(t.tags, t.name).toContain(t.tier);
    }
  });

  it("reads the subject off the name when the name is honest", () => {
    expect(tagsForTool("queue_push", "core")).toContain("queue");
    expect(tagsForTool("project_create", "extended")).toContain("project");
    expect(tagsForTool("workflow_run", "extended")).toContain("workflow");
  });

  it("overrides the names that LIE about their subject", () => {
    // A verb ("dispatch"), a possessive ("my_team"), and a noun that is not the subject
    // ("chronicle" is history, not a thing called chronicle). Reading the prefix on these would
    // produce three one-member categories nobody would ever search for.
    expect(tagsForTool("my_team", "core")).toContain("team");
    expect(tagsForTool("dispatch", "extended")).toContain("queue");
    expect(tagsForTool("chronicle_search", "extended")).toContain("memory");
    expect(tagsForTool("subscribe", "core")).toContain("events");
  });

  it("carries `conductor` for exactly the conductor verbs", () => {
    expect(tagsForTool("role_create", "extended")).toContain("conductor");
    expect(tagsForTool("memory_search", "core")).not.toContain("conductor");
  });

  it("never invents a one-member category out of mcp_store_*", () => {
    // Eight tools whose shared prefix is three words long. Left to the generic rule they would
    // split into nothing useful.
    expect(mcpToolsByTag("mcp").length).toBeGreaterThanOrEqual(6);
  });
});

describe("searching by tag", () => {
  it("returns the same 24 tools the core tier holds", () => {
    // The operator's own check: "core" should hand back exactly what every agent already gets.
    expect(mcpToolsByTag("core").length).toBe(MCP_TOOL_TABLE.filter((t) => t.tier === "core").length);
  });

  it("is case- and whitespace-insensitive, because it is typed by a model", () => {
    expect(mcpToolsByTag(" QUEUE ").length).toBe(mcpToolsByTag("queue").length);
  });

  it("returns nothing for a subject that does not exist, rather than everything", () => {
    expect(mcpToolsByTag("not-a-subject")).toEqual([]);
  });

  it("reports the vocabulary with counts, sorted by tag name", () => {
    const tags = mcpToolTags();
    expect(tags.length).toBeGreaterThan(10);
    for (let i = 1; i < tags.length; i++) expect(tags[i - 1]!.tag < tags[i]!.tag).toBe(true);
  });

  // CACHE-PREFIX STABILITY: this is the drift this suite must catch — a count-based sort let a
  // tool landing on an UNRELATED subject reshuffle every other subject's position in
  // buildCapabilityBlock()'s AWARENESS sentence (it happened twice in one afternoon: F22 then
  // F13.1). Sorting by tag name means a subject's position depends only on its own spelling, not
  // on how many tools any subject — including itself — happens to carry.
  it("keeps every untouched subject's relative order when a tool is added to an existing subject", () => {
    const entry = (name: string, tags: readonly string[]): McpToolEntry =>
      ({ name, tags, tier: "core" }) as unknown as McpToolEntry;
    const before = mcpToolTags([
      entry("alpha_one", ["alpha"]),
      entry("alpha_two", ["alpha"]),
      entry("bravo_one", ["bravo"]),
      entry("bravo_two", ["bravo"]),
      entry("charlie_one", ["charlie"]),
      entry("charlie_two", ["charlie"]),
    ]).map((t) => t.tag);

    // Three more tools land on "bravo" alone — a real-world shape identical to F13.1 adding
    // history_runs to the existing "history" tag. Nothing about "alpha" or "charlie" changed.
    const after = mcpToolTags([
      entry("alpha_one", ["alpha"]),
      entry("alpha_two", ["alpha"]),
      entry("bravo_one", ["bravo"]),
      entry("bravo_two", ["bravo"]),
      entry("bravo_three", ["bravo"]),
      entry("bravo_four", ["bravo"]),
      entry("bravo_five", ["bravo"]),
      entry("charlie_one", ["charlie"]),
      entry("charlie_two", ["charlie"]),
    ]).map((t) => t.tag);

    expect(after).toEqual(before);
  });
});

describe("granting a surface by tag", () => {
  it("gives a plain agent the core subject and nothing else", () => {
    const granted = new Set(["core"]);
    const got = MCP_TOOL_TABLE.filter((t) => t.tags.some((x) => granted.has(x)));
    expect(got.length).toBe(24);
  });

  it("gives a conductor core PLUS conductor, including direct voice controls", () => {
    // Pin the grant size, including scoped terminal cleanup and workspace group controls.
    const granted = new Set(["core", "conductor"]);
    const got = MCP_TOOL_TABLE.filter((t) => t.tags.some((x) => granted.has(x)));
    expect(got.length).toBe(61);
    for (const name of ["agent_forget", "group_list", "group_create", "group_update", "group_delete", "agent_set_groups", "agent_add_groups", "agent_remove_groups"]) {
      expect(got.map((t) => t.name)).toContain(name);
    }
  });

  it("widens by naming a subject, not by editing a list", () => {
    const base = MCP_TOOL_TABLE.filter((t) => t.tags.includes("core")).length;
    const withQueue = MCP_TOOL_TABLE.filter((t) => t.tags.some((x) => x === "core" || x === "queue")).length;
    expect(withQueue).toBeGreaterThan(base);
    // And the words are the same ones chimera_tools searches, so what an agent can be GIVEN and
    // what it can FIND are one vocabulary.
    expect(mcpToolTags().map((t) => t.tag)).toContain("queue");
  });
});

describe("chimera_tools search behaviour", () => {
  const entry = MCP_TOOL_TABLE.find((t) => t.name === "chimera_tools")!;
  const call = (a: Record<string, unknown>) =>
    (entry.resolve(a, { depth: 0 }) as { kind: "local"; value: { tools?: Array<{ name: string; description: string }>; tags?: unknown[]; truncated?: number } }).value;

  it("takes SEVERAL words and ranks by how many land", () => {
    // One substring was the whole matcher, so "queue retry task" matched nothing — no tool
    // contains that phrase — and an agent that described what it wanted got an empty result.
    const r = call({ query: "queue retry task" });
    expect(r.tools!.length).toBeGreaterThan(0);
    expect(r.tools![0]!.name).toBe("queue_retry_task");
  });

  it("ranks a name hit above a description hit", () => {
    // Avoid common substrings like "move" (also in "remove") and "to" (in "atomically").
    const r = call({ query: "handoff provider" });
    expect(r.tools![0]!.name).toBe("agent_handoff");
    // agent_rebind mentions both terms only in its description.
    expect(r.tools!.findIndex((t) => t.name === "agent_rebind")).toBeGreaterThan(0);
  });

  it("returns the LEAD by default and the manual on detail:true", () => {
    // The lead is enough to choose; the schema is enough to call. The manual is what a search does
    // not need 28 copies of.
    const lead = call({ tag: "job" }).tools!.find((t) => t.name === "job_create")!;
    const full = call({ tag: "job", detail: true }).tools!.find((t) => t.name === "job_create")!;
    expect(lead.description).toBe("Create a scheduled job.");
    expect(full.description.length).toBeGreaterThan(lead.description.length * 5);
  });

  it("caps a QUERY and says how many it dropped", () => {
    // A broad query scored 97 of 141 tools. Ranked, so the cap costs the worst matches — but a
    // silently short list reads as "that is all there is".
    const r = call({ query: "move agent to another provider" });
    expect(r.tools!.length).toBe(12);
    expect(r.truncated).toBeGreaterThan(0);
  });

  it("NEVER truncates a tag search", () => {
    // Unranked: with no query there is nothing to sort by, so a cap would drop tools in table
    // order and present it as the answer.
    const r = call({ tag: "agent" });
    expect(r.tools!.length).toBe(mcpToolsByTag("agent").length);
    expect(r.truncated).toBeUndefined();
  });

  it("answers a bare call with the vocabulary, not the catalogue", () => {
    const r = call({});
    expect(r.tools).toBeUndefined();
    expect(r.tags!.length).toBeGreaterThan(10);
  });
});
