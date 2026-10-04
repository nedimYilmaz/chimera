import { useEffect, useMemo } from "react";
import type { UiState } from "@chimera/ui-state";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { ArtifactChip } from "./ArtifactChip";
import { displayChord, isEditableTarget } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall, readArtifactSnapshot } from "../rpc/bridge";
import { useArtifacts, useDiffMeta } from "../state/commands.artifacts";
import { derivedState, displayName, stateVisual } from "../state/selectors";
import { resultMetaParts } from "../state/selectors.system";
import styles from "./ResultCard.module.css";

// W6 build item 2 — the ResultCard (mock showResult, lines 350-364): 680 card,
// header "result" + agent name + state word + the "$ · tok · turns · duration"
// meta, the resultText body, footer [mod+y copy] / "enter open transcript" /
// "esc close". KEYMAP-REDESIGN: system.result was retired as a keyboard chord
// (letter-budget trade) — it no longer has a dedicated opener; SystemCommands.
// toggleResult is now click-only (plus the command palette, mod+b, on
// non-agents tabs), which fetches agent.result+agent.status into the EXISTING
// resultDetail state path (ui-state's agentResult action) before flipping
// resultOpen.
function copyResult(text: string): void {
  const done = (): void =>
    appStore.dispatch({ type: "notice", message: `${text.length} characters copied to clipboard` });
  // navigator.clipboard needs a secure context (tauri/https/localhost) — fall
  // back to the execCommand path so the copy also works on a LAN dev origin.
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
  } else {
    legacyCopy(text, done);
  }
}

function legacyCopy(text: string, done: () => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } finally {
    ta.remove();
  }
}

function ResultCard() {
  const open = useStore((s: UiState) => s.resultOpen);
  const agent = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));
  const events = useStore((s: UiState) => s.events);
  const detail = agent?.resultDetail ?? null;

  const meta = useMemo(
    () => (agent && detail ? resultMetaParts(detail, agent, events, agent.agentId).join(" · ") : ""),
    [agent, detail, events],
  );

  // F17 (W19): "ResultCard lists its OWN artifacts" — this agent's own
  // agentId-scoped registrations, same useArtifacts optimistic+reconcile pair
  // as the composer strip.
  const artifactScope = agent ? { agentId: agent.agentId } : null;
  const artifacts = useArtifacts(artifactScope, events, rpcCall);
  const diffMeta = useDiffMeta(artifacts, readArtifactSnapshot);

  const close = (): void => appStore.dispatch({ type: "resultOpen", open: false });
  const text = detail?.result.text ?? "";

  // mod+y copy + enter → close & focus transcript. Capture-phase so the copy
  // works while the composer owns focus; the AgentsScreen's earlier-mounted
  // capture handler keeps priority for permission mod+y (A3/TUI-017) — it
  // stops propagation when a permission is pending, so this only sees the key
  // when the card genuinely owns it. Enter is ignored on editable targets
  // (the composer's enter still sends).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key === "y") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        copyResult(text);
        return;
      }
      // enter closes, as long as the actually-focused element isn't editable
      // (the TUI-001 bare-key rule the permission chords already follow) —
      // guarded on the real keydown target, not the composer's draft length.
      if (ev.key === "Enter" && !isEditableTarget(ev.target)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        close();
        appStore.dispatch({ type: "selectTab", tab: "agents" });
        (document.querySelector("[data-compose-input]") as HTMLElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, text]);

  if (!open || !agent || !detail) return null;
  const sv = stateVisual(derivedState(agent));

  return (
    <OverlayCard width={680} align="center" onClose={close}>
      <OverlayCardHeader
        title="result"
        meta={
          <>
            {displayName(agent)}{" "}
            <span className={styles[sv.tone]}>{sv.glyph} {derivedState(agent)}</span>
          </>
        }
        hint={meta}
      />
      <div className={styles.body} data-result-text>
        {text || <span className={styles.emptyNote}>no result text — state {detail.result.state}</span>}
      </div>
      {artifacts.length > 0 ? (
        <div className={styles.artifacts} data-result-artifacts>
          <span className={styles.artifactsLabel}>artifacts</span>
          {artifacts.map((row) => (
            <ArtifactChip key={row.id} row={row} diffMeta={diffMeta[row.id]} />
          ))}
        </div>
      ) : null}
      <div className={styles.footer}>
        <span className={styles.copyChip} onClick={() => copyResult(text)} data-result-copy>
          <span className={styles.copyKey}>{displayChord("mod+y")}</span>
          <span className={styles.copyVerb}> copy</span>
        </span>
        <span
          className={styles.openChip}
          onClick={() => {
            close();
            appStore.dispatch({ type: "selectTab", tab: "agents" });
          }}
        >
          enter open transcript
        </span>
        <span className={styles.spacer} />
        <span className={styles.hint}>esc close</span>
      </div>
    </OverlayCard>
  );
}

registerOverlay("system.result", ResultCard);
