import { describe, it, expect } from "vitest";
import { resolveRole, type RoleLibrary } from "../src/shared-roles.js";
import type { RoleSpec } from "@chimera/protocol";

function fakeLibrary(entries: Record<string, RoleSpec>): RoleLibrary {
  return {
    get(name: string): RoleSpec {
      const r = entries[name];
      if (!r) throw new Error(`unknown role "${name}"`);
      return r;
    },
  };
}

const BASE: RoleSpec = {
  name: "worker",
  persistent: false,
  orchestration: { allow: true, maxDepth: 2 },
  skills: [],
  cwd: "/tmp/base",
  model: "base-model",
} as unknown as RoleSpec;

describe("resolveRole (ROLES-UNIFY §4)", () => {
  it("merge order: library defaults < binding.overrides < callerOverrides, each a shallow spread", () => {
    const library = fakeLibrary({ worker: BASE });
    const resolved = resolveRole(
      library,
      { role: "worker", overrides: { cwd: "/tmp/team", model: "team-model" } },
      { model: "caller-model" },
    );
    expect(resolved.cwd).toBe("/tmp/team");       // binding override applied over the library default
    expect(resolved.model).toBe("caller-model");  // caller override wins over both library and binding
  });

  it("a nested object override REPLACES the whole value — never a deep merge", () => {
    const library = fakeLibrary({ worker: BASE });
    const resolved = resolveRole(
      library,
      { role: "worker", overrides: { orchestration: { allow: false, maxDepth: 5 } } },
    );
    // BASE.orchestration.allow was true — a deep merge would keep some trace of it.
    // A shallow spread replaces the whole object: only maxDepth:5/allow:false survive.
    expect(resolved.orchestration).toEqual({ allow: false, maxDepth: 5 });
  });

  it("with no binding.overrides and no callerOverrides, resolves to exactly the library entry (plus the skills-note fold)", () => {
    const library = fakeLibrary({ worker: { ...BASE, skills: [] } });
    const resolved = resolveRole(library, { role: "worker", overrides: {} });
    expect(resolved.cwd).toBe("/tmp/base");
    expect(resolved.model).toBe("base-model");
  });

  it("folds a skills-nudge sentence onto instructions, computed from the LIBRARY role's own skills — not overridable by a later stage's skills, only by an explicit instructions override", () => {
    const library = fakeLibrary({ worker: { ...BASE, instructions: "base instructions", skills: ["code-review:ai-review-agentic"] } });
    const resolved = resolveRole(library, { role: "worker", overrides: {} });
    expect(resolved.instructions).toContain("base instructions");
    expect(resolved.instructions).toContain("code-review:ai-review-agentic");

    const overridden = resolveRole(library, { role: "worker", overrides: { instructions: "replaced entirely" } });
    expect(overridden.instructions).toBe("replaced entirely"); // an explicit override wins outright, no note appended
  });

  it("surfaces the library's own UnknownRoleError as-is when the binding's role has vanished", () => {
    const library = fakeLibrary({});
    expect(() => resolveRole(library, { role: "ghost", overrides: {} })).toThrow(/unknown role "ghost"/);
  });
});
