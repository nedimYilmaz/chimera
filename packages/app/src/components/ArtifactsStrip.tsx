import type { UiState } from "@chimera/ui-state";
import { useStore } from "../state/useStore";
import { rpcCall, readArtifactSnapshot } from "../rpc/bridge";
import { useArtifacts, useDiffMeta } from "../state/commands.artifacts";
import { displayName } from "../state/selectors";
import { ArtifactChip } from "./ArtifactChip";
import styles from "./ArtifactsStrip.module.css";

// F17 (W19) — the artifacts strip above the composer (mock showArtifacts,
// line 613-621): every artifact the SELECTED agent has registered
// (artifact.add's agentId scoping — D13), live via useArtifacts' optimistic-
// event + artifact.list-reconcile pair, so a chip appears the same tick the
// artifact_added event lands and survives the registering agent closing or a
// daemon restart (the reconcile fetch reads the daemon's persisted
// ArtifactStore either way). Hidden entirely while empty — same "null while
// nothing to show" rule as QueuedBar/A2ATicker.
export function ArtifactsStrip() {
  const selectedId = useStore((s: UiState) => s.selectedAgentId);
  const selected = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  const events = useStore((s: UiState) => s.events);
  const scope = selectedId ? { agentId: selectedId } : null;
  const items = useArtifacts(scope, events, rpcCall);
  const diffMeta = useDiffMeta(items, readArtifactSnapshot);

  if (items.length === 0) return null;
  return (
    <div className={styles.strip} data-artifacts-strip>
      <span className={styles.label}>
        <span className={styles.mark}>⛁</span> artifacts <span className={styles.count}>({items.length})</span>
      </span>
      <span className={styles.chips}>
        {items.map((row) => (
          <ArtifactChip key={row.id} row={row} diffMeta={diffMeta[row.id]} />
        ))}
      </span>
      <span className={styles.spacer} />
      <span className={styles.hint}>click preview · binary/link opens in the OS{selected ? ` · from ${displayName(selected)}` : ""}</span>
    </div>
  );
}
