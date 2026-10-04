import { useEffect, useRef, useState } from "react";
import type { UiState } from "@chimera/ui-state";
import { rpcCall } from "../rpc/bridge";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { agentCommands, composerLocal, remainingSec, type VisibleQuestion } from "../state/commands.agents";
import { displayName } from "../state/selectors";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import styles from "./QuestionCard.module.css";

// W4 build item 5 — the ? question card (mock showQuestion + questionKind=
// multi, line 257-281; coverage A4/B6): OverlayCard bottom, width 640, edge
// --edge-question. Fed by visibleQuestion (firstPendingQuestion filtered by
// the esc-"later" dismissed set) — GLOBAL across agents (TUI-004), so the
// answer always goes to the agent that actually asked. Countdown ticks 1s
// from timeoutMs (TUI-041); at zero the card drops (the daemon owns the
// timeout answer). Single: ↑↓ / 1-9 / click (click submits, TUI parity);
// multi: space/click toggles [x]; a freeform question's custom row is always
// typed-into, even with options (TUI-005) — this card owns the keyboard while
// visible (a capture listener registered AFTER AgentsScreen's, so permission
// chords + the esc chain stay above it).
export function QuestionCard({ question, bottomInset }: {
  question: VisibleQuestion;
  bottomInset: number;
}) {
  const commands = agentCommands(appStore, rpcCall);
  const agent = useStore((s: UiState) => s.agents[question.agentId]);
  const from = agent ? displayName(agent) : question.agentId.slice(0, 8);
  const options = question.options ?? [];

  // Minor 5 (final acceptance): a MULTI question opens with its defaults
  // PRE-CHECKED (mock line 16's [x] rows) — the toggled set seeds from
  // question.default.optionIds instead of empty.
  const seedToggled = (): ReadonlySet<string> =>
    new Set(question.multiSelect ? question.default?.optionIds ?? [] : []);

  const [index, setIndex] = useState(0);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(seedToggled);
  const [text, setText] = useState("");
  // Minor 6 (final acceptance): the countdown deadline is keyed PER questionId —
  // a NEW question replacing the pending one on the same agent keeps this
  // component mounted (same element position), so an unkeyed ref would keep
  // ticking down the OLD question's deadline.
  const deadlineRef = useRef<{ qid: string; deadline: number } | null>(null);
  if (deadlineRef.current === null || deadlineRef.current.qid !== question.questionId) {
    deadlineRef.current = {
      qid: question.questionId,
      deadline: question.timeoutMs ? Date.now() + question.timeoutMs : Number.POSITIVE_INFINITY,
    };
  }
  const [remaining, setRemaining] = useState(() => remainingSec(deadlineRef.current!.deadline, Date.now()));
  // Re-seed the per-question state on a questionId swap (render-time adjust,
  // the TranscriptPanel scrollAgentKey pattern) — cursor/toggles/custom text
  // belong to the question they were typed for.
  const [qid, setQid] = useState(question.questionId);
  if (qid !== question.questionId) {
    setQid(question.questionId);
    setIndex(0);
    setToggled(seedToggled());
    setText("");
    setRemaining(remainingSec(deadlineRef.current.deadline, Date.now()));
  }

  const dismiss = (): void => {
    composerLocal.set({
      dismissedQuestions: new Set([...composerLocal.getState().dismissedQuestions, question.questionId]),
    });
  };

  useEffect(() => {
    if (!question.timeoutMs) return undefined;
    const id = window.setInterval(() => {
      const left = remainingSec(deadlineRef.current!.deadline, Date.now());
      setRemaining(left);
      if (left <= 0) {
        // card drops; the agent receives the daemon's timeout answer
        dismiss();
        // Minor 7 (final acceptance): ALSO clear the local projection — the
        // daemon's own timeout resolution is authoritative (it answers the
        // agent), but nothing pushes a "question gone" event, so without this
        // the '?'/waiting row lingers on a stale pendingQuestion.
        appStore.dispatch({ type: "questionAnswered", agentId: question.agentId, questionId: question.questionId });
      }
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.questionId]);

  // TUI submitQuestionAnswer port: multi → toggled ids; single → highlighted
  // option; freeform text if typed; the question's default as last resort.
  const submit = (optIndex: number): void => {
    const answer: { optionIds?: string[]; text?: string } = {};
    if (question.multiSelect) {
      const ids = [...toggled];
      if (ids.length > 0) answer.optionIds = ids;
    } else {
      const opt = options[optIndex];
      if (opt) answer.optionIds = [opt.id];
    }
    if (question.freeform && text.trim()) answer.text = text.trim();
    if (!answer.optionIds && !answer.text && question.default) {
      if (question.default.optionIds && question.default.optionIds.length > 0) answer.optionIds = question.default.optionIds;
      if (question.default.text) answer.text = question.default.text;
    }
    void commands.answerQuestion(question.agentId, question.questionId, answer);
  };

  const toggle = (id: string): void => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // The card owns the keyboard while visible (TUI: "swallow EVERY other key
  // while a question is pending"), so the composer must NOT keep focus: an
  // IME/insertText character (e.g. "ö") never fires keydown and would land in
  // the focused textarea behind the card. Blur on mount, refocus on unmount.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches("[data-compose-input]")) active.blur();
    return () => {
      document.querySelector<HTMLTextAreaElement>("[data-compose-input]")?.focus();
    };
  }, [question.questionId]);

  // Registered on mount — AFTER AgentsScreen's capture listener, so
  // permission mod+y/mod+j and the esc chain run first.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") return;                    // the esc chain owns dismissal
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "y" || ev.key === "n")) return; // permission chords stay above
      const stop = (): void => { ev.preventDefault(); ev.stopImmediatePropagation(); };
      if (options.length > 0 && ev.key === "ArrowUp") { stop(); setIndex((i) => (i - 1 + options.length) % options.length); return; }
      if (options.length > 0 && ev.key === "ArrowDown") { stop(); setIndex((i) => (i + 1) % options.length); return; }
      if (options.length > 0 && /^[1-9]$/.test(ev.key) && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        const i = Number(ev.key) - 1;
        if (i < options.length) { stop(); setIndex(i); }
        return;
      }
      if (question.multiSelect && options.length > 0 && ev.key === " ") {
        stop();
        const opt = options[index];
        if (opt) toggle(opt.id);
        return;
      }
      if (ev.key === "Enter" && !ev.altKey && !ev.ctrlKey && !ev.metaKey) { stop(); submit(index); return; }
      // TUI-005: freeform typing accumulates even when options exist.
      if (question.freeform) {
        if (ev.key === "Backspace") { stop(); setText((t) => t.slice(0, -1)); return; }
        if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { stop(); setText((t) => t + ev.key); return; }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.questionId, index, options.length, question.multiSelect, question.freeform, toggled, text]);

  const isDefault = (id: string): boolean => question.default?.optionIds?.includes(id) === true;

  return (
    <OverlayCard width={640} align="bottom" edge="var(--edge-question)" bottomInset={bottomInset} onClose={dismiss}>
      <div data-question-card>
        <OverlayCardHeader
          title="? question"
          titleColor="var(--human)"
          meta={`from ${from}`}
          hint={question.timeoutMs ? `expires in ${remaining}s` : undefined}
        />
        <div className={styles.prompt}>{question.header ? `${question.header} — ` : ""}{question.prompt}</div>
        <div className={styles.options}>
          {options.map((opt, i) => {
            const selected = i === index;
            const rowCls = [styles.option, selected ? styles.optionSelected : ""].filter(Boolean).join(" ");
            if (question.multiSelect) {
              return (
                <button key={opt.id} type="button" className={rowCls} data-question-option
                  onClick={() => { setIndex(i); toggle(opt.id); }}>
                  <span className={toggled.has(opt.id) ? styles.checkOn : styles.checkOff}>
                    {toggled.has(opt.id) ? "[x]" : "[ ]"}
                  </span>{" "}
                  {opt.label}
                  {/* Minor 5: multi mode marks defaults too (mock's pre-checked rows) */}
                  {isDefault(opt.id) ? <span className={styles.defaultMark}> (default)</span> : null}
                </button>
              );
            }
            return (
              <button key={opt.id} type="button" className={rowCls} data-question-option
                onClick={() => setIndex(i)}>
                {i + 1} · {opt.label}
                {opt.description ? <span className={styles.desc}> — {opt.description}</span> : null}
                {isDefault(opt.id) ? <span className={styles.defaultMark}> (default)</span> : null}
              </button>
            );
          })}
          {question.freeform ? (
            <div className={styles.freeform} data-question-freeform>
              {options.length + 1} · <span className={styles.freeformLabel}>custom:</span> {text}
              <span className={styles.cursor}>&nbsp;</span>
            </div>
          ) : null}
        </div>
        <div className={styles.footer}>
          ↑↓ / 1-{Math.max(1, options.length)} choose · space toggle (multi) · enter submit · type for custom · click an option
        </div>
      </div>
    </OverlayCard>
  );
}
