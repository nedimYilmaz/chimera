import { describe, it, expect } from "vitest";
import { CONDUCTOR_PLAYBOOK } from "@chimera/protocol";
import { ENGINE_TOOL_NAMES } from "@chimera/protocol/engine-help";

// DRIFT GUARD: CONDUCTOR_PLAYBOOK's TOOLS line is agent-facing prompt copy that
// names CONCRETE tools. It is hand-written text, so nothing but this test stops a
// renamed/removed tool from leaving the playbook advertising a nonexistent tool to
// every conductor spawn (app/tui main session AND engine.ts's per-project one).
// The only other reference is a generic /conductor/i smoke match that passes
// regardless of what the TOOLS line says.

const toolsLine = CONDUCTOR_PLAYBOOK.split("\n").find((l) => l.startsWith("TOOLS:"));

// Tokens that look like a tool name: an underscored identifier, optionally ending
// in the `*` family wildcard the copy uses (workflow_*, artifact_*, ...).
// Possessives ("team_update's roles") stop at the apostrophe.
const underscored = (toolsLine ?? "").match(/\b[a-z][a-z0-9]*_[a-z0-9_]*\*?/g) ?? [];

// The two tool names the copy mentions WITHOUT an underscore — they cannot be
// pattern-matched out of prose, so they are pinned by hand.
const BARE_NAMES = ["dispatch", "subscribe"] as const;

describe("CONDUCTOR_PLAYBOOK TOOLS line", () => {
  it("has a TOOLS line naming a non-trivial set of tools", () => {
    expect(toolsLine).toBeDefined();
    expect(underscored.length).toBeGreaterThan(10);
  });

  it("names only tools that exist in ENGINE_TOOL_NAMES", () => {
    const names = new Set<string>(ENGINE_TOOL_NAMES);
    const unknown = underscored.filter((t) => !t.endsWith("*") && !names.has(t));
    expect(unknown).toEqual([]);
  });

  it("resolves every `family_*` wildcard to at least one real tool", () => {
    const wildcards = underscored.filter((t) => t.endsWith("*"));
    expect(wildcards.length).toBeGreaterThan(0);
    const unmatched = wildcards.filter(
      (w) => !ENGINE_TOOL_NAMES.some((n) => n.startsWith(w.slice(0, -1))),
    );
    expect(unmatched).toEqual([]);
  });

  it("names only real tools among the underscore-less ones (dispatch/subscribe)", () => {
    for (const n of BARE_NAMES) {
      expect(toolsLine).toContain(n);
      expect(ENGINE_TOOL_NAMES as readonly string[]).toContain(n);
    }
  });
});

// TOKEN-ECONOMY-PROPAGATION: the playbook is the ONLY place these disciplines are stated, and
// every conductor (main, per-project, app-spawned) inherits them from it. Pinned by name rather
// than by exact wording so the copy can be improved without churning the test — what must not
// silently disappear is the RULE.
describe("CONDUCTOR_PLAYBOOK operating disciplines", () => {
  const rules = CONDUCTOR_PLAYBOOK.split("\n").filter((l) => l.startsWith("- "));

  it("states the token-economy discipline in its own rule line", () => {
    const line = rules.find((l) => l.startsWith("- TOKEN ECONOMY"));
    expect(line).toBeDefined();
    expect(line).toMatch(/minimum talk/i);
    expect(line).toMatch(/maximum work/i);
    expect(line).toMatch(/minimum deliberation/i);
  });

  it("tells the conductor to PROPAGATE it into what it creates — the discipline is not its alone", () => {
    const line = rules.find((l) => l.includes("PROPAGATE"));
    expect(line).toBeDefined();
    // the three creation surfaces a conductor actually has
    expect(line).toMatch(/role_create/);
    expect(line).toMatch(/team_create/);
  });

  it("tells it to bind an existing library role before writing instructions inline", () => {
    const line = rules.find((l) => l.startsWith("- ROLE-FIRST"));
    expect(line).toBeDefined();
    expect(line).toMatch(/role_list/);
    expect(line).toMatch(/overrides/);
  });

  it("names the fields it may override, so \"bind and adjust\" is actionable rather than aspirational", () => {
    const line = rules.find((l) => l.startsWith("- ROLE-FIRST"))!;
    // an agent that does not know instructions itself is overridable will role_create a
    // near-duplicate the moment it needs a different prompt — the exact way the library rots
    for (const field of ["model", "effort", "permissionProfile", "instructions"]) {
      expect(line, `overridable field ${field} must be named`).toContain(field);
    }
    expect(line).toMatch(/role_create only when/i);
  });
});
