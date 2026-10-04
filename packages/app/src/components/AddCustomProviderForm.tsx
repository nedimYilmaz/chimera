import { useState } from "react";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { getSettingsCommands } from "../state/commands.settings";
import { maskKey } from "../state/selectors.settings";
import styles from "../screens/SettingsScreen.module.css";

const cmds = getSettingsCommands(appStore, rpcCall);

export function validateCustomProvider(input: {
  id: string; label: string; baseUrl: string; defaultModel: string;
}, existingIds: readonly string[]): string | null {
  if (!input.id) return "id is required";
  if (!/^[A-Za-z0-9_-]+$/.test(input.id)) return "id may contain only letters, digits, _ and -";
  if (existingIds.includes(input.id)) return `provider id “${input.id}” already exists`;
  if (!input.label) return "display label is required";
  if (!input.defaultModel) return "default model is required";
  try {
    const parsed = new URL(input.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "base URL must use http or https";
  } catch {
    return "enter a valid base URL including port/path when needed";
  }
  return null;
}

export function AddCustomProviderForm({ existingIds, onDone }: {
  existingIds: readonly string[];
  onDone: () => void;
}) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [requiresKey, setRequiresKey] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy) return;
    const clean = {
      id: id.trim(), label: label.trim(), baseUrl: baseUrl.trim().replace(/\/$/, ""),
      defaultModel: defaultModel.trim(),
    };
    const invalid = validateCustomProvider(clean, existingIds);
    if (invalid) { setError(invalid); return; }
    setError(null);
    setBusy(true);
    const ok = await cmds.addCustomProvider({ ...clean, requiresKey, key });
    setBusy(false);
    if (ok) { setKey(""); onDone(); }
  };

  return <div className={styles.addForm} data-custom-provider-form>
    <div className={styles.addHead}>
      <span className={styles.addTitle}>new custom provider</span>
      <span className={styles.spacer} />
      <span className={styles.faint}>live immediately · no restart</span>
    </div>
    <div className={styles.formGrid}>
      <Field label="stable id" value={id} onChange={setId} attr="data-custom-provider-id" autoFocus />
      <Field label="label" value={label} onChange={setLabel} attr="data-custom-provider-label" />
      <Field label="base URL" value={baseUrl} onChange={setBaseUrl} attr="data-custom-provider-url" placeholder="http://127.0.0.1:11434/v1" />
      <Field label="model" value={defaultModel} onChange={setDefaultModel} attr="data-custom-provider-model" />
      <label className={styles.formRow}>
        <span className={styles.formLabel}>auth</span>
        <input type="checkbox" checked={requiresKey} onChange={(e) => setRequiresKey(e.target.checked)} data-custom-provider-requires-key />
        <span>requires API key</span>
      </label>
      {requiresKey && <label className={styles.formRow}>
        <span className={styles.formLabelKey}>api key</span>
        <input className={styles.inputKey} type="password" value={key} onChange={(e) => setKey(e.target.value)} data-custom-provider-key />
        <span className={styles.faint}>{key ? maskKey(key.length) : "optional — add an account later"}</span>
      </label>}
    </div>
    {error && <div className={styles.formError} data-custom-provider-error>{error}</div>}
    <div className={styles.addActions}>
      <button className={styles.primaryBtn} disabled={busy} onClick={() => void submit()} data-custom-provider-save>save custom provider</button>
      <button className={styles.ghostBtn} disabled={busy} onClick={onDone}>cancel</button>
      <span className={styles.faint}>model discovery runs now; the default is used only if the endpoint is unreachable</span>
    </div>
  </div>;
}

function Field({ label, value, onChange, attr, placeholder, autoFocus }: {
  label: string; value: string; onChange: (value: string) => void; attr: string; placeholder?: string; autoFocus?: boolean;
}) {
  return <label className={styles.formRow}>
    <span className={styles.formLabel}>{label}</span>
    <input className={styles.input} value={value} placeholder={placeholder} autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)} {...{ [attr]: true }} />
  </label>;
}
