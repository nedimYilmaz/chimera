import { Fragment, useState } from "react";
import { CAPABILITY_NOTES } from "../copy";
import styles from "./RoleBindingOverrideEditor.module.css";
import { EffortLevelSchema } from "@chimera/protocol";

// ROLES-UNIFY S5 (docs/superpowers/specs/2026-07-28-roles-unify.md §6.3): the
// binding-override editor — where an operator edits a team binding's `overrides`
// AFTER it's already attached. For each practical field (same v1 set
// RoleFormCard.tsx §6.2 exposes, plus `cwd` — the one field a binding may need
// to supply when the library role has none, the bind-time invariant §2/§4), this
// shows the LIBRARY value (grey, "inherited") or, if overridden, the pinned
// value (highlighted) with a toggle between the two. Editable AT ANY TIME, not
// gated behind a separate "edit mode" — the operator's headline requirement.
//
// `team.updateRoleBinding`'s `overrides` field is a WHOLE-OBJECT REPLACE
// server-side (core/src/rpc/team-rpc.ts: `overrides: p.overrides ?? existing.overrides`),
// never a per-key merge — so `onSave` is always given the COMPLETE desired
// overrides record (every currently-toggled-on field, nothing else). This is
// DELIBERATELY not built on ui-state's `buildRoleBindingOverridePatch` sparse-diff
// helper: that helper only ever EMITS a value for a changed key, it cannot
// signal "remove this key" — feeding its output straight to this RPC would
// re-pin a reset-to-inherited field at today's library value instead of
// actually dropping the override, silently defeating "editing the library
// role reaches every binding that didn't override that field" the next time
// the library value changes. Building the full record directly from the
// toggle set sidesteps that hazard by construction.

export type OverrideFieldKind = "text" | "select" | "textarea" | "json" | "checkbox";

export type OverrideField = {
  key: string;
  label: string;
  kind: OverrideFieldKind;
  options?: readonly string[];
  placeholder?: string;
};

export const OVERRIDE_FIELDS: readonly OverrideField[] = [
  { key: "cwd", label: "cwd", kind: "text" },
  { key: "model", label: "model", kind: "text" },
  // EFFORT-ONE-SOURCE: derived. "" is the inherit-from-role choice, not a level.
  { key: "effort", label: "effort", kind: "select", options: ["", ...EffortLevelSchema.options] },
  { key: "account", label: "account", kind: "text" },
  { key: "provider", label: "provider", kind: "text" },
  { key: "permissionProfile", label: "permission profile", kind: "select", options: ["", "readOnly", "acceptEdits", "full"] },
  { key: "isolation", label: "isolation", kind: "select", options: ["", "none", "worktree"] },
  { key: "maxTurns", label: "max turns", kind: "text" },
  // COMPACTION-THRESHOLD-PER-ROLE: the context window this role's agents compact against. It has
  // been on AgentSpec (and so on RoleSpec, which is derived from it) since the per-agent knob
  // landed, but the editor never offered it — so the one place a role's window could be set was a
  // hand-written spawn. Blank inherits the account/provider default.
  { key: "compactionThreshold", label: "compact at (tokens)", kind: "text" },
  { key: "turnLimitPolicy", label: "turn limit policy", kind: "select", options: ["", "fail", "soft"] },
  { key: "persistent", label: "persistent", kind: "checkbox" },
  { key: "poolSize", label: "pool size", kind: "text" },
  { key: "instructions", label: "instructions", kind: "textarea" },
  { key: "skills", label: "skills (comma-separated)", kind: "text" },
  { key: "plugins", label: "plugins (JSON)", kind: "json" },
  { key: "mcpToolAllowlist", label: "mcpToolAllowlist (JSON)", kind: "json" },
  { key: "mcpServers", label: "mcpServers (JSON)", kind: "json" },
  { key: "orchestration", label: "orchestration (JSON)", kind: "json" },
  { key: "inherit", label: "inherit (JSON)", kind: "json" },
  { key: "on", label: "on (JSON)", kind: "json" },
  { key: "providerOptions", label: "providerOptions (JSON)", kind: "json" },
];

function toEditString(field: OverrideField, v: unknown): string {
  if (field.kind === "json") return v !== undefined ? JSON.stringify(v, null, 2) : "{}";
  if (field.kind === "checkbox") return v === true ? "true" : "false";
  if (Array.isArray(v)) return v.join(", ");
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function displayText(field: OverrideField, v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (field.kind === "checkbox") return v === true ? "true" : "false";
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function parseFieldValue(field: OverrideField, raw: string): unknown {
  if (field.kind === "json") {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${field.label} must be valid JSON`);
    }
  }
  if (field.kind === "checkbox") return raw === "true";
  if (field.key === "skills") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (field.key === "maxTurns" || field.key === "poolSize") {
    if (!raw.trim()) throw new Error(`${field.label} must be a number (or reset to inherited)`);
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${field.label} must be a whole number`);
    return n;
  }
  return raw;
}

export function RoleBindingOverrideEditor({
  librarySpec,
  overrides,
  readOnly = false,
  onSave,
}: {
  /** The resolved library role this binding points at — undefined if the
   * name can't be found (defensive: an unknown library reference still
   * renders, every field just shows "—" for its inherited value). */
  librarySpec: Record<string, unknown> | undefined;
  /** The binding's CURRENT sparse overrides record — key present = overridden. */
  overrides: Record<string, unknown>;
  /** Discovered-role bindings are regenerated by project sync — read-only here,
   * same rationale the old team-role detail applied to discovered rows. */
  readOnly?: boolean;
  onSave: (overrides: Record<string, unknown>) => Promise<void>;
}) {
  const initialKeys = () => new Set(Object.keys(overrides).filter((k) => OVERRIDE_FIELDS.some((f) => f.key === k)));
  const initialValues = () => {
    const v: Record<string, string> = {};
    for (const f of OVERRIDE_FIELDS) {
      const cur = f.key in overrides ? overrides[f.key] : librarySpec?.[f.key];
      v[f.key] = toEditString(f, cur);
    }
    return v;
  };

  const [overriddenKeys, setOverriddenKeys] = useState<Set<string>>(initialKeys);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Dirty check compares the CURRENT toggle/value state against the original
  // overrides record's own field-set (both restricted to OVERRIDE_FIELDS) —
  // deliberately not a parse-then-compare (parseFieldValue can throw on
  // half-typed JSON while the operator is mid-edit; a dirty check must never
  // throw on every keystroke).
  const originalKeys = Object.keys(overrides).filter((k) => OVERRIDE_FIELDS.some((f) => f.key === k));
  const dirty =
    overriddenKeys.size !== originalKeys.length ||
    originalKeys.some((key) => !overriddenKeys.has(key)) ||
    Array.from(overriddenKeys).some((key) => {
      const field = OVERRIDE_FIELDS.find((f) => f.key === key)!;
      return toEditString(field, overrides[key]) !== values[key];
    });

  function toggle(field: OverrideField): void {
    if (readOnly) return;
    setOverriddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(field.key)) {
        next.delete(field.key);
        setValues((v) => ({ ...v, [field.key]: toEditString(field, librarySpec?.[field.key]) }));
      } else {
        next.add(field.key);
      }
      return next;
    });
    if (error) setError(null);
  }

  function setValue(key: string, v: string): void {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  }

  function cancel(): void {
    setOverriddenKeys(initialKeys());
    setValues(initialValues());
    setError(null);
  }

  function submit(): void {
    if (busy) return;
    const next: Record<string, unknown> = {};
    try {
      for (const key of overriddenKeys) {
        const field = OVERRIDE_FIELDS.find((f) => f.key === key)!;
        next[key] = parseFieldValue(field, values[key]!);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    setError(null);
    void onSave(next)
      .then(() => setBusy(false))
      .catch((err: unknown) => {
        setBusy(false);
        setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
      });
  }

  return (
    <div className={styles.editor} data-role-binding-override-editor>
      {OVERRIDE_FIELDS.map((field) => {
        const isOverridden = overriddenKeys.has(field.key);
        const rowClass = isOverridden ? styles.rowOverridden : styles.rowInherited;
        return (
          <Fragment key={field.key}>
            <div className={rowClass} data-override-field={field.key}>
              <span className={styles.label}>{field.label}</span>
              <div className={styles.valueCol}>
                {!isOverridden ? (
                  <span className={styles.inheritedValue} title={displayText(field, librarySpec?.[field.key])}>
                    {displayText(field, librarySpec?.[field.key])}
                  </span>
                ) : field.kind === "select" ? (
                  <select className={styles.input} value={values[field.key]} disabled={readOnly}
                    onChange={(e) => setValue(field.key, e.target.value)} data-override-input={field.key}>
                    {(field.options ?? [""]).map((opt) => <option key={opt} value={opt}>{opt || "(none)"}</option>)}
                  </select>
                ) : field.kind === "checkbox" ? (
                  <input type="checkbox" checked={values[field.key] === "true"} disabled={readOnly}
                    onChange={(e) => setValue(field.key, e.target.checked ? "true" : "false")} data-override-input={field.key} />
                ) : field.kind === "textarea" || field.kind === "json" ? (
                  <textarea className={styles.textarea} rows={field.kind === "json" ? 3 : 2} value={values[field.key]} disabled={readOnly}
                    onChange={(e) => setValue(field.key, e.target.value)} data-override-input={field.key} />
                ) : (
                  <input className={styles.input} value={values[field.key]} disabled={readOnly}
                    onChange={(e) => setValue(field.key, e.target.value)} data-override-input={field.key} />
                )}
              </div>
              {!readOnly && (
                <span className={styles.toggleChip} onClick={() => toggle(field)} data-override-toggle={field.key}>
                  {isOverridden ? "reset to inherited" : "override"}
                </span>
              )}
            </div>
            {field.key === "effort" && values["provider"]?.trim() === "kimi" && (
              <div className={styles.kimiNote} data-kimi-effort-note>{CAPABILITY_NOTES.kimiEffortDowngrade}</div>
            )}
          </Fragment>
        );
      })}
      {error && <div className={styles.error}>{error}</div>}
      {!readOnly && dirty && (
        <div className={styles.footer}>
          <span className={styles.submitChip} onClick={submit} data-override-save>{busy ? "saving…" : "save overrides"}</span>
          <span className={styles.cancelChip} onClick={cancel} data-override-cancel>cancel</span>
        </div>
      )}
    </div>
  );
}
