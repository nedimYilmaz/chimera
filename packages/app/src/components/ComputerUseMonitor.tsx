import { useEffect, useId, useRef, useState } from "react";
import type { McpStoreMonitor } from "@chimera/protocol";
import { rpcCall } from "../rpc/bridge";
import { computerUseAvailable, computerUseNative, type ComputerUseNative } from "../native/computerUse";
import type { ComputerUseStatus } from "./ComputerUseCard";
import { ChipButton } from "./ChipButton";
import styles from "./ComputerUseMonitor.module.css";

const MONITOR_MS = 1000;
const PREVIEW_MS = 1000;
const VISIBLE_ACTIONS = 4;

type Mode = "open" | "collapsed" | "hidden";
type Frame = { key: string; src: string; at: number };

const readMonitor = () => rpcCall<McpStoreMonitor>("mcpstore.monitor", {});

function usePageVisible(): boolean {
  const read = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const [visible, setVisible] = useState(read);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = () => setVisible(read());
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * The live desktop view for ONE transcript. It renders only while `agentId` is the authoritative
 * desktop-lease owner (`mcpstore.monitor` owner === the transcript's agent), so a user looking at
 * another agent never sees — or pays for — someone else's screen. Hiding or collapsing it only
 * stops the frame polling; it never releases control (that is the explicit Stop button).
 */
export function ComputerUseMonitor({ agentId, request = computerUseNative, read = readMonitor }: {
  agentId: string | null;
  request?: ComputerUseNative;
  read?: () => Promise<McpStoreMonitor>;
}) {
  // A plain browser has no Rust side; the injected-`request` escape hatch is the same one ComputerUseCard uses.
  const enabled = request !== computerUseNative || computerUseAvailable();
  const pageVisible = usePageVisible();
  const noteId = useId();
  const stopVersion = useRef(0);
  const refocus = useRef<"toggle" | "reopen" | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [monitor, setMonitor] = useState<McpStoreMonitor | null>(null);
  const [pref, setPref] = useState<{ owner: string; mode: Mode } | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = stopVersion.current;
      try {
        // The native status read is local and cheap; only a running driver is worth a daemon round-trip.
        const nextStatus = await request("computer_use_status") as ComputerUseStatus;
        if (!live || version !== stopVersion.current) return;
        setStatus(nextStatus);
        if (!nextStatus.running) { setMonitor(null); return; }
        const next = await read();
        if (!live || version !== stopVersion.current) return;
        setMonitor(next);
      } catch {
        // Without a trustworthy lease owner there is nothing safe to show: fall back to "no overlay".
        if (live) setMonitor(null);
      } finally { if (live) timer = setTimeout(() => void poll(), MONITOR_MS); }
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [enabled, request, read]);

  const owner = status?.running && monitor?.held ? monitor.owner : null;
  const matched = !!agentId && !!monitor && owner === agentId;
  const mode: Mode = pref && pref.owner === owner ? pref.mode : "open";
  const hasTarget = matched && !!(monitor.windowId || monitor.desktop);
  const windowId = matched ? monitor.windowId : null;
  // The key IS the frame's identity: owner/selection/lease changes change it, which drops every
  // in-flight and stored frame for the previous key.
  const previewKey = enabled && hasTarget && mode === "open" && pageVisible ? `${agentId}|${windowId ?? "desktop"}` : null;

  // A dismissal belongs to one lease holder; once that holder lets go, the next lease starts open.
  useEffect(() => { if (pref && pref.owner !== owner) setPref(null); }, [owner, pref]);

  useEffect(() => {
    if (!previewKey) { setFrame(null); setPreviewError(""); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setFrame(f => (f && f.key === previewKey ? f : null));
    const tick = async () => {
      try {
        const image = await request("computer_use_preview", { windowId });
        if (!live) return;
        setFrame(typeof image === "string" ? { key: previewKey, src: image, at: Date.now() } : null);
        setPreviewError("");
      } catch (e) {
        if (live) { setFrame(null); setPreviewError(e instanceof Error ? e.message : String(e)); }
      } finally { if (live) timer = setTimeout(() => void tick(), PREVIEW_MS); }
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
  }, [previewKey, windowId, request]);

  // Only after the user's own click: the control they pressed has just unmounted, so keyboard focus
  // would otherwise fall to <body>. Never on appearance — an agent acquiring the lease must not steal focus.
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === "toggle") toggleRef.current?.focus();
    else if (target === "reopen") reopenRef.current?.focus();
  }, [mode]);

  const setMode = (next: Mode, focus: "toggle" | "reopen" | null) => {
    if (!owner) return;
    refocus.current = focus;
    setPref({ owner, mode: next });
  };
  const stop = async () => {
    if (stopping) return;
    setStopping(true); setStopError(""); stopVersion.current++;
    try {
      await request("computer_use_stop");
      setMonitor(null); setFrame(null);
      setStatus(s => s ? { ...s, running: false, autoStart: false } : s);
    } catch (e) { setStopError(e instanceof Error ? e.message : String(e)); }
    finally { setStopping(false); }
  };

  if (!matched || !monitor || !owner) return null;
  if (mode === "hidden") {
    return <ChipButton ref={reopenRef} className={styles.reopen} data-computer-monitor-reopen
      onClick={() => setMode("open", "toggle")}>Show desktop view</ChipButton>;
  }
  const shown = frame && frame.key === previewKey ? frame : null;
  const actions = monitor.activities.filter(a => a.agentId === owner).slice(-VISIBLE_ACTIONS).reverse();
  const open = mode === "open";
  return <aside className={styles.monitor} data-computer-monitor data-mode={mode} aria-label="Desktop control preview">
    <header className={styles.bar}>
      <strong>Desktop</strong>
      <span role="status" className={styles.state}>{monitor.busy ? "Acting" : "Observing / thinking"}</span>
      <ChipButton ref={toggleRef} className={styles.iconButton} aria-expanded={open}
        aria-label={open ? "Collapse desktop preview" : "Expand desktop preview"}
        onClick={() => setMode(open ? "collapsed" : "open", "toggle")}>{open ? "–" : "+"}</ChipButton>
      <ChipButton className={styles.iconButton} aria-label="Hide desktop preview"
        onClick={() => setMode("hidden", "reopen")}>×</ChipButton>
    </header>
    {open && <>
      <div className={styles.preview} aria-label="Live desktop preview">
        {shown ? <img src={shown.src} alt="Live view of the agent's desktop target" /> : <span>{previewError || "The target window will appear when the agent observes it."}</span>}
      </div>
      <small className={styles.caption}>{shown ? `Live preview · ${new Date(shown.at).toLocaleTimeString()}` : "Preview pauses when hidden, collapsed or released."}</small>
      {stopError && <p role="alert" className={styles.error}>{stopError}</p>}
      <ol className={styles.activity} aria-label="Recent desktop actions">
        {actions.map(a => <li key={a.id}>
          <time>{new Date(a.ts).toLocaleTimeString()}</time><span>{a.tool}</span><span data-action-state={a.state}>{a.state}</span>
        </li>)}
      </ol>
      <footer>
        <ChipButton className={styles.stop} data-computer-monitor-stop aria-describedby={noteId} disabled={stopping} onClick={() => void stop()}>Stop desktop control</ChipButton>
        {/* Visually dropped on a phone-width pane but still the button's accessible description. */}
        <small id={noteId} className={styles.note}>Hiding this keeps control running. Stop also turns off automatic startup.</small>
      </footer>
    </>}
  </aside>;
}
