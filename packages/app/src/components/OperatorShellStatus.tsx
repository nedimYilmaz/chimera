import { settingsErrorMessage } from "./AgentSettingsCard";
import { useEffect, useState } from "react";
import { ShellCommandRecordSchema, type ShellCommandRecord } from "@chimera/protocol/contract";
import { rpcCall } from "../rpc/bridge";
import { useStore } from "../state/useStore";
import styles from "./Composer.module.css";

export function OperatorShellStatus({ agentId }: { agentId: string }) {
  const connected = useStore(s => s.connected);
  const revision = useStore(s => s.agents[agentId]?.transcript.filter(t => t.role === "tool" && t.toolName === "operator_shell").map(t => t.role === "tool" ? `${t.toolId}:${t.status}:${t.result ?? ""}` : "").join(",") ?? "");
  const [record, setRecord] = useState<ShellCommandRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    if (connected) void rpcCall<ShellCommandRecord | null>("agent.shellStatus", { agentId }).then(r => {
      const parsed = r === null ? null : ShellCommandRecordSchema.parse(r);
      if (!disposed) { setRecord(parsed); setError(null); }
    }).catch(e => { if (!disposed && revision) setError(settingsErrorMessage(e)); });
    return () => { disposed = true; };
  }, [agentId, connected, revision]);
  const cancel = async (): Promise<void> => {
    if (!record) return;
    try { await rpcCall("agent.shellCancel", { agentId, requestId: record.requestId }); }
    catch (e) { setError(settingsErrorMessage(e)); }
  };
  if (!record && !error) return null;
  return <div className={styles.shellStatus} data-operator-shell>
    {record && <details open={record.state === "running"}>
      <summary>! Bash · {record.state}{record.exitCode !== null ? ` · exit ${record.exitCode}` : ""} · {record.command.slice(0, 120)}</summary>
      <div>{record.cwd}</div>
      <pre>{record.output || (record.state === "running" ? "Running…" : "(no output)")}{record.truncated ? "\n[output truncated]" : ""}</pre>
      {record.error && <div role="status">{record.error}</div>}
      {record.deliveryError && <div role="alert">{record.deliveryError}</div>}
    </details>}
    {record?.state === "running" && <button type="button" disabled={!connected} onClick={() => void cancel()}>Cancel command</button>}
    {error && <div role="alert">{error}</div>}
  </div>;
}
