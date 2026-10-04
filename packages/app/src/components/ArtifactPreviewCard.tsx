import { useEffect, useState } from "react";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { MessageBody } from "./MessageBody";
import { appStore } from "../state/store";
import { rpcCall, readArtifactSnapshot, openArtifactSnapshot, openArtifactUrl } from "../rpc/bridge";
import { artifactsLocal, getArtifactsCommands, useArtifactsLocal } from "../state/commands.artifacts";
import { ARTIFACT_GLYPH, artifactPreviewText, formatArtifactSize, isPreviewableKind, type ArtifactRow } from "../state/selectors.artifacts";
import { isEditableTarget } from "../keymap";
import { errorText } from "../state/errorText";
import { isOpenableLinkUrl } from "./linkUrl";
import styles from "./ArtifactPreviewCard.module.css";

// F17 (W19) — the in-app artifact preview (mock's "enter" on a strip chip),
// reusing the F12 MessageBody renderer verbatim: a report's markdown content
// renders as-is, a diff/chart snapshot is wrapped in its matching fence
// (artifactPreviewText) so parseMessageBlocks/MessageBody format it exactly
// like an agent-message fence — same tables/code/chart machinery, zero
// duplication. A binary (file) or link artifact has no renderable content, so
// the card shows a placeholder pointing at "o" instead. Registered as a
// system overlay (registerOverlay) so it renders regardless of which screen
// opened it (the composer strip on Agents, or an artifact row inside
// TaskInspector on Queues).
function close(): void {
  artifactsLocal.set({ previewId: null });
}

function ArtifactPreviewCard() {
  const previewId = useArtifactsLocal((s) => s.previewId);
  const [record, setRecord] = useState<ArtifactRow | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!previewId) {
      setRecord(null);
      setContent(null);
      setError(null);
      return;
    }
    let alive = true;
    setRecord(null);
    setContent(null);
    setError(null);
    getArtifactsCommands(rpcCall)
      .get(previewId)
      .then((rec) => {
        if (!alive) return;
        setRecord(rec);
        if (!isPreviewableKind(rec.kind)) return;
        readArtifactSnapshot(rec.id)
          .then((text) => { if (alive) setContent(text); })
          .catch((err: unknown) => { if (alive) setError(errorText(err)); });
      })
      .catch((err: unknown) => { if (alive) setError(errorText(err)); });
    return () => { alive = false; };
  }, [previewId]);

  // "o" OS-opens the artifact under preview — guarded on the actual keydown
  // target so typing "o" into any editable field (composer or otherwise)
  // while a preview card is open is untouched.
  useEffect(() => {
    if (!record) return undefined;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "o" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isEditableTarget(ev.target)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      // CLICKABLE-LINKS: a "link"-kind artifact's url is agent-supplied (mcp
      // artifact.create) and unvalidated at creation — same allowlist gate as
      // an inline markdown link, so a disallowed scheme can't reach the OS
      // opener through this second path either.
      const opened =
        record.kind === "link" && record.url
          ? isOpenableLinkUrl(record.url)
            ? openArtifactUrl(record.url)
            : Promise.reject(new Error(`cannot open "${record.url}": disallowed url scheme`))
          : openArtifactSnapshot(record.id);
      void opened.catch((err: unknown) =>
        appStore.dispatch({ type: "commandError", message: errorText(err) }),
      );
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [record]);

  if (!previewId) return null;

  const meta = record
    ? `${ARTIFACT_GLYPH[record.kind]} ${record.kind}${record.sizeBytes !== null ? ` · ${formatArtifactSize(record.sizeBytes)}` : ""}`
    : "";

  return (
    <OverlayCard width={700} align="center" onClose={close}>
      <OverlayCardHeader title={record?.label ?? "artifact"} meta={meta} hint="o open · esc close" />
      <div className={styles.body} data-artifact-preview>
        {error ? (
          <div className={styles.errorNote}>{error}</div>
        ) : !record ? (
          <div className={styles.emptyNote}>loading…</div>
        ) : !isPreviewableKind(record.kind) ? (
          <div className={styles.emptyNote}>
            no in-app preview for a {record.kind} artifact — press o to open it{record.kind === "link" ? " in the browser" : " in the OS"}.
          </div>
        ) : content === null ? (
          <div className={styles.emptyNote}>loading…</div>
        ) : (
          <MessageBody text={artifactPreviewText(record.kind, content)} done rawView={false} />
        )}
      </div>
    </OverlayCard>
  );
}

registerOverlay("artifacts.preview", ArtifactPreviewCard, close);
