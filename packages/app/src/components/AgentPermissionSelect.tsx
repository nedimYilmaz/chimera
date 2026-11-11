import { settingsErrorMessage } from "./AgentSettingsCard";
import { useEffect, useState } from "react";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import styles from "./TranscriptPanel.module.css";

/** A common control; each backend implements and acknowledges its own mode contract. */
export function AgentPermissionSelect({ agentId, provider, executionMode, requestedMode, modePending, disabled }: {
  agentId: string; provider?: string; value?: string; executionMode?: string; requestedMode?: string; modePending?: boolean; disabled: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actual = modePending ? requestedMode : executionMode;
  const [confirmed, setConfirmed] = useState(actual);
  const [waiting, setWaiting] = useState(!!modePending);
  useEffect(() => { setConfirmed(actual); setWaiting(!!modePending); }, [actual, modePending, agentId]);
  const change = async (selection: string): Promise<void> => {
    setPending(selection); setError(null);
    try {
      const result = await rpcCall<{ applied?: string[]; executionModePending?: boolean }>("agent.reconfigure", {
        agentId, live: { executionMode: selection },
        // Choosing Full access is an explicit operator grant, never an ambient default.
        ...(provider === "codex" && selection === "bypassPermissions" ? { patch: { acknowledgeCodexFullAccessRisk: true } } : {}),
      });
      if (!result.applied?.includes("executionMode")) throw new Error("The daemon did not acknowledge the requested mode");
      setConfirmed(selection); setWaiting(!!result.executionModePending);
      const records = await rpcCall<unknown[]>("agent.list", {});
      appStore.dispatch({ type: "agentRecords", records: records as never });
    } catch (e) { setError(settingsErrorMessage(e)); }
    finally { setPending(null); }
  };
  const selected = pending ?? confirmed ?? "";
  const applying = pending !== null || waiting;
  const hint = provider === "claude" ? "Native Claude review mode; Chimera tool restrictions remain separate."
    : provider === "codex" ? "Codex Auto uses workspace write with approvals; Plan uses native planning and read-only access; Full access removes the sandbox. Applies on the next turn."
    : provider === "kimi" ? "Native Kimi Auto or Full access (yolo). Kimi has no native Plan mode."
    : "Chimera-managed mode: Auto allows edits with configured approvals, Plan allows inspection tools only, Full access allows tools subject to configured policy.";
  return <span className={styles.permissionSelect} data-agent-permission data-mode={selected} data-applying={applying}>
    <span className={styles.permissionField}>
    <select aria-label="Execution mode" title={hint + " Provider policy still applies. Stopped agents save the choice for their next launch."}
      value={selected} aria-busy={applying} disabled={disabled || pending !== null}
      onChange={e => void change(e.target.value)}>
      {!confirmed && <option value="" disabled>Mode…</option>}
      <option value="auto">Auto</option>
      {provider !== "kimi" && <option value="plan">Plan</option>}
      <option value="bypassPermissions">Full access</option>
      {confirmed === "execute" && <option value="execute" disabled>Execute · configured mode</option>}
    </select>
    {applying && <span className={styles.permissionSpinner} role="status" aria-label="Applying execution mode" />}
    </span>
    {error && <span role="alert">{error}</span>}
  </span>;
}
