import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OVERRIDE_FIELDS } from "../src/components/RoleBindingOverrideEditor";
import { RoleSpecSchema } from "@chimera/protocol";

// ROLE-BINDING-OVERRIDES: what a team's role slot may override, and whether the editor showing it
// stays usable. Reported together: "the window that opens scrolls and I cannot edit anything" and
// "I cannot change the context window when spawning a role".

describe("what the editor lets a binding override", () => {
  it("offers the compaction threshold — the context window a role's agents compact against", () => {
    // It has been on AgentSpec, and so on RoleSpec which is derived from it, since the per-agent
    // knob landed. The editor never offered it, so the only way to set a role's window was a
    // hand-written spawn.
    expect(OVERRIDE_FIELDS.map((f) => f.key)).toContain("compactionThreshold");
  });

  it("only offers keys a RoleSpec can actually carry", () => {
    // An override the schema rejects is a field that silently fails on save. Checked against the
    // schema rather than a second hand-kept list, which is the thing that would drift.
    const shape = Object.keys((RoleSpecSchema as unknown as { shape: Record<string, unknown> }).shape);
    for (const f of OVERRIDE_FIELDS) {
      expect(shape, `override field "${f.key}" is not on RoleSpec`).toContain(f.key);
    }
  });
});

describe("the editor stays usable with a long inherited value", () => {
  it("CLAMPS the inherited value instead of rendering it whole", () => {
    // A role's `instructions` is prose and routinely runs to thousands of characters — the
    // daily-digest role's does. Rendered in full it pushed every field below it off the screen,
    // and the form was unreachable: working exactly as written, and unusable.
    //
    // Asserted against the stylesheet because that is where the fix lives; a component test in
    // this no-DOM environment cannot measure a rendered height.
    const css = readFileSync(join(__dirname, "../src/components/RoleBindingOverrideEditor.module.css"), "utf8");
    const rule = css.slice(css.indexOf(".inheritedValue"), css.indexOf("}", css.indexOf(".inheritedValue")));
    expect(rule).toContain("line-clamp");
    expect(rule).toContain("overflow: hidden");
  });

  it("keeps the full text reachable — clamped is not hidden", () => {
    // The clamp must not lose information: the whole value is on the element's title, and
    // pressing `override` puts it in a real textarea.
    const tsx = readFileSync(join(__dirname, "../src/components/RoleBindingOverrideEditor.tsx"), "utf8");
    const block = tsx.slice(tsx.indexOf("styles.inheritedValue"), tsx.indexOf("styles.inheritedValue") + 220);
    expect(block).toContain("title=");
  });
});
