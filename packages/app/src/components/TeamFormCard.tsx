import { useEffect, useMemo, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ConfirmCard } from "./ConfirmCard";
import { ChipButton } from "./ChipButton";
import { PathPicker } from "./PathPicker";
import { rpcCall } from "../rpc/bridge";
import { buildTeamSpec, buildTeamUpdatePatch, validateTeamForm, type TeamFormValues } from "../state/selectors.coord";
import styles from "./TeamFormCard.module.css";

// W5 — the create-team form (mock showTeamForm, s_teams 614-641): OverlayCard
// center 620 mounted in the teams DETAIL pane host. Fields name* / role / max
// concurrent / cwd / queue(optional) / purpose(optional); enter walks the
// fields and the final enter submits team.create (spec shape per protocol
// TeamSpecSchema — RoleTemplate requires cwd); invalid input errors inline.
// esc cancels (OverlayCard), mod+o re-toggles (the opener-key convention).
//
// W16 (F15/D11): the SAME card doubles as "edit team · <name>" — `initial`
// prefills the fields, `name` is locked (identity field, immutable), and
// submit calls team.update{patch} instead of team.create{spec}. `rolesLocked`
// (true while the team has a running member) additionally locks role/cwd and
// OMITS roles from the patch entirely so a maxConcurrent-only edit never
// trips the engine's running-members guard.

type FieldKey = keyof TeamFormValues;
// TEAM-FORM: model/persistent/instructions were previously reachable only
// through the raw team.create/team.update RPC (same reachability class as
// 52db09a) — appended after the existing fields so tab/arrow order for the
// established fields is unchanged.
const FIELD_ORDER: readonly FieldKey[] = ["name", "role", "maxConcurrent", "cwd", "queue", "purpose", "model", "persistent", "instructions"];

export function TeamFormCard({ mode = "create", initial, rolesLocked = false, onSubmit, onClose }: {
  mode?: "create" | "edit";
  initial?: TeamFormValues;
  rolesLocked?: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<TeamFormValues>(
    initial ?? { name: "", role: "dev", maxConcurrent: "2", cwd: "", queue: "", purpose: "", model: "", persistent: "", instructions: "" },
  );
  const initialValuesRef = useRef(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(initialValuesRef.current);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = (): void => { if (dirty) setConfirmClose(true); else onClose(); };
  // name (index 0) is locked in edit mode — start the walk on the first
  // editable field so the initial focus() (a disabled input can't take it)
  // doesn't land on dead air.
  const [fieldIndex, setFieldIndex] = useState(() => (mode === "edit" ? 1 : 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | HTMLSelectElement | null>>>({});

  // ROLES-BINDING-CORRECTNESS: `role` used to be free text — the SAME field doubles as
  // both the binding's team-local key AND the library role name it references, and
  // nothing validated the reference existed before this (team.create's new
  // roles.get(binding.role) check makes a typo fail loudly, but the picker is what
  // stops the typo from happening at all). Mirrors SpawnCard's role.list-fed <select> +
  // "advanced" toggle (ROLES-TAB S6 / ROLES-UNIFY §6.5) rather than inventing a second
  // pattern. roleOptions === null (unresolved, or an older daemon without role.list)
  // degrades to the pre-picker free-text input.
  const [roleSpecs, setRoleSpecs] = useState<ReadonlyArray<Record<string, unknown>> | null>(null);
  useEffect(() => {
    let alive = true;
    rpcCall<Array<Record<string, unknown>>>("role.list", {}).then((rows) => {
      if (alive && Array.isArray(rows)) setRoleSpecs(rows.filter((r) => typeof r["name"] === "string"));
    }).catch(() => {
      if (alive) setRoleSpecs(null);
    });
    return () => { alive = false; };
  }, []);
  const roleOptions = useMemo(() => roleSpecs?.map((r) => r["name"] as string) ?? null, [roleSpecs]);
  // ROLES-UNIFY §6.5: default-fold team-qualified `<team>.<key>` names — reserved for
  // automatic migration (spec §3.2), not an everyday pick. The toggle reveals them.
  const [showAdvancedRoles, setShowAdvancedRoles] = useState(false);
  const visibleRoleOptions = useMemo(() => {
    if (!roleOptions) return null;
    const base = showAdvancedRoles ? roleOptions : roleOptions.filter((n) => !n.includes("."));
    if (values.role && !base.includes(values.role) && roleOptions.includes(values.role)) return [...base, values.role];
    return base;
  }, [roleOptions, showAdvancedRoles, values.role]);

  const activeKey = FIELD_ORDER[fieldIndex]!;
  useEffect(() => {
    inputRefs.current[activeKey]?.focus();
  }, [activeKey]);

  const set = (key: FieldKey) => (v: string) => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const submit = (): void => {
    if (busy) return;
    if (fieldIndex < FIELD_ORDER.length - 1) { setFieldIndex(fieldIndex + 1); return; }
    const invalid = validateTeamForm(values);
    if (invalid) {
      setError(invalid);
      const focusKey: FieldKey = invalid.startsWith("name") ? "name" : invalid.startsWith("cwd") ? "cwd" : "maxConcurrent";
      setFieldIndex(FIELD_ORDER.indexOf(focusKey));
      return;
    }
    const payload = mode === "edit" ? buildTeamUpdatePatch(values, !rolesLocked) : buildTeamSpec(values);
    setBusy(true);
    void onSubmit(payload).then(onClose).catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    // Footer buttons invoke their own native click on Enter/Space.  The form
    // field-walk must not reinterpret a focused Cancel as another submit.
    if (typeof Element !== "undefined" && ev.target instanceof Element && ev.target.closest("button")) return;
    if (ev.key === "Enter") { ev.preventDefault(); submit(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(FIELD_ORDER.length - 1, i + 1)); return; }
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); requestClose(); }
  };

  const field = (key: FieldKey, label: string, placeholder = "", locked = false) => (
    <div className={styles.field}>
      <span className={key === activeKey ? styles.labelActive : styles.label}>{label}</span>
      {key === "cwd" ? (
        <PathPicker
          ref={(el) => { inputRefs.current[key] = el; }}
          className={key === activeKey ? styles.inputActive : styles.input}
          value={values[key]}
          onChange={set(key)}
          mode="directory"
          placeholder={placeholder}
          disabled={locked}
          onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
          dataAttr="team-cwd"
        />
      ) : key === "role" && roleOptions !== null ? (
        <span className={styles.roleSelectBox}>
          <select
            ref={(el) => { inputRefs.current[key] = el; }}
            className={key === activeKey ? styles.inputActive : styles.input}
            value={values.role}
            disabled={locked}
            onChange={(e) => set("role")(e.target.value)}
            onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
            data-field="role"
          >
            {/* An unresolvable current value (a stale prefill, or one typed before role.list
                loaded) stays selectable rather than silently swapping to the first option. */}
            {roleOptions.includes(values.role) === false && values.role
              ? <option value={values.role}>{values.role} (unknown)</option>
              : null}
            {(visibleRoleOptions ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button
            type="button"
            className={styles.roleAdvancedBtn}
            disabled={locked}
            onClick={() => setShowAdvancedRoles((v) => !v)}
            data-team-role-advanced={showAdvancedRoles ? "on" : "off"}
          >
            {showAdvancedRoles ? "▾ simple" : "▸ advanced"}
          </button>
        </span>
      ) : (
        <input
          ref={(el) => { inputRefs.current[key] = el; }}
          className={key === activeKey ? styles.inputActive : styles.input}
          value={values[key]}
          placeholder={placeholder}
          disabled={locked}
          onChange={(e) => set(key)(e.target.value)}
          onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
          data-field={key}
        />
      )}
    </div>
  );

  const editing = mode === "edit";

  return (
    <OverlayCard width={620} align="center" onClose={requestClose} escGuard={() => confirmClose}>
      <div onKeyDown={onKeyDown}>
        <OverlayCardHeader
          title={editing ? `edit team · ${values.name}` : "create team"}
          hint={error ? <span className={styles.error}>{error}</span> : "↑↓ fields · enter next · esc cancel"}
        />
        <div className={styles.fields}>
          {field("name", "name", "", editing)}
          <div className={styles.pair}>
            {field("role", "role", "", editing && rolesLocked)}
            {field("maxConcurrent", "max concurrent")}
          </div>
          {field("cwd", "cwd", "", editing && rolesLocked)}
          <div className={styles.pair}>
            {field("queue", "queue", "bind a queue (optional)")}
            {field("purpose", "purpose", "optional")}
          </div>
          <div className={styles.pair}>
            {field("model", "model", "optional, e.g. claude-sonnet-5", editing && rolesLocked)}
            {field("persistent", "persistent", "optional, true/false", editing && rolesLocked)}
          </div>
          {field("instructions", "instructions", "optional role prompt", editing && rolesLocked)}
          {editing && rolesLocked && (
            <div className={styles.error}>roles are locked while a member is running — edit maxConcurrent/queue/purpose only</div>
          )}
        </div>
        <div className={styles.footer}>
          <ChipButton className={styles.submitChip} onClick={submit} disabled={busy} data-team-submit>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.submitVerb}> {editing ? "save" : "create"}</span>
          </ChipButton>
          <ChipButton className={styles.cancelChip} onClick={requestClose} data-team-cancel>esc cancel</ChipButton>
        </div>
      </div>
      {confirmClose && <ConfirmCard
        title="⚠ discard changes"
        body={`This ${editing ? "edit" : "team"} has unsaved edits. Closing now discards them.`}
        note="This cannot be undone."
        confirmLabel="confirm discard"
        onConfirm={onClose}
        onClose={() => setConfirmClose(false)}
      />}
    </OverlayCard>
  );
}
