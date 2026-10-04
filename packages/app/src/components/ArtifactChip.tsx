import type { ArtifactRow } from "../state/selectors.artifacts";
import { ARTIFACT_GLYPH, formatArtifactSize, isPreviewableKind } from "../state/selectors.artifacts";
import { artifactsLocal } from "../state/commands.artifacts";
import { openArtifactSnapshot, openArtifactUrl } from "../rpc/bridge";
import { appStore } from "../state/store";
import { errorText } from "../state/errorText";
import styles from "./ArtifactChip.module.css";

// F17 (W19) — one artifact chip, shared by the composer strip, ResultCard's
// and TaskInspector's own-artifact lists (mock: "▤ report.md 4.2k" / "±
// perf.patch +120 −8" / "▙ bench chart"). A click on a previewable kind
// (report/diff/chart) opens the in-app preview card (mock's "enter"); a
// binary/link kind has no preview, so a click OS-opens it directly instead
// (mock's "o") — there being nothing else useful for a click to do there.
export function ArtifactChip({ row, diffMeta }: { row: ArtifactRow; diffMeta?: { plus: number; minus: number } }) {
  const meta =
    row.kind === "diff" && diffMeta ? (
      <>
        {" "}
        <span className={styles.plus}>+{diffMeta.plus}</span> <span className={styles.minus}>−{diffMeta.minus}</span>
      </>
    ) : row.sizeBytes !== null ? (
      <span className={styles.size}> {formatArtifactSize(row.sizeBytes)}</span>
    ) : null;

  const onOpenError = (err: unknown): void => {
    appStore.dispatch({ type: "commandError", message: errorText(err) });
  };

  const onClick = (): void => {
    if (isPreviewableKind(row.kind)) {
      artifactsLocal.set({ previewId: row.id });
      return;
    }
    if (row.kind === "link" && row.url) {
      void openArtifactUrl(row.url).catch(onOpenError);
      return;
    }
    void openArtifactSnapshot(row.id).catch(onOpenError);
  };

  return (
    <button type="button" className={styles.chip} onClick={onClick} title={row.label} data-artifact-chip={row.id}>
      <span className={styles.glyph}>{ARTIFACT_GLYPH[row.kind]}</span> {row.label}
      {meta}
    </button>
  );
}
