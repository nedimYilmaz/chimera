import { describe, expect, it } from "vitest";
import { CONDUCTOR_TOOL_NAMES, MCP_TOOL_TABLE, CORE_MCP_TOOL_NAMES } from "../src/mcp-tools.js";
import { CONDUCTOR_PLAYBOOK } from "../src/index.js";
import { ENGINE_TOOL_NAMES } from "../src/engine-help.js";

// CONDUCTOR-TOOLS-MATCH-THE-PLAYBOOK: a prompt that names tools the agent cannot see does not
// fail safely — observed live, a conductor told to role_create ten roles instead reverse-
// engineered chimera's RPC framing and wrote a raw socket client. The invariant worth pinning is
// therefore about the RELATIONSHIP between the playbook and the tool surface, not a name list.

const names = new Set(ENGINE_TOOL_NAMES);
const visibleToConductor = new Set([...CORE_MCP_TOOL_NAMES, ...CONDUCTOR_TOOL_NAMES]);

describe("a conductor can see every tool its own playbook tells it to use", () => {
  // The tools the playbook names, read out of the playbook itself so the two cannot drift.
  const namedInPlaybook = [...new Set(CONDUCTOR_PLAYBOOK.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? [])]
    .filter((n) => names.has(n));

  it("names a meaningful number of real tools (guards the extraction itself)", () => {
    expect(namedInPlaybook.length).toBeGreaterThan(15);
  });

  it("every one of them is registered for a conductor", () => {
    const unreachable = namedInPlaybook.filter((n) => !visibleToConductor.has(n));
    expect(unreachable).toEqual([]);
  });

  it("but NOT for an ordinary worker — the lean surface is the default, this is the exception", () => {
    for (const n of CONDUCTOR_TOOL_NAMES) expect(CORE_MCP_TOOL_NAMES).not.toContain(n);
  });

  it("every conductor tool is a real entry in the table, not a name that resolves to nothing", () => {
    const inTable = new Set(MCP_TOOL_TABLE.map((t) => t.name));
    for (const n of CONDUCTOR_TOOL_NAMES) expect(inTable.has(n)).toBe(true);
  });
});

describe("the deferred-tool escape hatch is stated, not implied", () => {
  it("the playbook tells a conductor what to do when a named tool is not visible", () => {
    expect(CONDUCTOR_PLAYBOOK).toContain("DEFERRED");
    expect(CONDUCTOR_PLAYBOOK).toContain("chimera_call");
  });

  it("and forbids the workaround that was actually observed — driving the daemon directly", () => {
    expect(CONDUCTOR_PLAYBOOK).toMatch(/daemon socket|RPC layer/);
  });
});
