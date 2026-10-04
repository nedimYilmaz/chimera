import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { McpStoreMonitor } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { ChipButton } from "./ChipButton";
import styles from "./ComputerUseCard.module.css";

export type ComputerUseStatus = {
  configured: boolean; running: boolean; autoStart?: boolean; permissionOwner: string;
  accessibility: boolean | null; screenRecording: boolean | null;
};
type Request = (command: string) => Promise<unknown>;
const nativeRequest: Request = command => invoke(command);
const readMonitor = () => rpcCall<McpStoreMonitor>("mcpstore.monitor", {});
/** Same selectAgent+selectTab pair every other "go to this agent" affordance dispatches. */
const openAgentTranscript = (agentId: string): boolean => {
  if (!appStore.getState().agents[agentId]) return false;
  appStore.dispatch({ type: "selectAgent", agentId });
  appStore.dispatch({ type: "selectTab", tab: "agents" });
  return true;
};

export function ComputerUseCard({ request = nativeRequest, read = readMonitor, openAgent = openAgentTranscript }: {
  request?: Request;
  read?: () => Promise<McpStoreMonitor>;
  openAgent?: (agentId: string) => boolean;
}) {
  const available = request !== nativeRequest || isTauri();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!available) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = revision.current;
      try {
        if (!inFlight.current) {
          const result = await request("computer_use_status");
          if (active && version === revision.current) setStatus(result as ComputerUseStatus);
        }
      } catch (e) { if (active && version === revision.current) setError(String(e)); }
      finally { if (active) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [available, request]);
  const act = async (command: string) => {
    if (inFlight.current) return;
    inFlight.current = true; revision.current++; setBusy(true); setError("");
    try {
      const result = await request(command);
      if (command === "computer_use_permissions") {
        setNotice("Enable Chimera in Accessibility and Screen Recording, then fully quit and reopen Chimera so the new permissions take effect.");
        setStatus(await request("computer_use_status") as ComputerUseStatus);
      } else setStatus(result as ComputerUseStatus);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  // The live view lives inside the controlling agent's transcript, so "Watch" takes you there — or
  // says why there is nothing to watch. It never starts, resumes or re-enables desktop control.
  const watch = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const monitor = await read();
      if (!monitor.held || !monitor.owner) setNotice("No agent is controlling the desktop right now. The live view appears inside the agent's transcript while it uses the desktop.");
      else if (!openAgent(monitor.owner)) setNotice(`${monitor.ownerName ?? "The controlling agent"} is using the desktop, but its transcript is not available in this app. Open that agent to watch.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const missingPermissions = status?.accessibility === false || status?.screenRecording === false;
  const label = !available ? "Desktop app required" : !status ? (error ? "Unavailable" : "Checking…") : !status.configured ? "Setup required"
    : missingPermissions ? "Permissions required" : status.running ? "Running" : "Stopped";
  return <section className={styles.card} data-computer-use aria-label="Chimera Computer Use" aria-busy={busy}>
    <div className={styles.heading}><strong>Chimera Computer Use</strong><span role="status">{label}</span></div>
    <p>Claude and Codex can use Laya for decisions, separate browser sessions, and shared desktop control. Desktop access belongs to Chimera.</p>
    {status?.configured && <div className={styles.permissions}>
      <span>Permission owner: <strong>{status.permissionOwner}</strong></span>
      {status.accessibility !== null && <span>Accessibility: {status.accessibility ? "allowed" : "required"}</span>}
      {status.screenRecording !== null && <span>Screen Recording: {status.screenRecording ? "allowed" : "required"}</span>}
    </div>}
    {available && <div className={styles.actions}>
      <ChipButton disabled={busy || !status?.configured || status.running} onClick={() => void act("computer_use_start")}>Start desktop control</ChipButton>
      <ChipButton disabled={busy || !status?.running} onClick={() => void act("computer_use_stop")}>Stop desktop control</ChipButton>
      {status?.accessibility !== null && status?.configured && <ChipButton disabled={busy} onClick={() => void act("computer_use_permissions")}>Allow Chimera access</ChipButton>}
      <ChipButton disabled={busy || !status?.running} onClick={() => void watch()}>Watch desktop activity</ChipButton>
      <ChipButton disabled={busy} onClick={() => void act("computer_use_status")}>Refresh</ChipButton>
    </div>}
    {status?.configured && <p>{status.autoStart ? "Desktop control will start automatically when Chimera opens. Stop turns off automatic startup." : "Starting desktop control saves your choice for future launches."}</p>}
    {status && !status.configured && <p>Install the Computer Use integration to enable desktop control.</p>}
    {notice && <p>{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
