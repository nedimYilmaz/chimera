import { useEffect, useState } from "react";
import { rpcCall } from "../rpc/bridge";
import { LoadStatusNote } from "./LoadStatusNote";
import { useLoadStatus } from "../state/loadStatus";
import { configureLocalStt, loadLocalStt, sttLoadStatus, useLocalStt } from "../voice/localStt";
import styles from "../screens/SettingsScreen.module.css";

export function LocalSpeechSettings() {
  const { status, appleLocales } = useLocalStt(); const load = useLoadStatus(sttLoadStatus);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const installing = !!status && ["downloading", "verifying", "building"].includes(status.install.state);
  useEffect(() => { if (!installing) return; const timer = setInterval(() => { void loadLocalStt(); }, 1000); return () => clearInterval(timer); }, [installing]);
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(null); try { await work(); await loadLocalStt(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const whisper = status?.engines.find(e => e.id === "whisper-cpp");
  return <section data-local-speech-settings style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <LoadStatusNote status={load} what="local speech availability" hasRows={!!status} onRetry={() => { void loadLocalStt(); }} />
    {load.unsupported && <p>Local speech is unavailable with this daemon version.</p>}
    {status && <>
      <p className={styles.faint}>Hold the composer mic, release to insert into your draft, then review and send. Audio stays on this machine. Whisper: up to 60 seconds; Apple: up to 30 seconds. No cloud fallback.</p>
      <label className={styles.kvRow}>local input engine <select className={styles.select} data-stt-engine disabled={busy || installing} value={status.preferences.engine ?? ""} onChange={e => { void run(() => configureLocalStt((e.target.value || null) as "apple-on-device" | "whisper-cpp" | null, status.preferences.language)); }}>
        <option value="">First ready local engine</option>
        <option value="whisper-cpp" disabled={!whisper?.installed}>Whisper local {whisper?.installed ? "" : "(install required)"}</option>
        <option value="apple-on-device" disabled={!appleLocales.length}>Apple on-device {appleLocales.length ? "" : "(unavailable)"}</option>
      </select></label>
      <label className={styles.kvRow}>dictation language <select className={styles.select} data-stt-language disabled={busy || installing} value={status.preferences.language} onChange={e => { void run(() => configureLocalStt(status.preferences.engine, e.target.value as "en" | "tr")); }}>
        <option value="en">English</option><option value="tr">Turkish</option>
      </select></label>
      <p className={styles.faint}>English and Turkish passed the bundled synthetic Whisper fixtures. Other languages have not been verified. Apple requires a matching on-device system locale; availability varies by OS.</p>
      <details data-stt-install-details><summary>Install local model · {(status.model.bytes / 1_000_000).toFixed(0)} MB · multilingual small</summary>
        <p className={styles.faint}>Whisper {status.model.runtimeVersion} · {status.model.license} · source build needs CMake and a C++ compiler. Nothing downloads at startup.</p>
        <p className={styles.faint}>Model SHA-256: {status.model.sha256}<br />Runtime source SHA-256: {status.model.runtimeSha256}<br />Path: {status.model.path}</p>
        {whisper?.reason && <p>{whisper.reason}</p>}
        {installing ? <><progress data-stt-progress value={status.install.progress} max={1} /><span aria-live="polite"> {status.install.state} · {Math.round(status.install.progress * 100)}%</span><button className={styles.ghostBtn} data-stt-cancel disabled={busy} onClick={() => { void run(() => rpcCall("stt.installCancel")); }}>Cancel install</button></> : whisper?.installed ? <button className={styles.ghostBtn} data-stt-remove disabled={busy} onClick={() => { void run(() => rpcCall("stt.uninstall")); }}>Remove local runtime and model</button> : <button className={styles.primaryBtn} data-stt-install disabled={busy || !whisper?.available} onClick={() => { void run(() => rpcCall("stt.install", { engine: "whisper-cpp", model: "small-q5_1" })); }}>{status.install.state === "failed" ? "Retry install" : "Install local model"}</button>}
        {!whisper?.installed && whisper?.reason?.includes("needs repair") && <button className={styles.ghostBtn} data-stt-remove disabled={busy} onClick={() => { void run(() => rpcCall("stt.uninstall")); }}>Remove invalid local installation</button>}
        {status.install.error && <p role="alert">{status.install.error}</p>}
      </details>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
