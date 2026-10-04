import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Subscription } from "@chimera/protocol";
import { fmtClock } from "../state/selectors";
import { num, specLine, str } from "../state/selectors.coord";
import { watchFilterLabel } from "../state/selectors.hooks";
import { rpcCall, onDaemonEvent } from "../rpc/bridge";
import { displayChord } from "../keymap";
import styles from "./AgentInspector.module.css";
import { AgentNotes } from "./AgentNotes";

// W5 — the inline agent inspector card the Teams detail renders UNDER the
// selected agent row (mock s_teams 601-606): spawned by / prompt / spec / hint
// rows. Fed by the team.status agent record + the matching queue.status task
// record (coverage B8 row 5: prompt = task.prompt / spawn prompt, try =
// task.attempts). NOT an overlay — a raised block in the table flow.

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </div>
  );
}

// HOOK-6 (PLAN-HOOKS.md §7): the "watching" chip row — the agent's live event
// subscriptions (sub.list on inspect), each `topic · filter · once` with a remove
// (✕ → sub.remove) affordance. Live-updates: a once:true sub disappears the moment
// it fires (signal_delivered), so we re-list on every signal_delivered for THIS
// agent — no polling timer (rides the existing event edge, per §9's zero-poll rule).
function WatchingChips({ agentId }: { agentId: string }) {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!agentId) return undefined;
    let alive = true;
    mounted.current = true;
    const list = (): void => {
      const version = ++requestVersion.current;
      void rpcCall<Subscription[]>("sub.list", { subscriberId: agentId })
        .then((rows) => { if (alive && version === requestVersion.current) { setSubs(Array.isArray(rows) ? rows : []); setLoaded(true); } })
        .catch(() => { if (alive && version === requestVersion.current) setLoaded(true); });
    };
    list();
    // a delivered signal against this agent may have removed a once:true sub — re-list.
    const off = onDaemonEvent((e) => { if (e.kind === "signal_delivered" && e.agentId === agentId) list(); });
    return () => { alive = false; mounted.current = false; off(); };
  }, [agentId]);

  const remove = (id: string): void => {
    const version = ++requestVersion.current;
    const removed = subs.find((s) => s.id === id);
    setSubs((cur) => cur.filter((s) => s.id !== id)); // optimistic
    void rpcCall("sub.remove", { subscriberId: agentId, id }).catch(() => {
      if (!mounted.current || version !== requestVersion.current) return;
      if (removed) setSubs((current) => current.some((s) => s.id === id) ? current : [...current, removed]);
      // a failed remove re-lists so the chip reappears rather than lying about state
      void rpcCall<Subscription[]>("sub.list", { subscriberId: agentId })
        .then((rows) => { if (mounted.current && version === requestVersion.current) setSubs(Array.isArray(rows) ? rows : []); })
        .catch(() => {});
    });
  };

  // F46.UI: distinguish "still asking the daemon" from "watches nothing" — the two
  // used to look identical (an empty chip row) while sub.list was in flight.
  if (!loaded) return <span className={styles.meta}>…</span>;
  if (subs.length === 0) return <span className={styles.meta}>none</span>;
  return (
    <span className={styles.chipRow}>
      {subs.map((s) => {
        const filter = watchFilterLabel(s.filter);
        return (
          <span key={s.id} className={styles.watchChip} data-sub-chip={s.id}>
            {s.topic}
            {filter && <span className={styles.chipMeta}> · {filter}</span>}
            {s.once && <span className={styles.chipMeta}> · once</span>}
            <button type="button" className={styles.chipRemove} title="unsubscribe (sub.remove)" onClick={() => remove(s.id)} data-sub-remove={s.id}>✕</button>
          </span>
        );
      })}
    </span>
  );
}

export function AgentInspector({
  record,
  task,
  retryLimit,
  owner,
  queue,
}: {
  record: Record<string, unknown>;       // team.status agents[] entry (AgentRecord, read defensively)
  task: Record<string, unknown> | null;  // queue.status tasks[] entry bound to this agent
  retryLimit: number;                    // queue spec retryLimit (try n/m's m)
  owner: string | null;                  // team spec.createdBy → display label ("main"/short id)
  queue: string | null;                  // team spec.queue
}) {
  const spec = record["spec"] && typeof record["spec"] === "object" ? (record["spec"] as Record<string, unknown>) : undefined;
  const prompt = task ? str(task["prompt"]) : str(spec?.["prompt"]);
  const createdAt = num(record["createdAt"]);
  const agentId = str(record["agentId"]);
  return (
    <div className={styles.card} data-agent-inspector>
      {agentId && <AgentNotes key={agentId} agentId={agentId} />}
      <Row label="spawned by">
        <span>
          <span className={styles.owner}>◆ {owner ?? "—"}</span>
          <span className={styles.meta}>
            {queue ? ` · queue ${queue}` : ""}
            {task ? ` → task ${str(task["taskId"])} · try ${num(task["attempts"])}/${retryLimit}` : ""}
            {createdAt > 0 ? ` · started ${fmtClock(createdAt)}` : ""}
          </span>
        </span>
      </Row>
      <Row label="prompt">
        <span className={styles.prompt}>{prompt ? `"${prompt}"` : "—"}</span>
      </Row>
      <Row label="spec">
        <span className={styles.meta}>{specLine(spec)}</span>
      </Row>
      {agentId ? (
        <Row label="watching">
          <WatchingChips key={agentId} agentId={agentId} />
        </Row>
      ) : null}
      <Row label="">
        <span className={styles.hint}>enter → transcript · {displayChord("mod+shift+k")} kill · ↑↓ other agents</span>
      </Row>
    </div>
  );
}
