import { useCallback, useEffect, useRef, useState } from "react";
import { rpcCall } from "../rpc/bridge";
import { useStore } from "../state/useStore";
import { displayName } from "../state/selectors";
import { ChipButton } from "./ChipButton";
import styles from "../screens/SettingsScreen.module.css";
import own from "./SecretsSection.module.css";

type Grant = { agentId: string; mode: "inject" | "reveal"; agentLabel?: string };
type Secret = { name: string; description: string | null; updatedAt: number; grants: Grant[] };
type Change = { method: "secret.delete" | "secret.set"; name: string };

export function SecretsSection() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [confirmation, setConfirmation] = useState<Change | null>(null);
  const [notice, setNotice] = useState("");
  const agents = useStore((s) => s.agents);
  const liveAgents = Object.values(agents).filter((a) => !a.shadow && (a.state === "running" || a.state === "paused"));
  const label = (id: string, fallback?: string): string => agents[id] ? displayName(agents[id]) : fallback || id.slice(0, 8);
  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await rpcCall<{ secrets: Secret[] }>("secret.list", {});
      setSecrets(res.secrets); setError(null);
    } catch { setError("Could not load secrets. Try refreshing."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const guard = async (fn: () => Promise<unknown>, success: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setNotice("");
    try { await fn(); setNotice(success); await load(); }
    // Do not echo provider errors: a failed keychain write may include its input.
    catch { setError("The change could not be saved. Refresh to verify the current state before retrying."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const save = (): void => {
    void guard(async () => {
      await rpcCall("secret.set", { name: name.trim(), value, ...(description.trim() ? { description: description.trim() } : {}) });
      setName(""); setValue(""); setDescription(""); setCreating(false); setConfirmation(null);
    }, "Secret stored. Its value will not be displayed again.");
  };
  const visible = secrets.filter((s) => `${s.name} ${s.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const cancelForm = (): void => { setCreating(false); setValue(""); setName(""); setDescription(""); setConfirmation(null); };
  return <section className={own.root} aria-label="Secret store">
    <header className={own.header}>
      <div><h2>Secret store</h2><p>Stored in macOS Keychain. Values are write-only; access is granted per agent.</p></div>
      <div className={own.actions}><ChipButton disabled={busy} onClick={() => void load()}>Refresh</ChipButton><ChipButton disabled={busy} aria-expanded={creating} onClick={() => creating ? cancelForm() : setCreating(true)}> {creating ? "Cancel new secret" : "+ New secret"}</ChipButton></div>
    </header>
    {error ? <div role="alert" className={styles.error}>{error}</div> : null}
    {notice ? <div role="status" className={own.notice}>{notice}</div> : null}
    {creating ? <form className={own.form} onSubmit={(e) => { e.preventDefault(); if (busy || !name.trim() || !value) return; if (secrets.some((s) => s.name === name.trim())) setConfirmation({ method: "secret.set", name: name.trim() }); else save(); }} onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); cancelForm(); } }}>
      <label>Name<input className={styles.input} placeholder="aws/prod-key" value={name} disabled={busy} onChange={(e) => { setName(e.target.value); setConfirmation(null); }} data-secret-name autoComplete="off" /></label>
      <label>Secret value<input className={styles.input} type="password" value={value} disabled={busy} onChange={(e) => setValue(e.target.value)} data-secret-value autoComplete="new-password" /></label>
      <label className={own.wide}>Description (optional)<input className={styles.input} placeholder="What is this used for?" value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} data-secret-desc /></label>
      {confirmation?.method === "secret.set" ? <div className={own.wide} role="group" aria-label="Confirm replacement"><p>Replace the stored value for <strong>{confirmation.name}</strong>? Existing grants remain.</p><ChipButton disabled={busy} onClick={save}>Replace value</ChipButton> <ChipButton disabled={busy} onClick={() => setConfirmation(null)}>Keep current value</ChipButton></div> : <button type="submit" className={styles.primaryBtn} disabled={busy || !name.trim() || !value} data-secret-add>Store secret</button>}
    </form> : null}
    <div className={own.toolbar}><label>Find a secret<input type="search" className={styles.input} placeholder="Search name or description" value={query} onChange={(e) => setQuery(e.target.value)} /></label><span>{visible.length} of {secrets.length} secrets</span></div>
    {loading ? <p role="status">Loading secrets…</p> : !secrets.length ? <p>No secrets stored yet. Add one, then choose which agents may use it.</p> : !visible.length ? <p>No secrets match your search.</p> : null}
    {visible.map((s) => <article className={own.entry} key={s.name} data-secret-row={s.name}>
      <div className={own.entryHead}><div><h3>{s.name}</h3>{s.description ? <p>{s.description}</p> : null}</div><span className={own.badge}>{s.grants.length ? `${s.grants.length} agent${s.grants.length === 1 ? "" : "s"} with access` : "No access granted"}</span></div>
      {s.grants.length ? <ul className={own.grants} aria-label={`Access to ${s.name}`}>{s.grants.map((g) => <li key={g.agentId}><span title={g.agentId}>{label(g.agentId, g.agentLabel)} <small>· {g.agentId.slice(0, 8)}</small></span><span className={own.mode}>{g.mode === "reveal" ? "Model can read" : "Environment · next start"}</span><ChipButton disabled={busy} aria-label={`Revoke ${label(g.agentId, g.agentLabel)} access to ${s.name}`} onClick={() => void guard(() => rpcCall("secret.revoke", { name: s.name, agent: g.agentId }), "Access revoked for future use. Already delivered values cannot be recalled.")} data-secret-revoke={`${s.name}:${g.agentId}`}>Revoke</ChipButton></li>)}</ul> : <p className={own.muted}>Only you can grant access. Agents have no access by default.</p>}
      <details className={own.manage}><summary>Manage access</summary><AccessForm key={s.name} name={s.name} busy={busy} agents={liveAgents.map((a) => ({ id: a.agentId, name: displayName(a) }))} grant={(agent, mode) => guard(() => rpcCall("secret.grant", { name: s.name, agent, mode }), "Access updated.")} />
      <div className={own.danger}>{confirmation?.method === "secret.delete" && confirmation.name === s.name ? <div role="group" aria-label={`Confirm deletion of ${s.name}`} onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); setConfirmation(null); } }}><p>Delete <strong>{s.name}</strong> and all its grants? This cannot recall values already delivered.</p><ChipButton disabled={busy} onClick={() => void guard(async () => { await rpcCall("secret.delete", { name: s.name }); setConfirmation(null); }, "Secret deleted.")}>Confirm delete</ChipButton> <ChipButton disabled={busy} onClick={() => setConfirmation(null)}>Cancel</ChipButton></div> : <ChipButton disabled={busy} onClick={() => setConfirmation({ method: "secret.delete", name: s.name })} data-secret-delete={s.name}>Delete secret…</ChipButton>}</div>
      </details>
    </article>)}
  </section>;
}

function AccessForm({ name, busy, agents, grant }: { name: string; busy: boolean; agents: { id: string; name: string }[]; grant: (id: string, mode: "inject" | "reveal") => Promise<void> }) {
  const [agent, setAgent] = useState("");
  const [mode, setMode] = useState<"inject" | "reveal">("reveal");
  const eligible = agents.some((a) => a.id === agent);
  return <form className={own.form} onSubmit={(e) => { e.preventDefault(); if (eligible && !busy) void grant(agent, mode); }}>
    <label>Agent<select className={styles.select} value={eligible ? agent : ""} onChange={(e) => setAgent(e.target.value)} disabled={busy} data-secret-grant-agent={name}><option value="">Choose an agent…</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.id.slice(0, 8)}</option>)}</select></label>
    <label>Access mode<select className={styles.select} value={mode} onChange={(e) => setMode(e.target.value as "inject" | "reveal")} disabled={busy}><option value="reveal">Model can read</option><option value="inject">Process environment</option></select></label>
    <p className={own.wide}>{!agents.length ? "No running or paused agents available. " : ""}{mode === "reveal" ? "Allows this agent to retrieve the value into its model context." : "Supplied through CHIMERA_SECRET_* at the next process start. This does not prevent agent code from accessing it."} Access ends when the agent is terminated.</p>
    <button type="submit" className={styles.primaryBtn} disabled={busy || !eligible} data-secret-grant={`${name}:${mode}`}>Grant access</button>
  </form>;
}
