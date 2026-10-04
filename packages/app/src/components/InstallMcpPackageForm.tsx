import { useEffect, useRef, useState } from "react";
import { McpPackageInspectParams, McpPackageInstallParams, type McpPackageReview, type McpPackageInstall } from "@chimera/protocol";
import styles from "../screens/SettingsScreen.module.css";

type Props = {
  inspect: (input: { packageName: string; version: string }) => Promise<McpPackageReview>;
  install: (input: McpPackageInstall) => Promise<void>;
  onDone: () => void;
  onBusyChange?: (busy: boolean) => void;
};

/** No implicit install on Enter during inspection: review and execution are separate steps. */
export function InstallMcpPackageForm({ inspect, install, onDone, onBusyChange }: Props) {
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("");
  const [name, setName] = useState("");
  const [bin, setBin] = useState("");
  const [args, setArgs] = useState("[]");
  const [review, setReview] = useState<McpPackageReview | null>(null);
  const [busy, setBusy] = useState<"inspect" | "install" | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => { onBusyChange?.(busy !== null); }, [busy, onBusyChange]);
  useEffect(() => () => { generation.current++; }, []);
  const invalidate = () => { generation.current++; setReview(null); setError(""); };
  const message = (e: unknown) => e && typeof e === "object" && "message" in e ? String(e.message) : "Package request failed. Try again.";

  const inspectPackage = async () => {
    if (running.current) return;
    const parsed = McpPackageInspectParams.safeParse({ packageName: packageName.trim(), version: version.trim() });
    if (!parsed.success) { setError("Enter a public npm package name and exact version, such as 1.2.3. Tags, URLs and ranges are not supported."); return; }
    const attempt = ++generation.current;
    running.current = true; setBusy("inspect"); setError(""); setReview(null);
    try {
      const result = await inspect(parsed.data);
      if (attempt !== generation.current) return;
      setReview(result); setBin(result.bins[0] ?? "");
      if (!name) setName(parsed.data.packageName.split("/").at(-1)!.replace(/[^a-z0-9-]/g, "-").slice(0, 64));
    } catch (e) { if (attempt === generation.current) setError(message(e)); }
    finally { running.current = false; setBusy(null); }
  };

  const installPackage = async () => {
    if (!review || running.current) return;
    let argv: unknown;
    try { argv = JSON.parse(args); } catch { setError('Arguments must be a JSON string array, for example ["/path/to/project"].'); return; }
    const parsed = McpPackageInstallParams.safeParse({ reviewId: review.reviewId, name: name.trim(), bin, args: argv });
    if (!parsed.success) { setError("Choose a lowercase server name, an executable and a JSON array of string arguments."); return; }
    if (review.expiresAt <= Date.now()) { setReview(null); setError("Review expired. Inspect the package again."); return; }
    running.current = true; setBusy("install"); setError("");
    const attempt = generation.current;
    try { await install(parsed.data); if (generation.current === attempt) onDone(); }
    catch (e) { setError(message(e)); }
    finally { running.current = false; setBusy(null); }
  };

  return <section className={styles.addForm} aria-label="Install MCP package" aria-busy={busy !== null}>
    <p>Install into Chimera’s shared MCP store, independently of Claude or Codex. Public npm packages with JavaScript executables are supported.</p>
    <label className={styles.formRow}><span className={styles.formLabel}>npm package</span><input className={styles.input} aria-label="npm package" value={packageName} disabled={busy !== null} placeholder="@scope/mcp-server" onChange={(e) => { invalidate(); setPackageName(e.target.value); }} /></label>
    <label className={styles.formRow}><span className={styles.formLabel}>Exact version</span><input className={styles.input} aria-label="Exact version" value={version} disabled={busy !== null} placeholder="1.2.3" onChange={(e) => { invalidate(); setVersion(e.target.value); }} /></label>
    <button className={styles.ghostBtn} type="button" disabled={busy !== null} onClick={() => void inspectPackage()}>{busy === "inspect" ? "inspecting…" : "inspect package"}</button>
    {review && <>
      <p>{review.packageName}@{review.version} · {review.license ?? "license not declared"}</p>
      <details><summary>Package integrity</summary><code style={{ overflowWrap: "anywhere" }}>{review.integrity}</code></details>
      <p className={styles.warn}>Third-party code will run with your OS user’s access when enabled. This is not a sandbox. Installation scripts are disabled{review.hasInstallScripts ? "; this package declares scripts and may not work without them" : ""}.</p>
      <label className={styles.formRow}><span className={styles.formLabel}>Server name</span><input className={styles.input} aria-label="Server name" value={name} disabled={busy !== null} onChange={(e) => setName(e.target.value)} /></label>
      <label className={styles.formRow}><span className={styles.formLabel}>Executable</span><select className={styles.input} aria-label="Executable" value={bin} disabled={busy !== null} onChange={(e) => setBin(e.target.value)}>{review.bins.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>
      <label className={styles.formRow}><span className={styles.formLabel}>Arguments (JSON)</span><textarea className={styles.input} aria-label="Arguments (JSON)" value={args} disabled={busy !== null} onChange={(e) => setArgs(e.target.value)} /></label>
      <p>Installed disabled, with untrusted tool results. Review the server, then enable it in the store. Do not put credentials in arguments.</p>
      <button className={styles.ghostBtn} type="button" disabled={busy !== null} onClick={() => void installPackage()}>{busy === "install" ? "installing… (up to 3 minutes)" : "install disabled"}</button>
    </>}
    {error && <p role="alert" className={styles.danger}>{error}</p>}
  </section>;
}
