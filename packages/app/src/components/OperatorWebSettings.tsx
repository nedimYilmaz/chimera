import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isUnknownMethod } from "@chimera/ui-state";
import type { OperatorWebStatus, OperatorWebSettings } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { ChipButton } from "./ChipButton";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { dismissRegisteredOverlays, registerOverlay, type OverlayProps } from "./OverlayOutlet";
import styles from "../screens/SettingsScreen.module.css";
let pairingOpen = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
export const closeOperatorPair = () => { pairingOpen = false; emit(); };
export const openOperatorPair = () => { dismissRegisteredOverlays(); pairingOpen = true; emit(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const message = (e: unknown) => typeof e === "object" && e && "message" in e ? String(e.message) : String(e);
export function OperatorWebSettings() {
  const [status, setStatus] = useState<OperatorWebStatus | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [unsupported, setUnsupported] = useState(false);
  const [settings, setSettings] = useState<OperatorWebSettings | null>(null); const mounted = useRef(true);
  const load = async () => {
    try { const s = await rpcCall<OperatorWebStatus>("operatorweb.status", {}); if (mounted.current) { setStatus(s); setSettings(old => old ?? s.settings); setError(null); } }
    catch (e) { if (mounted.current) { if (isUnknownMethod(e)) setUnsupported(true); else setError(message(e)); } }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, []);
  const run = async (method: string, params = {}) => { if (busy) return; setBusy(true); setError(null); try { await rpcCall(method, params); await load(); } catch (e) { if (mounted.current) setError(message(e)); } finally { if (mounted.current) setBusy(false); } };
  return <section className={styles.card} data-operator-settings>
    <div className={styles.cardHead}><span className={styles.cardTitle}>Remote operator panel</span><span>{status ? status.enabled ? "Enabled · loopback" : "Off" : unsupported ? "Unavailable" : "Loading…"}</span></div>
    {unsupported && <p>This daemon does not support the operator panel.</p>}
    {error && <p role="alert">{error} <ChipButton disabled={busy} onClick={() => { void load(); }}>Retry</ChipButton></p>}
    {status && <>
      <p className={styles.faint}>{status.limitation}</p>
      {!status.bundleAvailable && <p>Panel bundle not built. Build the app before connecting a device.</p>}
      <ChipButton disabled={busy} onClick={() => { void run(status.enabled ? "operatorweb.disable" : "operatorweb.enable"); }}>{busy ? "Working…" : status.enabled ? "Disable panel and revoke devices" : "Enable loopback panel"}</ChipButton>
      {status.enabled && <><p>Local URL: <span>{status.localUrl}</span></p><p>Remote access: {status.settings.publicOrigin ?? "No HTTPS origin configured. Use the existing tunnel settings separately."}</p><ChipButton data-operator-pair-open disabled={busy || !status.bundleAvailable} onClick={openOperatorPair}>Pair device</ChipButton></>}
      <details><summary>Device sessions · {status.sessions.length}</summary>
        <ChipButton disabled={busy || !status.sessions.length} onClick={() => { void run("operatorweb.sessionRevoke", { id: null }); }}>Revoke all devices</ChipButton>
        <ChipButton disabled={busy} onClick={() => { void load(); }}>Refresh sessions</ChipButton>
        {status.sessions.map(s => <div key={s.id} className={styles.metaRow}><span>{s.deviceLabel} · {s.project} · {s.scope === "control" ? "Control" : "Read only"} · expires {new Date(s.expiresAt).toLocaleString()}</span><ChipButton data-operator-revoke disabled={busy} onClick={() => { void run("operatorweb.sessionRevoke", { id: s.id }); }}>Revoke</ChipButton></div>)}
      </details>
      <details><summary>Transport and expiry settings (disable panel to edit)</summary>{settings && <>
        <label className={styles.kvRow}>HTTPS proxy origin<input disabled={status.enabled || busy} placeholder="https://your-owner-managed-host" value={settings.publicOrigin ?? ""} onChange={e => setSettings({ ...settings, publicOrigin: e.target.value || null })} /></label>
        <label className={styles.kvRow}>Idle expiry (1–30 minutes)<input type="number" min={1} max={30} disabled={status.enabled || busy} value={settings.idleMin} onChange={e => setSettings({ ...settings, idleMin: Number(e.target.value) })} /></label>
        <label className={styles.kvRow}>Absolute expiry (up to 24 hours)<input type="number" min={0.01} max={24} step={0.01} disabled={status.enabled || busy} value={settings.absoluteH} onChange={e => setSettings({ ...settings, absoluteH: Number(e.target.value) })} /></label>
        <ChipButton disabled={status.enabled || busy} onClick={() => { void run("operatorweb.settingsSet", settings); }}>Save transport settings</ChipButton>
      </>}</details>
      <p className={styles.faint}>Sessions revoke on daemon restart; enabling is always explicit. Codes are entered manually. No public listener or tunnel is activated.</p>
    </>}
  </section>;
}
function PairForm() {
  const [projects, setProjects] = useState<Array<{ name: string }>>([]), [project, setProject] = useState(""), [control, setControl] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: number; project: string; scope: string } | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const load = async () => { try { const ps = await rpcCall<Array<{ name: string; archived?: boolean }>>("project.list", {}); if (mounted.current) { const active = ps.filter(p => !p.archived); setProjects(active); setProject(p => p || active[0]?.name || ""); setError(null); } } catch (e) { if (mounted.current) setError(message(e)); } };
  useEffect(() => { mounted.current = true; void load(); const tick = setInterval(() => setNow(Date.now()), 1000); return () => { mounted.current = false; clearInterval(tick); }; }, []);
  const expired = code && now >= code.expiresAt;
  return <OverlayCard width={560} onClose={closeOperatorPair} dismissOnReplacement><OverlayCardHeader title="Pair an operator device" /><div className={styles.card} data-operator-pair>
    <p>Pair only a device you control. This code grants access to one project for the displayed expiry.</p>
    <label>Project<select autoFocus value={project} disabled={busy || !!code} onChange={e => setProject(e.target.value)}>{projects.map(p => <option key={p.name}>{p.name}</option>)}</select></label>
    <label><input type="checkbox" checked={control} disabled={busy || !!code} onChange={e => setControl(e.target.checked)} />Allow control: pause/resume, send messages, add/cancel tasks, answer approvals and questions</label>
    {code && <div><p>{code.project} · {code.scope === "control" ? "Control" : "Read only"}</p>{expired ? <p role="status">Code expired. Generate a new code.</p> : <><code data-operator-pair-code>{code.code}</code><p role="status">Expires in {Math.max(0, Math.ceil((code.expiresAt - now) / 1000))} seconds. Single use; enter it on the device. Never put it in a URL.</p></>}</div>}
    {error && <p role="alert">{error}<ChipButton onClick={() => { void load(); }}>Retry projects</ChipButton></p>}
    <ChipButton data-operator-generate disabled={busy || !project} onClick={() => { if (busy) return; setBusy(true); setError(null); void rpcCall<typeof code>("operatorweb.pairStart", { project, allowControl: control }).then(c => { if (mounted.current) setCode(c); }).catch(e => { if (mounted.current) setError(message(e)); }).finally(() => { if (mounted.current) setBusy(false); }); }}>{busy ? "Generating…" : code ? "Replace pairing code" : "Generate pairing code"}</ChipButton><ChipButton onClick={closeOperatorPair}>Close</ChipButton>
  </div></OverlayCard>;
}
export function OperatorPairCard({ host }: OverlayProps) { const open = useSyncExternalStore(subscribe, () => pairingOpen); return host === "settings" && open ? <PairForm /> : null; }
registerOverlay("operator-pair", OperatorPairCard, closeOperatorPair);
