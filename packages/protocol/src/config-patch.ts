import { z } from "zod";

// EXPLICIT-NULL-ESCAPE — the one way a `config.patch` can SET a key to null.
//
// Every daemon-side config write lands in `~/.chimera/config.d/ui.json`, and overlays are
// applied to the base config as an RFC 7396 JSON Merge Patch, where `null` at a key means
// DELETE THAT KEY. That makes a literal null structurally unable to express "this key IS
// null": it erases itself at load and resolution falls back to whatever default the key has.
// The knob that made this a real bug is `providerOverrides.<id>.compactionThreshold`, where
// an explicit null means "use the backend's NATIVE compaction" and is therefore semantically
// different from both a number and an absent key (QA finding M-1).
//
// So a patch says null with this string instead. It survives composition into ui.json as an
// ordinary scalar and is resolved back to a real null by core's `jsonMergePatch` when the
// overlay is applied — which is why the escape must be resolved at LOAD time, not at write
// time: ui.json is re-applied as a merge patch on every reload, so a null materialised at
// write time would just delete itself on the next read.
//
// Two deliberate limits, both of which fail LOUDLY rather than silently:
//   - it is only interpreted at an object-key position INSIDE a patch/overlay. A `"$null"`
//     sitting in the BASE config.json is a merge target, never a patch, so it stays the
//     literal string and fails config validation.
//   - it is not interpreted inside arrays (arrays replace wholesale under RFC 7396), and on a
//     key whose schema forbids null it resolves to null and then fails validation before
//     anything is written.
export const CONFIG_PATCH_NULL = "$null";

export const ConfigPatchNullSchema = z.literal(CONFIG_PATCH_NULL);

/** True for the explicit-null escape token — see CONFIG_PATCH_NULL. */
export function isConfigPatchNull(value: unknown): boolean {
  return value === CONFIG_PATCH_NULL;
}

/** `value` as a config.patch payload: a real null is rewritten to the escape so it SETS the
 *  key to null instead of deleting it. Any other value passes through untouched. */
export function configPatchValue<T>(value: T): T | typeof CONFIG_PATCH_NULL {
  return value === null ? CONFIG_PATCH_NULL : value;
}
