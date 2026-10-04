import { useEffect, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ConfirmCard } from "./ConfirmCard";
import { CAPABILITY_NOTES } from "../copy";
import styles from "./RoleFormCard.module.css";
import { EffortLevelSchema } from "@chimera/protocol";

// ROLES-TAB S5 (spec §2), widened by ROLES-UNIFY S5 (docs/superpowers/specs/
// 2026-07-28-roles-unify.md §6.2): the unified-library role create/edit card.
// Editable fields are RoleUpdateRequestSchema's practical v1 patch set
// (contract.ts) — the original 6 (model, permissionProfile, instructions,
// plugins, mcpToolAllowlist, skills) plus effort/account/provider/maxTurns/
// turnLimitPolicy/isolation/persistent/poolSize as plain fields, and
// orchestration/inherit/on/providerOptions/mcpServers as raw-JSON textareas
// (same escape-hatch pattern plugins/mcpToolAllowlist already use — §6.2
// deliberately skips bespoke widgets for this rarely-touched nested config) —
// plus `name` (locked once created; RoleSpecSchema's `name` is the record's
// identity). skills stays a comma-separated list (RoleSpec.skills: string[]).
//
// §2's template-truth honesty note is a PERMANENT header line, not a tooltip:
// editing a role changes every FUTURE spawn, not any agent already running
// from it — `liveCount` (the usage join, computed by the caller at form-open)
// makes that concrete.

export type RoleFormValues = {
  name: string;
  model: string;
  permissionProfile: "" | "readOnly" | "acceptEdits" | "full";
  // AGENT-AUTONOMY: "" = inherit the schema default ("ask"); "full" = no ask_human/ask_agent/
  // ask_team, no AskUserQuestion — see claude.ts's autonomyLine for what this actually silences.
  autonomy: "" | "ask" | "full";
  instructions: string;
  plugins: string;            // JSON textarea — PluginConfig[]
  mcpToolAllowlist: string;   // JSON textarea — Record<string, string[]>
  skills: string;             // comma-separated
  effort: "" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  account: string;
  provider: string;
  maxTurns: string;           // numeric text
  turnLimitPolicy: "" | "fail" | "soft";
  isolation: "" | "none" | "worktree";
  persistent: boolean;
  poolSize: string;           // numeric text
  orchestration: string;      // JSON textarea — {allow, maxDepth}
  inherit: string;            // JSON textarea — {settingSources}
  on: string;                 // JSON textarea — {permissionRequest}
  providerOptions: string;    // JSON textarea
  mcpServers: string;         // JSON textarea
};

const jsonTextOf = (v: unknown, fallback: string): string => (v !== undefined ? JSON.stringify(v, null, 2) : fallback);

export function roleFormValuesFromSpec(spec: Record<string, unknown>): RoleFormValues {
  const skills = Array.isArray(spec["skills"]) ? (spec["skills"] as unknown[]).filter((s) => typeof s === "string") : [];
  return {
    name: typeof spec["name"] === "string" ? (spec["name"] as string) : "",
    model: typeof spec["model"] === "string" ? (spec["model"] as string) : "",
    permissionProfile: (spec["permissionProfile"] as RoleFormValues["permissionProfile"]) ?? "",
    autonomy: (spec["autonomy"] as RoleFormValues["autonomy"]) ?? "",
    instructions: typeof spec["instructions"] === "string" ? (spec["instructions"] as string) : "",
    plugins: spec["plugins"] ? JSON.stringify(spec["plugins"], null, 2) : "[]",
    mcpToolAllowlist: spec["mcpToolAllowlist"] ? JSON.stringify(spec["mcpToolAllowlist"], null, 2) : "{}",
    skills: skills.join(", "),
    effort: (spec["effort"] as RoleFormValues["effort"]) ?? "",
    account: typeof spec["account"] === "string" ? (spec["account"] as string) : "",
    provider: typeof spec["provider"] === "string" ? (spec["provider"] as string) : "",
    maxTurns: typeof spec["maxTurns"] === "number" ? String(spec["maxTurns"]) : "",
    turnLimitPolicy: (spec["turnLimitPolicy"] as RoleFormValues["turnLimitPolicy"]) ?? "",
    isolation: (spec["isolation"] as RoleFormValues["isolation"]) ?? "",
    persistent: spec["persistent"] === true,
    poolSize: typeof spec["poolSize"] === "number" ? String(spec["poolSize"]) : "",
    orchestration: jsonTextOf(spec["orchestration"], "{}"),
    inherit: jsonTextOf(spec["inherit"], "{}"),
    on: jsonTextOf(spec["on"], "{}"),
    providerOptions: jsonTextOf(spec["providerOptions"], "{}"),
    mcpServers: jsonTextOf(spec["mcpServers"], "{}"),
  };
}

function parseJsonField(label: string, raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function parseOptionalInt(label: string, raw: string): number | undefined {
  if (!raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${label} must be a whole number`);
  return n;
}

/** Parses the form into a role spec payload; throws a short message on
 * invalid JSON/name/number so the card can show it inline. */
export function buildRoleSpecPayload(values: RoleFormValues): Record<string, unknown> {
  if (!values.name.trim()) throw new Error("name is required");
  const plugins = parseJsonField("plugins", values.plugins) ?? [];
  const mcpToolAllowlist = parseJsonField("mcpToolAllowlist", values.mcpToolAllowlist) ?? {};
  const orchestration = parseJsonField("orchestration", values.orchestration);
  const inherit = parseJsonField("inherit", values.inherit);
  const on = parseJsonField("on", values.on);
  const providerOptions = parseJsonField("providerOptions", values.providerOptions);
  const mcpServers = parseJsonField("mcpServers", values.mcpServers);
  const maxTurns = parseOptionalInt("maxTurns", values.maxTurns);
  const poolSize = parseOptionalInt("poolSize", values.poolSize);
  return {
    name: values.name.trim(),
    model: values.model.trim() || undefined,
    permissionProfile: values.permissionProfile || undefined,
    autonomy: values.autonomy || undefined,
    instructions: values.instructions,
    plugins,
    mcpToolAllowlist,
    skills: values.skills.split(",").map((s) => s.trim()).filter(Boolean),
    effort: values.effort || undefined,
    account: values.account.trim() || undefined,
    provider: values.provider.trim() || undefined,
    maxTurns,
    turnLimitPolicy: values.turnLimitPolicy || undefined,
    isolation: values.isolation || undefined,
    persistent: values.persistent,
    poolSize,
    orchestration,
    inherit,
    on,
    providerOptions,
    mcpServers,
  };
}

export function RoleFormCard({ mode = "create", initial, liveCount = 0, onSubmit, onClose }: {
  mode?: "create" | "edit";
  initial?: RoleFormValues;
  /** §2: live agents currently spawned from this role — 0 for a create form. */
  liveCount?: number;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<RoleFormValues>(
    initial ?? {
      name: "", model: "", permissionProfile: "", autonomy: "", instructions: "", plugins: "[]", mcpToolAllowlist: "{}", skills: "",
      effort: "", account: "", provider: "", maxTurns: "", turnLimitPolicy: "", isolation: "", persistent: false, poolSize: "",
      orchestration: "{}", inherit: "{}", on: "{}", providerOptions: "{}", mcpServers: "{}",
    },
  );
  const initialRef = useRef(values);
  const dirty = JSON.stringify(values) !== JSON.stringify(initialRef.current);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = (): void => { if (dirty) setConfirmClose(true); else onClose(); };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const editing = mode === "edit";
  useEffect(() => { if (!editing) nameRef.current?.focus(); }, [editing]);

  const set = <K extends keyof RoleFormValues>(key: K) => (v: RoleFormValues[K]) => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  const submit = (): void => {
    if (busy) return;
    let payload: Record<string, unknown>;
    try {
      payload = buildRoleSpecPayload(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    void onSubmit(payload).then(onClose).catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit(); return; }
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); requestClose(); }
  };

  return (
    <OverlayCard width={620} align="center" onClose={requestClose} escGuard={() => confirmClose}>
      <div onKeyDown={onKeyDown}>
        <OverlayCardHeader
          title={editing ? `edit role · ${values.name}` : "create role"}
          hint={error ? <span className={styles.error}>{error}</span> : "⌘/ctrl+enter save · esc cancel"}
        />
        <div className={styles.honesty} data-role-honesty-note>
          template edit — applies from the next spawn. {liveCount} running agent{liveCount === 1 ? "" : "s"} from this role keep{liveCount === 1 ? "s" : ""} their current spec.
        </div>
        <div className={styles.fields}>
          <div className={styles.field}>
            <span className={styles.label}>name</span>
            <input
              ref={nameRef}
              className={styles.input}
              value={values.name}
              disabled={editing}
              onChange={(e) => set("name")(e.target.value)}
              data-field="name"
            />
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.label}>model</span>
              <input className={styles.input} value={values.model} placeholder="optional — the account\u2019s provider default when blank"
                onChange={(e) => set("model")(e.target.value)} data-field="model" />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>permission profile</span>
              <select className={styles.input} value={values.permissionProfile}
                onChange={(e) => set("permissionProfile")(e.target.value as RoleFormValues["permissionProfile"])} data-field="permissionProfile">
                <option value="">(default)</option>
                <option value="readOnly">readOnly</option>
                <option value="acceptEdits">acceptEdits</option>
                <option value="full">full</option>
              </select>
            </div>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>autonomy</span>
            <select className={styles.input} value={values.autonomy}
              onChange={(e) => set("autonomy")(e.target.value as RoleFormValues["autonomy"])} data-field="autonomy">
              <option value="">(default · ask)</option>
              <option value="full">full · no ask_human/ask_agent/ask_team, no questions</option>
            </select>
          </div>
          {values.autonomy === "full" && (
            <div className={styles.fieldNote} data-autonomy-full-note>
              A full-autonomy agent gets no ask_human/ask_agent/ask_team and no AskUserQuestion dialogs — it decides
              on its own. This does not disable the cloud-mutation, host-tool, or foreign-MCP approval gates.
            </div>
          )}
          <div className={styles.field}>
            <span className={styles.label}>instructions</span>
            <textarea className={styles.textarea} rows={4} value={values.instructions}
              placeholder="optional role prompt" onChange={(e) => set("instructions")(e.target.value)} data-field="instructions" />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>skills</span>
            <input className={styles.input} value={values.skills} placeholder="comma-separated, e.g. code-review:ai-review-agentic"
              onChange={(e) => set("skills")(e.target.value)} data-field="skills" />
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.label}>effort</span>
              <select className={styles.input} value={values.effort}
                onChange={(e) => set("effort")(e.target.value as RoleFormValues["effort"])} data-field="effort">
                {/* EFFORT-ONE-SOURCE: a role is provider-neutral (its binding chooses one later),
                    so this is the one picker that legitimately offers the FULL wire vocabulary
                    rather than a provider's subset — derived, never restated. */}
                <option value="">(default)</option>
                {EffortLevelSchema.options.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>isolation</span>
              <select className={styles.input} value={values.isolation}
                onChange={(e) => set("isolation")(e.target.value as RoleFormValues["isolation"])} data-field="isolation">
                <option value="">(default)</option>
                <option value="none">none</option>
                <option value="worktree">worktree</option>
              </select>
            </div>
          </div>
          {values.provider.trim() === "kimi" && (
            <div className={styles.kimiNote} data-kimi-effort-note>{CAPABILITY_NOTES.kimiEffortDowngrade}</div>
          )}
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.label}>account</span>
              <input className={styles.input} value={values.account} placeholder="optional, e.g. auto"
                onChange={(e) => set("account")(e.target.value)} data-field="account" />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>provider</span>
              <input className={styles.input} value={values.provider} placeholder="optional, e.g. claude"
                onChange={(e) => set("provider")(e.target.value)} data-field="provider" />
            </div>
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.label}>max turns</span>
              <input className={styles.input} value={values.maxTurns} placeholder="optional"
                onChange={(e) => set("maxTurns")(e.target.value)} data-field="maxTurns" />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>turn limit policy</span>
              <select className={styles.input} value={values.turnLimitPolicy}
                onChange={(e) => set("turnLimitPolicy")(e.target.value as RoleFormValues["turnLimitPolicy"])} data-field="turnLimitPolicy">
                <option value="">(default)</option>
                <option value="fail">fail</option>
                <option value="soft">soft</option>
              </select>
            </div>
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.label}>persistent</span>
              <input type="checkbox" checked={values.persistent}
                onChange={(e) => set("persistent")(e.target.checked)} data-field="persistent" />
            </div>
            <div className={styles.field}>
              <span className={styles.label}>pool size</span>
              <input className={styles.input} value={values.poolSize} placeholder="optional"
                onChange={(e) => set("poolSize")(e.target.value)} data-field="poolSize" />
            </div>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>plugins (JSON)</span>
            <textarea className={styles.textarea} rows={3} value={values.plugins}
              onChange={(e) => set("plugins")(e.target.value)} data-field="plugins" />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>mcpToolAllowlist (JSON)</span>
            <textarea className={styles.textarea} rows={3} value={values.mcpToolAllowlist}
              onChange={(e) => set("mcpToolAllowlist")(e.target.value)} data-field="mcpToolAllowlist" />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>mcpServers (JSON)</span>
            <textarea className={styles.textarea} rows={3} value={values.mcpServers}
              onChange={(e) => set("mcpServers")(e.target.value)} data-field="mcpServers" />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>orchestration (JSON)</span>
            <textarea className={styles.textarea} rows={2} value={values.orchestration}
              onChange={(e) => set("orchestration")(e.target.value)} data-field="orchestration" />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>inherit (JSON)</span>
            <textarea className={styles.textarea} rows={2} value={values.inherit}
              onChange={(e) => set("inherit")(e.target.value)} data-field="inherit" />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>on (JSON)</span>
            <textarea className={styles.textarea} rows={2} value={values.on}
              onChange={(e) => set("on")(e.target.value)} data-field="on" />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>providerOptions (JSON)</span>
            <textarea className={styles.textarea} rows={2} value={values.providerOptions}
              onChange={(e) => set("providerOptions")(e.target.value)} data-field="providerOptions" />
          </div>
        </div>
        <div className={styles.footer}>
          <span className={styles.submitChip} onClick={submit} data-role-submit>
            <span className={styles.submitKey}>⌘⏎</span>
            <span className={styles.submitVerb}> {editing ? "save" : "create"}</span>
          </span>
          <span className={styles.cancelChip} onClick={requestClose}>esc cancel</span>
        </div>
      </div>
      {confirmClose && <ConfirmCard
        title="⚠ discard changes"
        body={`This ${editing ? "edit" : "role"} has unsaved edits. Closing now discards them.`}
        note="This cannot be undone."
        confirmLabel="confirm discard"
        onConfirm={onClose}
        onClose={() => setConfirmClose(false)}
      />}
    </OverlayCard>
  );
}
