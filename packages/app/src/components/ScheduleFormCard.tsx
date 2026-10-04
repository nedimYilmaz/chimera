import { useEffect, useMemo, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ConfirmCard } from "./ConfirmCard";
import { PathPicker } from "./PathPicker";
import { RoleBindingOverrideEditor } from "./RoleBindingOverrideEditor";
import { rpcCall } from "../rpc/bridge";
import { useStore } from "../state/useStore";
import {
  buildJobSpec, buildJobUpdatePatch, CATCH_UP_HELP, computeSchedulePreview, defaultScheduleFormValues, validateScheduleForm,
  type ScheduleFormValues,
} from "../state/selectors.jobs";
import styles from "./ScheduleFormCard.module.css";
import { upcomingScheduleRuns } from "../state/schedule-library";

// W15 (F14 schedules panel) — the create-schedule form (mod+o on the Queues
// screen when no queue drill is open): OverlayCard center 620, mirroring
// TeamFormCard/PushTaskCard's field-walk convention. Fields name* / target
// (team|agent|role) + its value(s) / prompt* / schedule (cron|every|at, exactly
// one) + tz / overlap / budget / enabled; a live next-run preview updates as
// the schedule fields change, and an invalid cron/at/tz surfaces inline —
// NEVER silently accepted (job.create would reject it too). Enter walks the
// fields (a <select>'s own arrow keys are left alone) and the final enter
// submits job.create; esc cancels, mod+o re-toggles (the opener-key
// convention).
//
// JOB-ROLE-TARGET: "team" gained an optional `teamRole` field — pins WHICH of
// the team's role keys the pushed task routes to (blank ⇒ the team's own
// default, byte-identical to before this existed). "role" is a THIRD target
// kind — spawns directly off a global role-library entry (RoleStore), no
// team/queue needed. JOB-ROLE-OVERRIDES: its override patch IS editable here now
// (RoleBindingOverrideEditor — the same component the Roles and Teams tabs mount),
// where before only the role's library defaults applied. Without it, "the nightly
// run but on a cheaper model" meant cloning the role, which is precisely how a
// role library accumulates near-identical entries.

type FieldKey = keyof ScheduleFormValues;
type StringFieldKey = "name" | "existingAgentId" | "team" | "teamRole" | "role" | "command" | "commandTimeoutSec" | "cwd" | "model" | "prompt" | "cron" | "everyN" | "at" | "tz" | "catchUpMaxStalenessMin" | "maxBudgetUsd";
type SelectFieldKey = "targetKind" | "scheduleKind" | "everyUnit" | "overlapPolicy" | "isolation";

function fieldOrder(v: ScheduleFormValues): FieldKey[] {
  const targetFields: FieldKey[] =
    v.targetKind === "existing" ? ["existingAgentId", "maxPendingMessages"]
    : v.targetKind === "team" ? ["team", "teamRole"]
    : v.targetKind === "role" ? ["role"]
    : v.targetKind === "command" ? ["command", "cwd", "commandTimeoutSec"]
    : ["cwd", "model", "isolation"];
  const scheduleFields: FieldKey[] =
    v.scheduleKind === "cron" ? ["cron"] : v.scheduleKind === "every" ? ["everyN", "everyUnit"] : ["at"];
  // "at" is an absolute datetime-local value resolved via Date.parse in the
  // browser's own zone (selectors.jobs.ts computeNextRunTs / buildJobSpec) —
  // tz is never consulted for it, so the field is dead weight and skipped
  // from the walk to avoid implying it affects the one-shot run time.
  const tzFields: FieldKey[] = v.scheduleKind === "at" ? [] : ["tz"];
  // JOB-COMMAND-TARGET: a command job has no prompt and no budget — walking a field the daemon
  // would reject just teaches the operator to fill in something that gets dropped.
  const agentFields: FieldKey[] = v.targetKind === "command" ? [] : ["prompt"];
  const budgetFields: FieldKey[] = v.targetKind === "command" || v.targetKind === "existing" ? [] : ["maxBudgetUsd"];
  return ["name", "targetKind", ...targetFields, ...agentFields, "scheduleKind", ...scheduleFields, ...tzFields, "overlapPolicy", "catchUp", "catchUpMaxStalenessMin", ...budgetFields, "enabled"];
}

export function ScheduleFormCard({ mode = "create", initial, onSubmit, onClose }: {
  mode?: "create" | "edit";
  initial?: ScheduleFormValues;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<ScheduleFormValues>(() => initial ?? defaultScheduleFormValues());
  const agents = useStore((s) => s.agents);
  const agentOrder = useStore((s) => s.agentOrder);
  // JOB-ROLE-OVERRIDES: the role library, so the override editor can show each field's INHERITED
  // value beside the pinned one. Same tryPhase2-style tolerance the other role surfaces use — an
  // older daemon (or a failed call) just leaves the editor showing "—" for inherited values.
  const [roleLibrary, setRoleLibrary] = useState<ReadonlyArray<Record<string, unknown>>>([]);
  useEffect(() => {
    let alive = true;
    rpcCall<Array<Record<string, unknown>>>("role.list", {})
      .then((rows) => { if (alive && Array.isArray(rows)) setRoleLibrary(rows); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const initialValuesRef = useRef(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(initialValuesRef.current);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = (): void => { if (dirty) setConfirmClose(true); else onClose(); };
  // name (index 0) is locked in edit mode — start the walk on the next field.
  const [fieldIndex, setFieldIndex] = useState(() => (mode === "edit" ? 1 : 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | HTMLSelectElement | null>>>({});

  const order = fieldOrder(values);
  const clampedIndex = Math.min(fieldIndex, order.length - 1);
  const activeKey = order[clampedIndex]!;
  useEffect(() => {
    inputRefs.current[activeKey]?.focus();
  }, [activeKey]);

  const set = <K extends FieldKey>(key: K) => (v: ScheduleFormValues[K]) => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const submit = (): void => {
    if (busy) return;
    if (clampedIndex < order.length - 1) { setFieldIndex(clampedIndex + 1); return; }
    const invalid = validateScheduleForm(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    const payload = mode === "edit" ? buildJobUpdatePatch(values) : buildJobSpec(values);
    setBusy(true);
    void onSubmit(payload).then(onClose).catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); return; }
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); requestClose(); return; }
    if ((ev.target as HTMLElement).tagName === "SELECT") return; // the dropdown owns its own arrow keys
    if (ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(order.length - 1, i + 1)); return; }
  };

  const row = (key: FieldKey, label: string, control: React.ReactNode) => (
    <div className={styles.field}>
      <span className={key === activeKey ? styles.labelActive : styles.label}>{label}</span>
      {control}
    </div>
  );

  const textField = (key: StringFieldKey, label: string, placeholder = "", locked = false) =>
    row(key, label, (
      <input
        ref={(el) => { inputRefs.current[key] = el; }}
        className={key === activeKey ? styles.inputActive : styles.input}
        value={values[key]}
        placeholder={placeholder}
        disabled={locked}
        onChange={(e) => set(key)(e.target.value)}
        onFocus={() => setFieldIndex(order.indexOf(key))}
        data-field={key}
      />
    ));

  // cwd: same row/box chrome as textField, but a PathPicker (text input +
  // native browse button) in place of the bare input.
  const cwdField = () =>
    row("cwd", "cwd", (
      <PathPicker
        ref={(el) => { inputRefs.current["cwd"] = el; }}
        className={activeKey === "cwd" ? styles.inputActive : styles.input}
        value={values.cwd}
        onChange={set("cwd")}
        mode="directory"
        placeholder="working directory"
        onFocus={() => setFieldIndex(order.indexOf("cwd"))}
        dataAttr="schedule-cwd"
      />
    ));

  const selectField = <K extends SelectFieldKey>(key: K, label: string, options: ReadonlyArray<{ value: ScheduleFormValues[K]; label: string }>) =>
    row(key, label, (
      <select
        ref={(el) => { inputRefs.current[key] = el; }}
        className={key === activeKey ? styles.inputActive : styles.input}
        value={values[key]}
        onChange={(e) => set(key)(e.target.value as ScheduleFormValues[K])}
        onFocus={() => setFieldIndex(order.indexOf(key))}
        data-field={key}
      >
        {options.map((o) => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
      </select>
    ));

  // Cron scanning must not repeat for every character typed into the prompt.
  const { preview, upcoming } = useMemo(() => {
    const now = Date.now();
    return { preview: computeSchedulePreview(values, now), upcoming: upcomingScheduleRuns(values, now) };
  }, [values.scheduleKind, values.cron, values.everyN, values.everyUnit, values.at, values.tz]);
  const editing = mode === "edit";

  return (
    <OverlayCard width={620} align="center" onClose={requestClose} escGuard={() => confirmClose}>
      <div onKeyDown={onKeyDown}>
        <OverlayCardHeader
          title={editing ? `edit job · ${values.name}` : "new schedule"}
          hint={error ? <span className={styles.error}>{error}</span> : "↑↓ fields · enter next · esc cancel"}
        />
        <div className={styles.fields}>
          {textField("name", "name", "", editing)}
          <div className={styles.pair}>
            {selectField("targetKind", "target", [
              { value: "team", label: "team" }, { value: "agent", label: "new agent" }, { value: "existing", label: "existing agent (pinned)" }, { value: "role", label: "role" }, { value: "command", label: "command (no agent)" },
            ])}
            {values.targetKind === "existing"
              ? textField("existingAgentId", "pinned agent ID", "exact agent ID")
              : values.targetKind === "team"
              ? textField("team", "team", "team name")
              : values.targetKind === "role"
              ? textField("role", "role", "role library name")
              : cwdField()}
          </div>
          {values.targetKind === "existing" && <>
            {row("maxPendingMessages", "pending message limit", <input ref={el => { inputRefs.current.maxPendingMessages = el; }} data-field="maxPendingMessages" className={activeKey === "maxPendingMessages" ? styles.inputActive : styles.input} type="number" min={1} max={1000} placeholder="unlimited" value={values.maxPendingMessages ?? ""} onFocus={() => setFieldIndex(order.indexOf("maxPendingMessages"))} onChange={e => set("maxPendingMessages")(e.target.value)} />)}
            <select aria-label="pick existing agent" value={values.existingAgentId} onChange={(e) => set("existingAgentId")(e.target.value)}>
              <option value="">select a running or paused agent…</option>
              {agentOrder.filter((id) => ["running", "paused"].includes(agents[id]?.state ?? "") && !agents[id]?.shadow).map((id) => <option key={id} value={id}>{agents[id]?.displayLabel ?? agents[id]?.label ?? id} · {id} · {agents[id]?.state}</option>)}
              {values.existingAgentId && !agentOrder.some((id) => id === values.existingAgentId && ["running", "paused"].includes(agents[id]?.state ?? "") && !agents[id]?.shadow) && <option value={values.existingAgentId}>{values.existingAgentId} (unavailable)</option>}
            </select>
            <div className={styles.help}>Pinned to this exact agent. Resumes it if paused, then sends the prompt to its mailbox without interrupting active work. Killed or missing agents disable the job; no replacement is created. Success means message accepted, not task completed. The agent's own budget and model apply.</div>
          </>}
          {values.targetKind === "team" && (
            <div className={styles.pair}>
              {textField("teamRole", "pin role", "optional — team's role key")}
            </div>
          )}
          {/* JOB-ROLE-OVERRIDES: the same binding-override editor the Roles and Teams tabs use,
              mounted for a {role, overrides} job target. Before this the form could pick a
              library role but not adjust it, so "the nightly run, but on a cheaper model" meant
              cloning the role — which is how a library ends up with five near-identical entries.
              Whole-object replace, same as every other mount; an empty patch inherits. */}
          {values.targetKind === "role" && values.role.trim() ? (
            <RoleBindingOverrideEditor
              key={values.role.trim()}
              librarySpec={roleLibrary.find((r) => r["name"] === values.role.trim())}
              overrides={values.roleOverrides}
              onSave={async (next) => { setValues((v) => ({ ...v, roleOverrides: next })); }}
            />
          ) : null}
          {values.targetKind === "agent" && (
            <div className={styles.pair}>
              {textField("model", "model", "optional")}
              {/* isolation: "none" runs the scheduled agent directly in cwd;
                  "worktree" needs a git repo at cwd (else the run fails with
                  "isolation …"). Defaults to none so it works in any cwd. */}
              {selectField("isolation", "isolation", [{ value: "none", label: "none" }, { value: "worktree", label: "worktree" }])}
            </div>
          )}
          {textField("prompt", "prompt")}
          <div className={styles.pair}>
            {selectField("scheduleKind", "schedule", [
              { value: "cron", label: "cron" }, { value: "every", label: "every" }, { value: "at", label: "at (once)" },
            ])}
            {values.scheduleKind === "cron" && textField("cron", "cron expr", "0 * * * *")}
            {values.scheduleKind === "every" && (
              <>
                {textField("everyN", "every")}
                {selectField("everyUnit", "unit", [
                  { value: "seconds", label: "seconds" }, { value: "minutes", label: "minutes" },
                  { value: "hours", label: "hours" }, { value: "days", label: "days" },
                ])}
              </>
            )}
            {values.scheduleKind === "at" && (
              <div className={styles.field}>
                <span className={activeKey === "at" ? styles.labelActive : styles.label}>at</span>
                <input
                  ref={(el) => { inputRefs.current["at"] = el; }}
                  type="datetime-local"
                  className={activeKey === "at" ? styles.inputActive : styles.input}
                  value={values.at}
                  onChange={(e) => set("at")(e.target.value)}
                  onFocus={() => setFieldIndex(order.indexOf("at"))}
                  data-field="at"
                />
              </div>
            )}
          </div>
          <div className={styles.pair}>
            {values.scheduleKind !== "at" && textField("tz", "timezone")}
            {selectField("overlapPolicy", "overlap", [{ value: "skip", label: "skip" }, { value: "queue", label: "queue" }])}
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={activeKey === "catchUp" ? styles.labelActive : styles.label}>catch-up</span>
              <input
                ref={(el) => { inputRefs.current["catchUp"] = el; }}
                type="checkbox"
                checked={values.catchUp}
                onChange={(e) => set("catchUp")(e.target.checked)}
                onFocus={() => setFieldIndex(order.indexOf("catchUp"))}
                data-field="catchUp"
              />
            </div>
            {textField("catchUpMaxStalenessMin", "limit (min)", "no limit", !values.catchUp)}
          </div>
          <div className={styles.help}>{CATCH_UP_HELP}</div>
          <div className={styles.pair}>
            {values.targetKind !== "existing" && textField("maxBudgetUsd", "budget $", "optional")}
            <div className={styles.field}>
              <span className={activeKey === "enabled" ? styles.labelActive : styles.label}>enabled</span>
              <input
                ref={(el) => { inputRefs.current["enabled"] = el; }}
                type="checkbox"
                checked={values.enabled}
                onChange={(e) => set("enabled")(e.target.checked)}
                onFocus={() => setFieldIndex(order.indexOf("enabled"))}
                data-field="enabled"
              />
            </div>
          </div>
          <div className={preview.error ? styles.previewError : styles.previewOk}>
            {preview.error ? `invalid schedule: ${preview.error}` : `next run: ${preview.nextRunTs !== null ? new Date(preview.nextRunTs).toLocaleString() : "—"}`}
            {upcoming.length > 1 && <details><summary>next {upcoming.length} runs (local time)</summary><ol>{upcoming.map(ts => <li key={ts}>{new Date(ts).toLocaleString()}</li>)}</ol></details>}
          </div>
        </div>
        <div className={styles.footer}>
          {values.targetKind !== "command" && <label><input type="checkbox" checked={values.promptTemplate ?? false} onChange={e => setValues(v => ({ ...v, promptTemplate: e.target.checked }))} />prompt variables: {"{{job}}, {{iso}}, {{ts}}, {{agentId}}"}</label>}
          <span className={styles.submitChip} onClick={submit} data-schedule-submit>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.submitVerb}> {editing ? "save" : "create"}</span>
          </span>
          <span className={styles.cancelChip} onClick={requestClose}>esc cancel</span>
        </div>
      </div>
      {confirmClose && <ConfirmCard
        title="⚠ discard changes"
        body={`This ${editing ? "edit" : "schedule"} has unsaved edits. Closing now discards them.`}
        note="This cannot be undone."
        confirmLabel="confirm discard"
        onConfirm={onClose}
        onClose={() => setConfirmClose(false)}
      />}
    </OverlayCard>
  );
}
