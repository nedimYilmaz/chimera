import { useMemo } from "react";
import { attentionInbox, type InboxItem } from "@chimera/ui-state";
import type { UiState } from "@chimera/ui-state";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { agentCommands } from "../state/commands.agents";
import { getCoordCommands } from "../state/commands.coord";
import { openReviewRoom } from "../state/commands.evidence";
import { inboxRowAgentLabel, inboxRowDetail, inboxRowGlyph, inboxRowGlyphColor, inboxRowTitle, inboxSections } from "../state/selectors.inbox";
import { formatMetricValue, metricLabel } from "../state/selectors.slo";
import { Panel, PanelFooter } from "../components/Panel";
import styles from "./InboxScreen.module.css";
import { useSloState } from "../state/commands.slo";

// FEATURE-9 — the Attention Inbox: a single prioritized, deduplicated feed of every
// actionable item across all agents/tasks (permission prompts, questions, workflow
// approval gates, failed/blocked tasks). Derived entirely from ui-state's
// attentionInbox(state) selector — this screen adds no state of its own beyond what
// the existing commands (answerPermission/answerQuestion/openQueueDetail) already
// mutate, so a row clears itself the instant the underlying request resolves
// (including when another client resolved it — the next render just omits it).
const coord = getCoordCommands(appStore, rpcCall);

export function InboxScreen() {
  // useStore's referential-stability contract (useStore.ts): a selector must return
  // an existing field/reference, never a freshly built array — `s` itself IS that
  // existing reference (stable across renders that don't correspond to a real
  // dispatch), so attentionInbox's fresh-array derivation happens in useMemo instead.
  const state = useStore((s: UiState) => s);
  const items = useMemo(() => attentionInbox(state), [state]);
  const agents = state.agents;
  const commands = agentCommands(appStore, rpcCall);
  const breaches = useSloState((s) => s.breaches);

  const openAgent = (agentId: string): void => {
    appStore.dispatch({ type: "selectTab", tab: "agents" });
    appStore.dispatch({ type: "selectAgent", agentId });
  };
  const openTask = (queue: string): void => {
    appStore.dispatch({ type: "selectTab", tab: "queues" });
    void coord.openQueueDetail(queue);
  };

  return (
    <Panel label={<>attention inbox <span className={styles.labelMeta}>· {items.length} item{items.length === 1 ? "" : "s"}</span></>} className={styles.panel}>
      <div className={styles.body}>
        {items.length === 0 && breaches.length === 0 ? (
          <div className={styles.emptyHint}>nothing needs you right now</div>
        ) : (
          <>
          {breaches.length > 0 && <div className={styles.section} data-inbox-section="slo">
            <div className={styles.sectionHead}>SLO breaches</div>
            {breaches.map((b) => <div className={styles.row} data-inbox-row={b.id} key={b.id}>
              <span className={styles.glyph}>!</span><div className={styles.rowBody}>
                <div className={styles.rowTitle}>{metricLabel(b.threshold.metric)} breached</div>
                <div className={styles.rowDetail}>{formatMetricValue(b.threshold.metric, b.observed)} &gt; {formatMetricValue(b.threshold.metric, b.threshold.limit)} · {b.threshold.window}</div>
              </div><div className={styles.actions}><button className={styles.option} onClick={() => appStore.dispatch({ type: "selectTab", tab: "slo" })}>open</button></div>
            </div>)}
          </div>}
          {inboxSections(items).map((section) => (
            <div key={section.urgency} className={styles.section} data-inbox-section={section.urgency}>
              <div className={styles.sectionHead}>{section.title}</div>
              {section.items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  agentLabel={inboxRowAgentLabel({ agents }, "agentId" in item ? item.agentId : "task" in item ? item.task.agentId : null)}
                  onAnswerPermission={(allow) => void commands.answerPermission(allow, item.kind === "permission" ? item.permission.requestId : undefined)}
                  onAnswerQuestion={(optionIds) => {
                    if (item.kind !== "question" && item.kind !== "approval") return;
                    void commands.answerQuestion(item.agentId, item.question.questionId, { optionIds });
                  }}
                  onOpenAgent={openAgent}
                  onOpenTask={openTask}
                  onOpenReview={(taskId) => { void openReviewRoom(appStore, rpcCall, taskId); }}
                />
              ))}
            </div>
          ))}</>
        )}
      </div>
      <PanelFooter>click an item to act — resolved items (including from elsewhere) clear automatically</PanelFooter>
    </Panel>
  );
}

function InboxRow({ item, agentLabel, onAnswerPermission, onAnswerQuestion, onOpenAgent, onOpenTask, onOpenReview }: {
  item: InboxItem;
  agentLabel: string | null;
  onAnswerPermission: (allow: boolean) => void;
  onAnswerQuestion: (optionIds: string[]) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenTask: (queue: string) => void;
  onOpenReview: (taskId: string) => void;
}) {
  const { glyph } = inboxRowGlyph(item);
  const detail = inboxRowDetail(item);

  return (
    <div className={styles.row} data-inbox-row={item.id}>
      <span className={styles.glyph} style={{ color: inboxRowGlyphColor(item) }}>{glyph}</span>
      <div className={styles.rowBody}>
        <div className={styles.rowTitle}>{inboxRowTitle(item)}</div>
        {detail && <div className={styles.rowDetail}>{detail}</div>}
        {agentLabel && <div className={styles.rowMeta}>{agentLabel}</div>}
      </div>
      <div className={styles.actions}>
        {item.kind === "permission" && (
          <>
            <button type="button" className={styles.allow} onClick={() => onAnswerPermission(true)} data-inbox-allow>allow</button>
            <button type="button" className={styles.deny} onClick={() => onAnswerPermission(false)} data-inbox-deny>deny</button>
          </>
        )}
        {item.kind === "approval" && (
          <>
            <button type="button" className={styles.allow} onClick={() => onAnswerQuestion(["approve"])} data-inbox-approve>approve</button>
            <button type="button" className={styles.deny} onClick={() => onAnswerQuestion(["reject"])} data-inbox-reject>reject</button>
          </>
        )}
        {item.kind === "question" && (
          (item.question.options ?? []).length > 0 ? (
            (item.question.options ?? []).map((opt) => (
              <button type="button" key={opt.id} className={styles.option} onClick={() => onAnswerQuestion([opt.id])} data-inbox-option={opt.id}>
                {opt.label}
              </button>
            ))
          ) : (
            // freeform-only question: no inline text field in this slice — jump to
            // the source agent, where QuestionCard already handles freeform reply.
            <button type="button" className={styles.option} onClick={() => onOpenAgent(item.agentId)} data-inbox-open>open</button>
          )
        )}
        {(item.kind === "task_failed" || item.kind === "task_blocked") && (
          <button type="button" className={styles.option} onClick={() => onOpenTask(item.task.queue)} data-inbox-open>open</button>
        )}
        {item.kind === "review_decision" && (
          <button type="button" className={styles.option} onClick={() => onOpenReview(item.taskId)} data-inbox-open-review>open review</button>
        )}
      </div>
    </div>
  );
}
