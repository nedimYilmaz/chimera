import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { NormalizedEvent } from "@chimera/protocol";
import { rpcCall, readArtifactSnapshot } from "../rpc/bridge";
import { useStore } from "../state/useStore";
import { artifactRow, latestArtifactSeq, type ArtifactRow, type ArtifactScope } from "../state/selectors.artifacts";
import { errorText } from "../state/errorText";
import { designDocuments, staticDesignDocument, DESIGN_MAX_BYTES } from "../design/documents";
import { ErrorBoundary } from "./ErrorBoundary";
import { Panel } from "./Panel";
import { ChipButton } from "./ChipButton";
import styles from "./DesignWorkspace.module.css";

export type DesignRequest = <T>(method: string, params?: unknown) => Promise<T>;
type View = "conversation" | "design" | "split";
type Choice = { revision: string; tab: "preview" | "source"; width: "fit" | "390" | "768" | "1280" };
// Bounded UI preferences only; authoritative revisions remain in ArtifactStore.
const choices = new Map<string, Choice>();
function remember(key: string, choice: Choice) {
  choices.delete(key); choices.set(key, choice);
  if (choices.size > 200) choices.delete(choices.keys().next().value!);
}

export function DesignWorkspace({ scope, label, children }: { scope: ArtifactScope | null; label: string; children: ReactNode }) {
  const [view, setView] = useState<View>("conversation");
  const events = useStore((s) => s.events);
  return <div className={styles.workspace} data-design-workspace>
    <div className={styles.switches} role="group" aria-label="Inspector view">
      {(["conversation", "design", "split"] as const).map((value) => <ChipButton key={value} aria-pressed={view === value} disabled={!scope && value !== "conversation"} onClick={() => setView(value)}>{value === "split" ? "Side by side" : value === "design" ? "Design" : "Conversation"}</ChipButton>)}
    </div>
    <div className={styles.panes} data-view={scope ? view : "conversation"}>
      <div className={styles.conversation}>{children}</div>
      {scope && view !== "conversation" && <ErrorBoundary key={scopeKey(scope)} label="design" message="Design preview failed — retry or choose Conversation."><DesignPanel scope={scope} label={label} events={events} /></ErrorBoundary>}
    </div>
  </div>;
}

function scopeKey(scope: ArtifactScope): string { return "agentId" in scope ? `agent:${scope.agentId}` : `task:${scope.taskId}`; }

export function DesignPanel({ scope, label, events = [], request = rpcCall, readSnapshot = readArtifactSnapshot }: {
  scope: ArtifactScope; label: string; events?: readonly NormalizedEvent[];
  request?: DesignRequest; readSnapshot?: (id: string) => Promise<string>;
}) {
  const key = scopeKey(scope);
  const seq = latestArtifactSeq(events);
  const [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<ArtifactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>(() => choices.get(key) ?? { revision: "", tab: "preview", width: "fit" });
  const [snapshot, setSnapshot] = useState<{ id: string; text: string } | null>(null);
  const [readError, setReadError] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => { remember(key, choice); }, [key, choice]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    request<Record<string, unknown>[]>("artifact.list", scope).then((result) => {
      if (alive) { setRows(result.map(artifactRow)); setLoading(false); }
    }).catch((err: unknown) => { if (alive) { setError(errorText(err)); setLoading(false); } });
    return () => { alive = false; };
  }, [key, seq, refresh, request]);
  const documents = useMemo(() => designDocuments(rows), [rows]);
  const selectedDocument = documents.find((d) => d.revisions.some((r) => r.id === choice.revision)) ?? documents[0];
  const revision = selectedDocument?.revisions.find((r) => r.id === choice.revision) ?? selectedDocument?.revisions[0];
  const revisionId = revision?.id;
  // Pin the initially selected snapshot. New artifact events must not silently
  // replace the version the operator is currently inspecting.
  useEffect(() => {
    if (revisionId && revisionId !== choice.revision) setChoice((s) => ({ ...s, revision: revisionId }));
  }, [revisionId, choice.revision]);
  useEffect(() => {
    let alive = true;
    setSnapshot(null); setReadError(null);
    if (!revisionId) return;
    if ((revision?.sizeBytes ?? 0) > DESIGN_MAX_BYTES) {
      setReadError({ id: revisionId, text: "Design preview is limited to 1 MiB. Register a smaller self-contained HTML file." });
      return;
    }
    readSnapshot(revisionId).then((text) => {
      if (!alive) return;
      if (new TextEncoder().encode(text).byteLength > DESIGN_MAX_BYTES) throw new Error("Design preview is limited to 1 MiB.");
      setSnapshot({ id: revisionId, text });
    }).catch((err: unknown) => { if (alive) setReadError({ id: revisionId, text: errorText(err) }); });
    return () => { alive = false; };
  }, [revisionId, readSnapshot, refresh]);
  const source = snapshot && snapshot.id === revisionId ? snapshot.text : null;
  const preview = useMemo(() => source === null ? null : staticDesignDocument(source), [source]);
  return <Panel label="design" className={styles.panel}>
    <div className={styles.heading}><strong>{label}</strong><ChipButton onClick={() => setRefresh((n) => n + 1)} disabled={loading}>Refresh</ChipButton></div>
    {error && <p role="alert" className={styles.note}>{error}</p>}
    {!documents.length ? <div className={styles.empty}>
      <h3>{loading ? "Loading designs…" : "Your design canvas"}</h3>
      {!loading && <><p>Ask this agent for a self-contained HTML design, then have it register the file with <code>artifact_add</code>.</p><p>Each registration becomes a snapshot. Register the same source path again to add a revision.</p><p>HTML and CSS previews are supported. JavaScript, external assets and embedded pages are not run.</p></>}
    </div> : <>
      <div className={styles.controls}>
        <label>Design<select aria-label="Design document" value={selectedDocument!.key} onChange={(e) => setChoice((s) => ({ ...s, revision: documents.find((d) => d.key === e.target.value)!.revisions[0]!.id }))}>
          {documents.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select></label>
        <label>Revision<select aria-label="Design revision" value={revisionId} onChange={(e) => setChoice((s) => ({ ...s, revision: e.target.value }))}>
          {selectedDocument!.revisions.map((r, i, all) => <option key={r.id} value={r.id}>v{all.length - i} · {new Date(r.createdAt).toLocaleString()} · {r.id.slice(0, 8)}</option>)}
        </select></label>
      </div>
      <div className={styles.toolbar} role="group" aria-label="Design controls">
        <ChipButton aria-pressed={choice.tab === "preview"} onClick={() => setChoice((s) => ({ ...s, tab: "preview" }))}>Preview</ChipButton>
        <ChipButton aria-pressed={choice.tab === "source"} onClick={() => setChoice((s) => ({ ...s, tab: "source" }))}>Source</ChipButton>
        <label>Viewport<select aria-label="Design viewport" value={choice.width} onChange={(e) => setChoice((s) => ({ ...s, width: e.target.value as Choice["width"] }))}>
          <option value="fit">Fit</option><option value="390">Mobile · 390</option><option value="768">Tablet · 768</option><option value="1280">Desktop · 1280</option>
        </select></label>
      </div>
      <div className={styles.note}>Static preview · scripts and external resources are blocked{preview && preview.removed > 0 ? ` · ${preview.removed} unsupported elements/attributes omitted` : ""}</div>
      {readError && readError.id === revisionId ? <p role="alert" className={styles.note}>{readError.text}</p> : source === null ? <p role="status" className={styles.note}>Loading snapshot…</p> : choice.tab === "source" ? <pre className={styles.source} tabIndex={0} aria-label="Design source">{source}</pre> : <div className={styles.canvas}>
        <iframe key={revisionId} title={`Design preview: ${revision?.label}`} sandbox="" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" srcDoc={preview!.html} style={{ width: choice.width === "fit" ? "100%" : `${choice.width}px` }} />
      </div>}
    </>}
  </Panel>;
}
