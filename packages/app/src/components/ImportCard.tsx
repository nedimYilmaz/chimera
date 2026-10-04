import { useEffect, useRef, useState } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { PathPicker } from "./PathPicker";
import { isBlankProjectForm, validateImportForm, type ImportFormValues } from "../state/selectors.projects";
import { rpcCall } from "../rpc/bridge";
import { preferredProviderModel } from "../state/providerModels";
import type { ProviderCatalogEntry } from "./SpawnCard";
import styles from "./ImportCard.module.css";

// W7 — the import/new-project form (mock showProjectForm, 539-560): OverlayCard
// center 640 mounted in the projects DETAIL pane host. Fields source* (git URL
// or local path — the mock's hint line spells the rule) / name / assign team
// (optional, datalist over team.list names); enter walks the fields and the
// final enter submits project.import; clone/validation errors surface INLINE
// (header hint) — the command layer additionally raises the error toast.
// esc cancels (OverlayCard), mod+o re-toggles (the opener-key convention).
//
// PROJECT-DEFAULT-DIR: `source` left empty (with a name given) routes to a
// BLANK project.create instead — the resolved <importDirHint>/<name> path
// previews live under the source field so the "where does this land" question
// never needs a separate lookup.

// Text-field navigation is separate from native select/checkbox keyboard behavior.
type FieldKey = "source" | "name" | "team";
const FIELD_ORDER: readonly FieldKey[] = ["source", "name", "team"];

export function ImportCard({ teams, importDirHint, onSubmit, onClose }: {
  teams: readonly string[];
  /** config.projectImportDir (null = unset/unloaded — falls back to the same
   * literal placeholder Settings uses). */
  importDirHint: string | null;
  onSubmit: (values: ImportFormValues) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<ImportFormValues>({ source: "", name: "", team: "", gitInit: true, permissionProfile: "full" });
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRefs = useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({});
  const [catalog, setCatalog] = useState<readonly ProviderCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const [liveModels, setLiveModels] = useState<{ account: string; models: readonly string[] } | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const connected = catalog.filter((entry) => entry.accounts.length > 0);
  const provider = providerChoice ?? connected.find((entry) => entry.id === "claude")?.id ?? connected[0]?.id ?? "auto";
  const permissionProfile = values.permissionProfile;
  const entry = connected.find((row) => row.id === provider);
  const account = entry?.accounts.find((row) => row.name === values.conductorAccount)?.name ?? entry?.accounts[0]?.name ?? "";
  const models = liveModels && liveModels.account === account ? liveModels.models : entry?.models ?? [];
  const model = values.conductorModel && models.includes(values.conductorModel)
    ? values.conductorModel : preferredProviderModel(provider, models, entry?.defaultModel ?? "");

  useEffect(() => {
    let alive = true;
    setCatalogLoading(true);
    setCatalogError(null);
    rpcCall<ProviderCatalogEntry[]>("providers.list", {}).then((rows) => {
      if (!alive) return;
      if (!Array.isArray(rows)) throw new Error("Provider catalog is unavailable");
      setCatalog(rows);
    }).catch((err: unknown) => {
      if (alive) setCatalogError(err instanceof Error ? err.message : "Could not load providers");
    }).finally(() => { if (alive) setCatalogLoading(false); });
    return () => { alive = false; };
  }, [reload]);

  useEffect(() => {
    if (!account) { setModelsLoading(false); return; }
    let alive = true;
    setModelsLoading(true);
    rpcCall<{ models: string[] }>("providers.models", { provider, account }).then((res) => {
      if (alive && Array.isArray(res?.models) && res.models.length) setLiveModels({ account, models: res.models });
    }).catch(() => {}).finally(() => { if (alive) setModelsLoading(false); });
    return () => { alive = false; };
  }, [provider, account]);


  const activeKey = FIELD_ORDER[fieldIndex]!;
  useEffect(() => {
    inputRefs.current[activeKey]?.focus();
  }, [activeKey]);

  const set = (key: FieldKey) => (v: string) => {
    setValues((s) => ({ ...s, [key]: v }));
    if (error) setError(null);
  };

  // `direct` skips the enter-walks-fields step: the footer's "enter import"
  // CHIP click must submit immediately from ANY field (W7 review: it used to
  // just advance focus, needing two clicks), while the keyboard enter keeps
  // the field-walk convention.
  const submit = (direct = false): void => {
    if (busy || catalogLoading || catalogError || modelsLoading || (provider !== "auto" && !account)) return;
    if (!direct && fieldIndex < FIELD_ORDER.length - 1) { setFieldIndex(fieldIndex + 1); return; }
    const invalid = validateImportForm(values);
    if (invalid) {
      setError(invalid);
      setFieldIndex(FIELD_ORDER.indexOf(invalid.startsWith("name") ? "name" : "source"));
      return;
    }
    setBusy(true);   // a git clone can take a while — freeze double-submits
    void onSubmit({ ...values, permissionProfile, conductorAccount: account || undefined, conductorModel: provider === "auto" ? undefined : model || undefined }).then(onClose).catch((err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err));
    });
  };

  const onKeyDown = (ev: React.KeyboardEvent): void => {
    if (ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLButtonElement || (ev.target instanceof HTMLInputElement && ev.target.type === "checkbox")) return;
    if (ev.key === "Enter") { ev.preventDefault(); submit(); return; }
    if (ev.key === "ArrowUp") { ev.preventDefault(); setFieldIndex((i) => Math.max(0, i - 1)); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); setFieldIndex((i) => Math.min(FIELD_ORDER.length - 1, i + 1)); return; }
    if (ev.key.toLowerCase() === "n" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); onClose(); }
  };

  const field = (key: FieldKey, label: string, placeholder = "", accent = false, list?: string) => (
    <div className={styles.field}>
      <span className={accent ? styles.labelAccent : key === activeKey ? styles.labelActive : styles.label}>{label}</span>
      {key === "source" ? (
        <PathPicker
          ref={(el) => { inputRefs.current[key] = el; }}
          className={key === activeKey ? styles.inputActive : styles.input}
          value={values[key]}
          onChange={set(key)}
          mode="directory"
          placeholder={placeholder}
          onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
          dataAttr="import-source"
        />
      ) : (
        <input
          ref={(el) => { inputRefs.current[key] = el; }}
          className={key === activeKey ? styles.inputActive : styles.input}
          value={values[key]}
          placeholder={placeholder}
          list={list}
          onChange={(e) => set(key)(e.target.value)}
          onFocus={() => setFieldIndex(FIELD_ORDER.indexOf(key))}
          data-field={key}
        />
      )}
    </div>
  );

  return (
    <OverlayCard width={640} align="center" onClose={onClose}>
      <div onKeyDown={onKeyDown} data-project-import>
        <OverlayCardHeader
          title="import / new project"
          hint={error ? <span className={styles.error}>{error}</span> : busy ? "importing…" : "↑↓ fields · esc cancel"}
        />
        <div className={styles.fields}>
          {field("source", "source", "git@github.com:acme/data-pipeline.git", true)}
          <div className={styles.sourceHint}>
            {isBlankProjectForm(values) && values.name.trim()
              ? `blank project → ${importDirHint ?? "$CHIMERA_HOME/projects"}/${values.name.trim()}`
              : "a local folder path works too (~/code/proj) — or leave empty + name a blank project"}
          </div>
          {isBlankProjectForm(values) && (
            <div className={styles.field}>
              <span className={styles.label}>git</span>
              <label className={styles.gitInitToggle}>
                <input
                  type="checkbox"
                  checked={values.gitInit ?? true}
                  onChange={(e) => setValues((s) => ({ ...s, gitInit: e.target.checked }))}
                />
                <span>initialize git repository</span>
                <span className={styles.gitInitHint}>
                  {(values.gitInit ?? true)
                    ? "— seeds a commit"
                    : "— off = plain folder (no git; checkpoints/worktree isolation need git)"}
                </span>
              </label>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="project-provider">provider</label>
            <select id="project-provider" data-import-provider className={styles.input} value={provider} disabled={busy || catalogLoading} onChange={(e) => {
              setProviderChoice(e.target.value);
              setValues((v) => ({ ...v, conductorAccount: undefined, conductorModel: undefined }));
            }}>
              <option value="auto">auto (global default)</option>
              {connected.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="project-account">account</label>
            <select id="project-account" data-import-account className={styles.input} value={account} disabled={busy || !entry} onChange={(e) => {
              setValues((v) => ({ ...v, conductorAccount: e.target.value, conductorModel: undefined }));
            }}>
              {!entry && <option value="">global default</option>}
              {entry?.accounts.map((row) => <option key={row.name} value={row.name}>{row.name}</option>)}
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="project-model">model</label>
            <select id="project-model" data-import-model className={styles.input} value={model} disabled={busy || !entry || modelsLoading} onChange={(e) => setValues((v) => ({ ...v, conductorModel: e.target.value }))}>
              {!model && <option value="">provider default</option>}
              {(models.length ? models : model ? [model] : []).map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <div className={styles.sourceHint}>
            {catalogLoading ? "loading providers…" : modelsLoading ? "loading account models…" : "Your project's agent starts with these choices; other project settings stay automatic."}
            {catalogError && <span role="alert" className={styles.error}>{catalogError} <button type="button" onClick={() => setReload((v) => v + 1)}>retry</button></span>}
          </div>
          <div className={styles.field}>
            <span className={styles.label}>permission</span>
            <select
              className={styles.input}
              data-import-permission
              value={permissionProfile ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setValues((s) => ({ ...s, permissionProfile: v ? (v as ImportFormValues["permissionProfile"]) : undefined }));
              }}
            >
              <option value="">project default (global config)</option>
              <option value="readOnly">readOnly</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="full">full — no approval prompts</option>
            </select>
          </div>
          <div className={styles.permissionHint}>
            The project agent is a conductor with full autonomy and team management enabled. Full permissions are selected by default for every provider.
          </div>
          <div className={styles.pair}>
            {field("name", "name", "derived from source")}
            {field("team", "assign team", "team ▾ (optional)", false, "import-team-options")}
          </div>
          <datalist id="import-team-options">
            {teams.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.submitChip} disabled={busy || catalogLoading || !!catalogError || modelsLoading || (provider !== "auto" && !account)} onClick={() => submit(true)} data-import-submit>
            <span className={styles.submitKey}>enter</span>
            <span className={styles.submitVerb}> import</span>
          </button>
          <button type="button" className={styles.cancelChip} onClick={onClose}>esc cancel</button>
          <span className={styles.spacer} />
          <span className={styles.note}>after import: assign a team → run with r</span>
        </div>
      </div>
    </OverlayCard>
  );
}
