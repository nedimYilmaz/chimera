import { useEffect, useRef, useState } from "react";
import type { JobSudoPlanResult } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { writeClipboard } from "../state/copyOnSelect";

export function ScheduleSudoSetup({ target }: { target: unknown }) {
  const key = JSON.stringify(target);
  const latest = useRef(key);
  latest.current = key;
  const [plan, setPlan] = useState<{ key: string; value: JobSudoPlanResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  useEffect(() => () => { latest.current = "closed"; }, []);
  const prepare = async () => {
    if (busy) return;
    setBusy(true); setError(null); setCopied("");
    try {
      const value = await rpcCall<JobSudoPlanResult>("job.sudoPlan", { target });
      if (latest.current === key) setPlan({ key, value });
    } catch (e) {
      if (latest.current === key) setError(e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? "Could not prepare sudo setup"));
    } finally { setBusy(false); }
  };
  const current = plan?.key === key ? plan.value : null;
  const copy = async (text: string, label: string) => {
    const ok = await writeClipboard(text);
    if (latest.current === key) setCopied(ok ? `${label} copied. Run it in your system terminal.` : "Copy failed; select and copy the script below.");
  };
  return <div data-sudo-setup style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <p>One-time authorization is required on the daemon's machine (macOS/Linux). Your system terminal asks for confirmation and your sudo password. Chimera never stores it. Scheduled runs never prompt for a password.</p>
    <p>Command, directory, environment or timeout changes need new authorization. Disabling/deleting a job does not remove its OS authorization; keep the revoke script. Referenced files/scripts can still change.</p>
    <button type="button" data-sudo-prepare disabled={busy} onClick={() => void prepare()}>{busy ? "preparing…" : "prepare sudo authorization"}</button>
    {error && <p role="alert">{error}</p>}
    {plan && !current && <p>Settings changed. Prepare a new authorization for this command.</p>}
    {current && <>
      <p>Preview only — no command has run and no permission has been changed.</p>
      <button type="button" data-sudo-copy onClick={() => void copy(current.authorizeScript, "Authorization script")}>copy authorization script</button>{" "}
      <button type="button" data-sudo-revoke onClick={() => void copy(current.revokeScript, "Revoke script")}>copy revoke script</button>
      <details><summary>Review authorization script</summary><pre style={{ whiteSpace: "pre-wrap" }}>{current.authorizeScript}</pre></details>
      <details><summary>Review revoke script</summary><pre style={{ whiteSpace: "pre-wrap" }}>{current.revokeScript}</pre></details>
    </>}
    {current && copied && <p role="status">{copied}</p>}
  </div>;
}
