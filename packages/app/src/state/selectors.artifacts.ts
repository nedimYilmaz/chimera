// F17 (W19 artifacts & deliverables, coverage B21/C15) — PURE selectors/
// formatters for the artifacts strip (Composer), ResultCard's and
// TaskInspector's own-artifact lists, and the in-app preview card. Same
// discipline as selectors.workflows.ts: plain functions over the loosely-
// typed artifact.list/get payload (read defensively — daemon-side field
// drift must never crash a pane), no React, no store import.
import type { ArtifactKind, NormalizedEvent } from "@chimera/protocol";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Mirrors protocol's ArtifactKindSchema literals (D13) — the app narrows raw
// RPC JSON defensively rather than trusting the wire shape (workflows.ts's
// GATE_KINDS precedent), while still typing against the canonical protocol
// ArtifactKind so the two can never silently drift apart at the type level.
const ARTIFACT_KINDS: readonly ArtifactKind[] = ["report", "diff", "chart", "file", "link"];

function kindOf(v: unknown): ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(v as string) ? (v as ArtifactKind) : "file";
}

export type ArtifactRow = {
  id: string;
  kind: ArtifactKind;
  label: string;
  agentId: string | null;
  taskId: string | null;
  createdAt: number;
  sizeBytes: number | null;
  path: string | null;
  url: string | null;
};

/** Projects an artifact.list/get reply (protocol ArtifactRecord) into the row
 * shape every F17 surface reads. */
export function artifactRow(rec: Record<string, unknown>): ArtifactRow {
  return {
    id: str(rec["id"]),
    kind: kindOf(rec["kind"]),
    label: str(rec["label"]) || str(rec["id"]),
    agentId: typeof rec["agentId"] === "string" ? (rec["agentId"] as string) : null,
    taskId: typeof rec["taskId"] === "string" ? (rec["taskId"] as string) : null,
    createdAt: num(rec["createdAt"]),
    sizeBytes: typeof rec["sizeBytes"] === "number" ? (rec["sizeBytes"] as number) : null,
    path: typeof rec["path"] === "string" ? (rec["path"] as string) : null,
    url: typeof rec["url"] === "string" ? (rec["url"] as string) : null,
  };
}

// the strip/list chip's kind glyph (F17: "chips = kind glyph + label + meta")
export const ARTIFACT_GLYPH: Record<ArtifactKind, string> = {
  report: "▤", // ▤
  diff: "±", // ±
  chart: "▙", // ▙
  file: "▪", // ▪
  link: "↗", // ↗
};

/** "512b" / "4.2k" / "1.3M" — the report/file/chart chip's size meta. */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** ±N lines for a diff artifact's snapshot text (unified-diff convention: a
 * leading +/- on a content line — the `+++`/`---` file-header lines never
 * count). Used for BOTH the chip's ±lines meta and the in-app diff preview. */
export function countDiffLines(text: string): { plus: number; minus: number } {
  let plus = 0;
  let minus = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) plus++;
    else if (line.startsWith("-")) minus++;
  }
  return { plus, minus };
}

/** Wraps a snapshot's raw content for F12's MessageBody: a diff/chart
 * snapshot becomes a fenced ```diff/```chart block so the shared renderer
 * (parseMessageBlocks) picks it up exactly like an agent-message fence; a
 * report's markdown content is used verbatim. */
export function artifactPreviewText(kind: ArtifactKind, content: string): string {
  if (kind === "diff") return "```diff\n" + content + "\n```";
  if (kind === "chart") return "```chart\n" + content + "\n```";
  return content;
}

/** true for the kinds the in-app preview can render (F17: "enter → in-app
 * preview reusing the F12 renderer (md/diff/chart)"); file/link fall back to
 * OS-open only ("`o` → OS open for binaries"). */
export function isPreviewableKind(kind: ArtifactKind): boolean {
  return kind === "report" || kind === "diff" || kind === "chart";
}

// ---------------------------------------------------------------------------
// optimistic overlay + reconcile (artifact_added) — F16's latestStepEvent/
// latestCoordSeq precedent (selectors.workflows.ts / selectors.coord.ts)
// ---------------------------------------------------------------------------

/** Builds an optimistic row straight off one artifact_added event's payload
 * (D13: `{id, kind, label, agentId, taskId, sizeBytes}`) — enough to render a
 * chip the SAME tick the event lands, ahead of the artifact.list reconcile
 * that fills in path/url/createdAt. */
export function artifactFromEvent(e: Pick<NormalizedEvent, "kind" | "data" | "ts">): ArtifactRow | null {
  if (e.kind !== "artifact_added" || !e.data) return null;
  return {
    id: str(e.data["id"]),
    kind: kindOf(e.data["kind"]),
    label: str(e.data["label"]) || str(e.data["id"]),
    agentId: typeof e.data["agentId"] === "string" ? (e.data["agentId"] as string) : null,
    taskId: typeof e.data["taskId"] === "string" ? (e.data["taskId"] as string) : null,
    createdAt: e.ts,
    sizeBytes: typeof e.data["sizeBytes"] === "number" ? (e.data["sizeBytes"] as number) : null,
    path: null,
    url: null,
  };
}

export type ArtifactScope = { agentId: string } | { taskId: string };

function inScope(row: ArtifactRow, scope: ArtifactScope): boolean {
  return "agentId" in scope ? row.agentId === scope.agentId : row.taskId === scope.taskId;
}

/** Every optimistic row for one scope (agent or task) still in the ring
 * buffer, oldest first — mergeArtifacts below de-dupes against the reconciled
 * fetch by id. */
export function optimisticArtifacts(
  events: ReadonlyArray<Pick<NormalizedEvent, "kind" | "data" | "ts">>,
  scope: ArtifactScope,
): ArtifactRow[] {
  const out: ArtifactRow[] = [];
  for (const e of events) {
    const row = artifactFromEvent(e);
    if (row && inScope(row, scope)) out.push(row);
  }
  return out;
}

/** Fetched (authoritative artifact.list reply) wins by id; any optimistic row
 * not yet reconciled stays appended in event order — F17's "optimistic +
 * reconcile" persistence rule. */
export function mergeArtifacts(fetched: readonly ArtifactRow[], optimistic: readonly ArtifactRow[]): ArtifactRow[] {
  const seen = new Set(fetched.map((r) => r.id));
  return [...fetched, ...optimistic.filter((r) => !seen.has(r.id))];
}

/** The newest seq among artifact_added events — the reconcile trigger
 * (latestCoordSeq/latestJobSeq precedent): any surface watching this refetches
 * artifact.list. 0 when none. */
export function latestArtifactSeq(events: ReadonlyArray<Pick<NormalizedEvent, "seq" | "kind">>): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === "artifact_added") return events[i]!.seq;
  return 0;
}
