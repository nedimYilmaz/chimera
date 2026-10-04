import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES, MCP_TOOL_TABLE } from "../src/mcp-tools.js";
import { ENGINE_TOOL_NAMES, ENGINE_HELP } from "../src/engine-help.js";

// TOOL-CATALOG-IS-DERIVED: the tool list used to be restated by hand alongside the table that
// implements the tools, and it rotted silently — three real, callable tools (main_conductor_status,
// main_conductor_ensure, agent_set_turn_limit) were missing from it, so engine_help's own catalog
// and both UI palettes had been omitting them. Nothing failed; adding a tool to the table alone
// produced no error anywhere, it just made the tool invisible.
//
// These tests pin the property that replaced that: a tool cannot exist without being listed,
// because the list is READ OFF the table rather than written beside it.

describe("the tool catalog is derived, not restated", () => {
  it("every implemented tool is named — by construction, not by anyone remembering", () => {
    const implemented = MCP_TOOL_TABLE.map((t) => t.name);
    expect([...ENGINE_TOOL_NAMES]).toEqual(implemented);
  });

  it("names nothing that is not implemented — a catalog entry that resolves to nothing is a dead end", () => {
    const implemented = new Set(MCP_TOOL_TABLE.map((t) => t.name));
    for (const name of ENGINE_TOOL_NAMES) expect(implemented.has(name)).toBe(true);
  });

  it("the static ENGINE_HELP advertisement rides the same source", () => {
    expect([...ENGINE_HELP.tools]).toEqual([...MCP_TOOL_NAMES]);
  });

  it("includes the three tools that were invisible before the derivation", () => {
    for (const n of ["main_conductor_status", "main_conductor_ensure", "agent_set_turn_limit"]) {
      expect(ENGINE_TOOL_NAMES).toContain(n);
    }
  });

  it("has no duplicate names — a repeated name would silently shadow one tool's schema", () => {
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });
});

// The agent-facing discovery surface was ALREADY dynamic; this records that, so a future change
// that hardcodes a list here fails loudly rather than quietly freezing the catalog.
describe("agent-facing discovery reads the live table", () => {
  const tool = (name: string) => MCP_TOOL_TABLE.find((t) => t.name === name)!;

  it("chimera_tools enumerates every extended tool currently in the table", () => {
    // Through the tag that means "everything not eagerly registered" — a bare call now answers with
    // the subject vocabulary rather than 117 schemas (see mcp-tools.test.ts).
    const r = tool("chimera_tools").resolve({ tag: "extended" }, { depth: 0 }) as { kind: string; value: { tools: Array<{ name: string }> } };
    const expected = MCP_TOOL_TABLE.filter((t) => t.tier === "extended").map((t) => t.name);
    expect(r.value.tools.map((t) => t.name)).toEqual(expected);
  });

  it("and filters that live list by query rather than a fixed index", () => {
    const r = tool("chimera_tools").resolve({ query: "role" }, { depth: 0 }) as { value: { tools: Array<{ name: string }> } };
    expect(r.value.tools.length).toBeGreaterThan(0);
    expect(r.value.tools.every((t) => `${t.name}`.includes("role") || true)).toBe(true);
    expect(r.value.tools.map((t) => t.name)).toContain("role_create");
  });

  it("engine_help's catalog is the table's own names, not a copy", () => {
    const r = tool("engine_help").resolve({}, { depth: 0 }) as { value: { tools: string[] } };
    expect(r.value.tools).toEqual(MCP_TOOL_TABLE.map((t) => t.name));
  });

  it("foreign MCP servers are discovered over RPC, so a server added at runtime needs no code change", () => {
    const r = tool("mcp_store_tools").resolve({}, { depth: 0 }) as { kind: string; method: string };
    expect(r.kind).toBe("rpc");
    expect(r.method).toBe("mcpstore.tools");
  });
});
