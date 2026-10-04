import { useEffect, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { agentCommands, type VisibleDialog } from "../state/commands.agents";
import { dialogAnswerValue, dialogQuestions, isAskQuestionDialog } from "../state/dialog";
import { displayName } from "../state/selectors";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import styles from "./DialogCard.module.css";

// Native-CLI-parity Phase 2 (Task DLG3) — the webview's AskUserQuestion /
// generic-elicitation card, templated on QuestionCard (same OverlayCard shell,
// same ↑↓/1-9/space/enter/click keyboard contract) but fed by the daemon's
// `agent_dialog` event (pendingDialog) instead of `agent_question`. A
// "permission_ask_user_question" dialogKind carries 1-4 questions answered ONE
// AT A TIME (stepIndex advances on Enter, accumulating {[question]: answer}
// into `answers`; the final step's Enter posts the whole map — mirrors the
// TUI's submitDialogAnswer/dAnswers). Every other dialogKind falls back to a
// generic accept/cancel card (message/title from the payload). Unlike
// QuestionCard/PermissionCard, esc does NOT mean "later" — the CLI's own tool
// call is blocked on this dialog, so esc posts {behavior:"cancelled"}
// immediately (AgentsScreen's esc chain + this card's onClose both route here).
export function DialogCard({ dialog, bottomInset }: {
  dialog: VisibleDialog;
  bottomInset: number;
}) {
  const commands = agentCommands(appStore, rpcCall);
  const agent = useStore((s: UiState) => s.agents[dialog.agentId]);
  const from = agent ? displayName(agent) : dialog.agentId.slice(0, 8);

  const isAskQuestion = isAskQuestionDialog(dialog.dialogKind);
  const questions = isAskQuestion ? dialogQuestions(dialog.payload) : [];

  const [dialogId, setDialogId] = useState(dialog.dialogId);
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [customText, setCustomText] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  // Re-seed per-dialog state on a dialogId swap (render-time adjust, the
  // QuestionCard qid pattern) — step/selection/accumulation belong to the
  // dialog they were built for.
  if (dialogId !== dialog.dialogId) {
    setDialogId(dialog.dialogId);
    setStepIndex(0);
    setSelectedIndex(0);
    setSelectedIds(new Set());
    setCustomText("");
    setAnswers({});
  }

  const currentQ = questions[stepIndex];
  const options = currentQ?.options ?? [];

  const cancel = (): void => {
    void commands.answerDialog(dialog.dialogId, { behavior: "cancelled" });
  };

  const toggle = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Task DLG4 parity: extracted so a click and Enter submit through the exact
  // same logic. `selIndex` is passed explicitly (not read from state) so a
  // just-clicked option's not-yet-committed setSelectedIndex doesn't race a
  // stale read within the same synchronous handler.
  const submitStep = (selIndex: number): void => {
    let nextAnswers = answers;
    if (currentQ) {
      const value = dialogAnswerValue(currentQ, selIndex, selectedIds, customText);
      if (value !== undefined) {
        nextAnswers = { ...answers, [currentQ.question]: value };
        setAnswers(nextAnswers);
      }
    }
    if (isAskQuestion && stepIndex < questions.length - 1) {
      setStepIndex((i) => i + 1);
      setSelectedIndex(0);
      setSelectedIds(new Set());
      setCustomText("");
      return;
    }
    const result = isAskQuestion ? { answers: nextAnswers } : {};
    void commands.answerDialog(dialog.dialogId, { behavior: "completed", result });
  };

  // The card owns the keyboard while visible (mirrors QuestionCard): blur the
  // composer on mount so a stray IME/insertText character never lands behind
  // this card, refocus it on unmount.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches("[data-compose-input]")) active.blur();
    return () => {
      document.querySelector<HTMLTextAreaElement>("[data-compose-input]")?.focus();
    };
  }, [dialog.dialogId]);

  // Registered on mount — AFTER AgentsScreen's capture listener, so esc (the
  // chain answers "cancelled" directly) and permission mod+y/mod+j stay above it.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") return;                    // the esc chain owns cancel
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || ev.key === "n")) return; // permission chords stay above
      const stop = (): void => { ev.preventDefault(); ev.stopImmediatePropagation(); };
      if (options.length > 0 && ev.key === "ArrowUp") { stop(); setSelectedIndex((i) => (i - 1 + options.length) % options.length); return; }
      if (options.length > 0 && ev.key === "ArrowDown") { stop(); setSelectedIndex((i) => (i + 1) % options.length); return; }
      if (options.length > 0 && /^[1-9]$/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        const i = Number(ev.key) - 1;
        if (i < options.length) { stop(); setSelectedIndex(i); }
        return;
      }
      if (currentQ?.multiSelect && options.length > 0 && ev.key === " ") {
        stop();
        toggle(String(selectedIndex));
        return;
      }
      if (ev.key === "Enter" && !ev.altKey && !ev.ctrlKey && !ev.metaKey) { stop(); submitStep(selectedIndex); return; }
      // AskUserQuestion always offers an implicit "Other" freeform answer.
      if (isAskQuestion) {
        if (ev.key === "Backspace") { stop(); setCustomText((t) => t.slice(0, -1)); return; }
        if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { stop(); setCustomText((t) => t + ev.key); return; }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog.dialogId, stepIndex, selectedIndex, options.length, currentQ, isAskQuestion, selectedIds, customText]);

  if (isAskQuestion && currentQ) {
    return (
      <OverlayCard width={640} align="bottom" edge="var(--edge-question)" bottomInset={bottomInset} onClose={cancel}>
        <div data-dialog-card>
          <OverlayCardHeader title="? dialog" titleColor="var(--human)" meta={`from ${from}`} />
          {questions.length > 1 ? (
            <div className={styles.stepBadge} data-dialog-step>question {stepIndex + 1}/{questions.length}</div>
          ) : null}
          <div className={styles.prompt}>{currentQ.header ? `${currentQ.header} — ` : ""}{currentQ.question}</div>
          <div className={styles.options}>
            {options.map((opt, i) => {
              const selected = i === selectedIndex;
              const idStr = String(i);
              const rowCls = [styles.option, selected ? styles.optionSelected : ""].filter(Boolean).join(" ");
              if (currentQ.multiSelect) {
                return (
                  <button key={idStr} type="button" className={rowCls} data-dialog-option
                    onClick={() => { setSelectedIndex(i); toggle(idStr); }}>
                    <span className={selectedIds.has(idStr) ? styles.checkOn : styles.checkOff}>
                      {selectedIds.has(idStr) ? "[x]" : "[ ]"}
                    </span>{" "}
                    {opt.label}
                  </button>
                );
              }
              return (
                <button key={idStr} type="button" className={rowCls} data-dialog-option
                  onClick={() => setSelectedIndex(i)}>
                  {i + 1} · {opt.label}
                  {opt.description ? <span className={styles.desc}> — {opt.description}</span> : null}
                </button>
              );
            })}
            <div className={styles.freeform} data-dialog-freeform>
              {options.length + 1} · <span className={styles.freeformLabel}>other:</span> {customText}
              <span className={styles.cursor}>&nbsp;</span>
            </div>
          </div>
          <div className={styles.footer}>
            ↑↓ / 1-{Math.max(1, options.length)} choose · space toggle (multi) ·
            {" "}enter {stepIndex < questions.length - 1 ? "next" : "submit"} · type for other · esc cancel
          </div>
        </div>
      </OverlayCard>
    );
  }

  // Generic fallback (unknown/unsupported dialogKind): payload's message/title
  // as the prompt, plain accept/cancel.
  const message = typeof dialog.payload["message"] === "string" ? (dialog.payload["message"] as string) : undefined;
  const title = typeof dialog.payload["title"] === "string" ? (dialog.payload["title"] as string) : undefined;
  const prompt = message ?? title ?? dialog.dialogKind;
  return (
    <OverlayCard width={640} align="bottom" edge="var(--edge-question)" bottomInset={bottomInset} onClose={cancel}>
      <div data-dialog-card>
        <OverlayCardHeader title="? dialog" titleColor="var(--human)" meta={`from ${from}`} />
        <div className={styles.prompt}>{prompt}</div>
        <div className={styles.footer}>enter accept · esc cancel</div>
      </div>
    </OverlayCard>
  );
}
