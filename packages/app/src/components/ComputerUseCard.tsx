import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { BuiltInsStatusResultSchema, type BuiltInState, type BuiltInStatus, type BuiltInsStatusResult, type McpStoreMonitor } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { ChipButton } from "./ChipButton";
import styles from "./ComputerUseCard.module.css";

export type ComputerUseStatus = {
  configured: boolean; driverSource?: "bundled" | "override" | null; running: boolean; autoStart?: boolean; permissionOwner: string;
  accessibility: boolean | null; screenRecording: boolean | null;
  existingProfileAllowed?: boolean; existingProfileActive?: boolean;
};
type Request = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const nativeRequest: Request = (command, args) => invoke(command, args);
const readMonitor = () => rpcCall<McpStoreMonitor>("mcpstore.monitor", {});
// Operator RPCs: the daemon owns what the installer shipped and the first-use Laya download.
const readBuiltIns = () => rpcCall<BuiltInsStatusResult>("computerUse.builtins.status", {});
const installBuiltIn = (id: "laya") => rpcCall<{ started: boolean }>("computerUse.builtins.install", { id });

const BUILT_IN_NAME: Record<BuiltInStatus["id"], string> = { laya: "Laya", "chimera-browser": "Browser sessions", "chimera-desktop": "Desktop control" };
const BUILT_IN_STATE: Record<BuiltInState, string> = {
  ready: "Ready", "not-installed": "Not installed", installing: "Installing…", failed: "Install failed",
  "unsupported-platform": "Not supported on this platform", unavailable: "Missing from this install", "name-taken": "Not registered",
};
// Laya's PyTorch stack and models are not in the installer, so "not installed" must say so instead of
// leaving anyone to wonder why the tool is absent.
const builtInDetail = (i: BuiltInStatus): string | undefined =>
  i.reason ?? (i.state === "installing" ? "Downloading Laya's Python packages and models. This can take a while." : undefined);
/** Same selectAgent+selectTab pair every other "go to this agent" affordance dispatches. */
const openAgentTranscript = (agentId: string): boolean => {
  if (!appStore.getState().agents[agentId]) return false;
  appStore.dispatch({ type: "selectAgent", agentId });
  appStore.dispatch({ type: "selectTab", tab: "agents" });
  return true;
};

export function ComputerUseCard({ request = nativeRequest, read = readMonitor, openAgent = openAgentTranscript, builtInsStatus = readBuiltIns, installBuiltInTool = installBuiltIn }: {
  request?: Request;
  read?: () => Promise<McpStoreMonitor>;
  openAgent?: (agentId: string) => boolean;
  builtInsStatus?: () => Promise<BuiltInsStatusResult>;
  installBuiltInTool?: (id: "laya") => Promise<unknown>;
}) {
  const available = request !== nativeRequest || isTauri();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [builtIns, setBuiltIns] = useState<BuiltInsStatusResult | null>(null);
  // A ref, not an effect dependency: callers pass inline lambdas and a changed identity must not
  // restart the poll loop on every render.
  const builtInsRead = useRef(builtInsStatus);
  builtInsRead.current = builtInsStatus;
  // Anything that is not a well-formed status (older daemon, transport error) is treated as "no
  // built-in information" rather than rendered half-parsed.
  const readManaged = async (): Promise<BuiltInsStatusResult | null> => {
    try { const parsed = BuiltInsStatusResultSchema.safeParse(await builtInsRead.current()); return parsed.success ? parsed.data : null; }
    catch { return null; }
  };
  const inFlight = useRef(false);
  const revision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [profileConsent, setProfileConsent] = useState<boolean | null>(null);
  const [profileAcknowledged, setProfileAcknowledged] = useState(false);
  const profileButton = useRef<HTMLButtonElement>(null);
  const restoreProfileFocus = useRef(false);
  useEffect(() => {
    if (profileConsent === null && !busy && restoreProfileFocus.current) { restoreProfileFocus.current = false; profileButton.current?.focus(); }
  }, [profileConsent, busy]);
  const requestProfileChange = (allowed: boolean) => { setProfileConsent(allowed); setProfileAcknowledged(false); setError(""); };
  const closeProfileConsent = () => { restoreProfileFocus.current = true; setProfileConsent(null); };
  const applyProfileChange = async () => {
    if (inFlight.current || profileConsent === null || (profileConsent && !profileAcknowledged)) return;
    inFlight.current = true; revision.current++; setBusy(true); setError(""); setNotice("");
    try {
      setStatus(await request("computer_use_browser_access", { allowed: profileConsent }) as ComputerUseStatus);
      setNotice(profileConsent ? "Existing browser access is saved. Retry the browser action when desktop control is running." : "Existing browser access has been removed.");
      closeProfileConsent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Intent may have been saved before a failed restart. Never render it as active consent.
      try { setStatus(await request("computer_use_status") as ComputerUseStatus); } catch { /* retain the original failure */ }
    } finally { inFlight.current = false; setBusy(false); }
  };
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
          // Separate from the native read: an unreachable daemon must not hide the permission state.
          const managed = await readManaged();
          if (active && version === revision.current && managed) setBuiltIns(managed);
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
  const installLaya = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await installBuiltInTool("laya"); setBuiltIns(await readManaged() ?? builtIns); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const desktopBuiltIn = builtIns?.integrations.find(i => i.id === "chimera-desktop");
  const notConfiguredLabel = desktopBuiltIn?.state === "unsupported-platform" ? "Not supported" : desktopBuiltIn?.state === "unavailable" ? "Reinstall required" : "Not available";
  const missingPermissions = status?.accessibility === false || status?.screenRecording === false;
  const label = !available ? "Desktop app required" : !status ? (error ? "Unavailable" : "Checking…") : !status.configured ? notConfiguredLabel
    : missingPermissions ? "Permissions required" : status.running ? "Running" : "Stopped";
  return <section className={styles.card} data-computer-use aria-label="Chimera Computer Use" aria-busy={busy}>
    <div className={styles.heading}><strong>Chimera Computer Use</strong><span role="status">{label}</span></div>
    <p>Claude and Codex can use Laya for decisions, separate browser sessions, and shared desktop control. Desktop access belongs to Chimera.</p>
    {builtIns?.managed && <ul className={styles.builtIns} aria-label="Built-in integrations" data-built-ins>
      {builtIns.integrations.map(i => {
        const detail = builtInDetail(i);
        return <li key={i.id} data-built-in={i.id} data-built-in-state={i.state}>
          <strong>{BUILT_IN_NAME[i.id]}</strong>
          <span className={styles.badge} data-built-in-badge>Built-in</span>
          <span>{BUILT_IN_STATE[i.state]}{i.version ? ` · v${i.version}` : ""}</span>
          {i.id === "laya" && (i.state === "not-installed" || i.state === "failed") && <ChipButton disabled={busy} onClick={() => void installLaya()}>{i.state === "failed" ? "Retry Laya install" : "Install Laya"}</ChipButton>}
          {detail && <small>{detail}</small>}
        </li>;
      })}
    </ul>}
    {status?.configured && <div className={styles.permissions}>
      <span>Permission owner: <strong>{status.permissionOwner}</strong></span>
      {status.accessibility !== null && <span>Accessibility: {status.accessibility ? "allowed" : "required"}</span>}
      {status.screenRecording !== null && <span>Screen Recording: {status.screenRecording ? "allowed" : "required"}</span>}
    </div>}
    {available && status?.configured && typeof status.existingProfileAllowed === "boolean" && <div className={styles.browserAccess}>
      <strong>Existing browser profiles</strong>
      <span data-browser-access-state>{status.existingProfileActive ? (status.existingProfileAllowed ? "Allowed · active" : "Still active · restart required") : status.existingProfileAllowed ? (status.running ? "Saved · not active" : "Allowed for next start") : "Not allowed"}</span>
      <p>Control signed-in Chrome and Chromium profiles, including their open pages and sessions. Separate browser sessions do not need this permission.</p>
      <div className={styles.actions}>
        <ChipButton ref={profileButton} disabled={busy} aria-expanded={profileConsent !== null} onClick={() => requestProfileChange(!(status.existingProfileAllowed || status.existingProfileActive))} data-browser-access>
          {status.existingProfileAllowed || status.existingProfileActive ? "Remove browser access" : "Allow existing browser access"}
        </ChipButton>
        {status.running && status.existingProfileAllowed && !status.existingProfileActive && <ChipButton disabled={busy} onClick={() => requestProfileChange(true)}>Apply browser access</ChipButton>}
      </div>
      {profileConsent !== null && <fieldset className={styles.consent} data-browser-consent disabled={busy}>
        <legend>{profileConsent ? "Allow your signed-in browser profiles?" : "Remove existing browser access?"}</legend>
        <p>{status.running ? "Desktop control will restart. An in-progress browser action may be interrupted; retry it afterwards. Chimera and your agents stay open." : "This choice applies when you start desktop control. It will not start automatically now."}</p>
        {profileConsent && <label><input type="checkbox" checked={profileAcknowledged} onChange={e => setProfileAcknowledged(e.target.checked)} /> I allow desktop agents to read and act in my signed-in browser profiles.</label>}
        <div className={styles.actions}>
          <ChipButton disabled={busy || (profileConsent && !profileAcknowledged)} onClick={() => void applyProfileChange()} data-browser-consent-confirm>{profileConsent ? (status.running ? "Allow and restart desktop control" : "Save browser access") : (status.running ? "Remove and restart desktop control" : "Remove access")}</ChipButton>
          <ChipButton disabled={busy} onClick={closeProfileConsent} data-browser-consent-cancel>Cancel</ChipButton>
        </div>
      </fieldset>}
    </div>}
    {available && <div className={styles.actions}>
      <ChipButton disabled={busy || !status?.configured || status.running} onClick={() => void act("computer_use_start")}>Start desktop control</ChipButton>
      <ChipButton disabled={busy || !status?.running} onClick={() => void act("computer_use_stop")}>Stop desktop control</ChipButton>
      {status?.accessibility !== null && status?.configured && <ChipButton disabled={busy} onClick={() => void act("computer_use_permissions")}>Allow Chimera access</ChipButton>}
      <ChipButton disabled={busy || !status?.running} onClick={() => void watch()}>Watch desktop activity</ChipButton>
      <ChipButton disabled={busy} onClick={() => void act("computer_use_status")}>Refresh</ChipButton>
    </div>}
    {status?.configured && <p>{status.autoStart ? "Desktop control will start automatically when Chimera opens. Stop turns off automatic startup." : "Starting desktop control saves your choice for future launches."}</p>}
    {status && !status.configured && <p>{desktopBuiltIn?.reason ?? "Desktop control is not part of this build of Chimera."}</p>}
    {notice && <p>{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
