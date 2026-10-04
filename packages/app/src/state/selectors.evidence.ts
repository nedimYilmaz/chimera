// FEATURE-10 (Changes & Evidence Review) — PURE selectors over an evidence.get reply
// (protocol TaskEvidence, already schema-validated server-side — unlike
// selectors.artifacts.ts's defensive Record<string,unknown> reads, evidence.get is on the
// FEATURE-8 RpcContract, so the app can type against @chimera/protocol directly). No React,
// no store import — same discipline as selectors.workflows.ts/selectors.artifacts.ts.
import type { EvidenceProvenanceEntry, EvidenceStep } from "@chimera/protocol";
import { fmtDurationSec } from "./selectors";

const STEP_GLYPH: Record<string, string> = { passed: "●", failed: "✗", retried: "↻" };

/** Mirrors TaskInspector's GATE_STATE_GLYPH table, but keyed on stepHistory's own
 * outcome (passed/failed/retried) rather than the current-cursor-relative done/current/
 * failed/pending state — an evidence row is always a COMPLETED (or still-open) attempt,
 * never "pending". */
export function evidenceStepGlyph(step: EvidenceStep): string {
  return step.outcome ? (STEP_GLYPH[step.outcome] ?? "○") : "◐";   // null outcome = still open (crash-mid-step)
}

/** One display line per step: glyph + title (falling back to the raw stepId when the
 * pinned workflow no longer has a matching step def) + gate kind + duration. */
export function evidenceStepLine(step: EvidenceStep): string {
  const duration = step.startedAt !== null && step.endedAt !== null ? fmtDurationSec(step.endedAt - step.startedAt) : null;
  const gate = step.gate ? ` [${step.gate.kind}]` : "";
  return `${evidenceStepGlyph(step)} ${step.title ?? step.stepId}${gate}${duration !== null ? ` (${duration})` : ""}`;
}

export type EvidenceDiffTotals = { filesChanged: number; insertions: number; deletions: number };

export function evidenceDiffSummary(entry: EvidenceProvenanceEntry): EvidenceDiffTotals {
  if (!entry.diff.available) return { filesChanged: 0, insertions: 0, deletions: 0 };
  const insertions = entry.diff.files.reduce((sum, f) => sum + f.insertions, 0);
  const deletions = entry.diff.files.reduce((sum, f) => sum + f.deletions, 0);
  return { filesChanged: entry.diff.files.length, insertions, deletions };
}

/** One summary line per provenance entry — the "branch · state · N files (+i/-d)" text
 * the panel renders above each entry's file list. */
export function evidenceProvenanceLine(entry: EvidenceProvenanceEntry): string {
  if (!entry.diff.available) return `${entry.branch} · no diff available: ${entry.diff.reason}`;
  const { filesChanged, insertions, deletions } = evidenceDiffSummary(entry);
  const fileWord = `${filesChanged} file${filesChanged === 1 ? "" : "s"} (+${insertions}/−${deletions})`;
  if (entry.diff.source === "merged") {
    const short = entry.diff.mergeCommitSha ? entry.diff.mergeCommitSha.slice(0, 7) : "?";
    return `${entry.branch} · merged ${short} · ${fileWord}`;
  }
  const dirty = entry.diff.dirty ? ` · dirty(${entry.diff.dirty})` : "";
  return `${entry.branch} · live · ${fileWord}${dirty}`;
}

const FILE_STATUS_GLYPH: Record<string, string> = { added: "+", modified: "~", deleted: "−", renamed: "→" };

export function evidenceFileStatusGlyph(status: string): string {
  return FILE_STATUS_GLYPH[status] ?? "~";
}
