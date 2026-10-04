import { useEffect, useState, type ReactElement } from "react";
import { attachAgentTerminal } from "../state/terminals";
import { TerminalView } from "./TerminalView";
import styles from "./AgentTerminal.module.css";

// TERMINAL-RUNTIME: the transcript panel's body for an agent running as a real CLI.
//
// There IS no transcript for these agents — the screen is the transcript, so this replaces the
// body rather than sitting beside it. The panel HEADER stays exactly as it is: the same chips and
// the same actions, which for a terminal agent are typed into the session instead of sent as an
// RPC (see TranscriptHeader / commands.agents).
//
// What is shown is an ATTACHMENT, not the agent. The tmux session belongs to the daemon; closing
// this panel or the whole app detaches and leaves the agent running. That is the property the
// runtime exists for, which is why the attach command is also printed: an operator can sit down at
// the same session from any terminal they prefer.
export function AgentTerminal({ agentId, workdir, session, attach }: {
  agentId: string;
  workdir?: string | null;
  session: string;
  attach: string;
}): ReactElement {
  const [tabId, setTabId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTabId(null);
    setError(null);
    void attachAgentTerminal({ id: agentId, workdir: workdir ?? null, session })
      .then(({ id }) => { if (!cancelled) setTabId(id); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    // Re-attaching on every session change is the point; TerminalView owns tearing the old PTY
    // down through its own unmount cleanup (keyed by tab id below).
    return () => { cancelled = true; };
  }, [agentId, session, workdir]);

  if (error !== null) {
    return (
      <div className={styles.wrap}>
        <div className={styles.notice} data-agent-terminal-error>
          could not attach to {session}: {error}
        </div>
        <div className={styles.hint}>the agent is unaffected — it runs in its own session. try: {attach}</div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {tabId === null ? (
        <div className={styles.notice}>attaching to {session}…</div>
      ) : (
        // Keyed by tab id so a re-attach mounts a FRESH TerminalView: its PTY wiring is
        // set up once per tab id by design, and reusing the element across sessions would
        // leave the old channel bound.
        <TerminalView key={tabId} tab={{ id: tabId, title: session, cwd: workdir ?? "", agentId, exited: null }} visible />
      )}
      <div className={styles.hint} data-agent-terminal-attach>{attach}</div>
    </div>
  );
}
