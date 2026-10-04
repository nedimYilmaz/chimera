// Native-CLI-parity Phase 2 (Task DLG3) — the webview's side of the interactive
// dialog round-trip. The daemon projects an `agent_dialog` event into
// AgentView.pendingDialog (ui-state reducer); this module holds the PURE parse +
// answer-shape helpers DialogCard renders/answers through, so the DOM component
// owns no interpretation logic (mirrors the TUI's DialogPanel.tsx pure helpers,
// duplicated here rather than imported so packages/app never depends on the Ink
// package).

/** One AskUserQuestion sub-question (1-4 per dialog), loosely typed at the parse
 * boundary — the payload arrives over the wire as an untyped Record. */
export type DialogQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

/** Defensive parse of `payload.questions` for a `permission_ask_user_question`
 * dialog: a non-array, or an entry missing a string `question`, is dropped
 * rather than throwing — daemon-side field drift (or a different dialogKind
 * whose payload happens to also carry a `questions` key) must never crash the
 * card render. Ported from the TUI's dialogQuestions. */
export function dialogQuestions(payload: Record<string, unknown>): DialogQuestion[] {
  const raw = payload["questions"];
  if (!Array.isArray(raw)) return [];
  const out: DialogQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["question"] !== "string") continue;
    const rawOptions = Array.isArray(rec["options"]) ? rec["options"] : [];
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
      .map((o) => ({
        label: typeof o["label"] === "string" ? (o["label"] as string) : "",
        ...(typeof o["description"] === "string" ? { description: o["description"] as string } : {}),
      }));
    out.push({
      question: rec["question"] as string,
      ...(typeof rec["header"] === "string" ? { header: rec["header"] as string } : {}),
      options,
      ...(rec["multiSelect"] === true ? { multiSelect: true } : {}),
    });
  }
  return out;
}

/** True for the AskUserQuestion dialogKind — its payload projects onto the
 * option-picker UI; anything else falls back to the generic accept/cancel card. */
export function isAskQuestionDialog(dialogKind: string): boolean {
  return dialogKind === "permission_ask_user_question";
}

/** The per-question answer value the AskUserQuestion tool result expects, keyed
 * by the question's own text (see DialogCard's step accumulation). A typed
 * custom answer (freeform — AskUserQuestion always offers an implicit "Other")
 * wins over any selected option(s); a multiSelect question yields the array of
 * chosen labels (looked up by their stringified option index, matching the
 * TUI's index-as-id convention); a single-select yields the one chosen label.
 * Returns undefined when the user left the question blank (no selection, no
 * text) — the caller then omits it from `answers`. PURE: the caller passes the
 * already-resolved selection so this stays trivially testable. */
export function dialogAnswerValue(
  q: DialogQuestion,
  selectedIndex: number,
  selectedIds: ReadonlySet<string>,
  customText: string,
): string | string[] | undefined {
  const text = customText.trim();
  if (text) return text;
  if (q.multiSelect) {
    const labels = [...selectedIds]
      .map((sid) => q.options[Number(sid)]?.label)
      .filter((l): l is string => typeof l === "string" && l.length > 0);
    return labels.length > 0 ? labels : undefined;
  }
  return q.options[selectedIndex]?.label;
}
