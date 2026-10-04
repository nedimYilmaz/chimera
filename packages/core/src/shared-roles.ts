// ROLES-UNIFY §4: the single merge implementation every spawn/preview path shares —
// replaces materializeSharedRole. A team/session role slot is a REFERENCE
// (RoleBindingSchema) into the global role library, resolved live at read/spawn time:
// never persisted pre-merged. Each stage is a plain shallow spread over the previous — a
// present key in a later stage REPLACES the whole value (no deep merge of nested objects
// like orchestration/inherit/providerOptions/mcpServers) — this is the existing,
// unanimous merge shape every spawn site in this codebase already used before this
// function existed (scheduler.ts's `{...agentTemplate, ...task.overrides}`, engine.ts's
// old `{...overlayFields, ...rawSpec}`), just given one canonical implementation.
import type { RoleBinding, RoleSpec } from "@chimera/protocol";

// The subset of RoleStore this pure function needs — kept as a narrow interface (not the
// concrete class) so it stays trivially testable with a plain in-memory fixture.
export interface RoleLibrary {
  get(name: string): RoleSpec;
}

export function resolveRole(
  library: RoleLibrary,
  binding: RoleBinding,
  callerOverrides?: Record<string, unknown>,
): RoleSpec {
  const base = library.get(binding.role); // UnknownRoleError surfaces as-is if the library entry is gone
  // Both implementations this replaces (materializeSharedRole and engine.ts's old sp.role
  // handler) folded a "Available skills..." nudge sentence onto the LIBRARY role's own
  // instructions before any override layer — preserved verbatim here so an override that
  // sets `instructions` still fully replaces it (stage 2/3 spread after this key), and a
  // `skills` override does NOT retroactively change the note text (matches old behavior:
  // the note was always computed from the role's own skills, never a caller's).
  const skillsNote = base.skills.length > 0
    ? `\n\nAvailable skills for this role — invoke via the Skill tool when relevant: ${base.skills.join(", ")}.`
    : "";
  return {
    ...base,
    instructions: (base.instructions ?? "") + skillsNote,
    ...binding.overrides,
    ...(callerOverrides ?? {}),
  } as RoleSpec;
}
