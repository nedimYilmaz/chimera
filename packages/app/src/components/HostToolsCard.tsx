import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { displayChord, isEditableTarget, registerActionHandler, runAction } from "../keymap";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { getHostCommands } from "../state/commands.host";
import { cursoredProfile, fmtScanAge, modeTone } from "../state/selectors.host";
import { HINTS, EMPTY } from "../copy";
import styles from "./HostToolsCard.module.css";

// W8 — the host-tools card (mock showHostTools, lines 409-431; coverage B14):
// OverlayCard center 760 mounted through the OverlayOutlet on every screen's
// right column. Columns host / tool / version / profiles-contexts / agent
// access; local rows editable (space cycles the WILDCARD mode allow→ask→deny,
// p enters the per-profile edit cursor), remote ⇅ peer rows read-only (policy
// is the peer's — the row says so). mod+d toggles (bound on every scope EXCEPT
// "agents" — letter-budget trade, reachable there only via the command
// palette, mod+b); esc closes (profile-edit exits first); every mutation
// renders optimistically and reconciles from the next host.tools fetch
// (commands.host.ts). Mouse affordances dispatch the SAME action ids the
// keyboard uses (PLAN §0.4 parity).

const FOOT_HINT = HINTS.hostToolsFoot;
const FOOT_NOTE = HINTS.hostToolsNote;
const AGE_NOTE = HINTS.hostToolsAgeNote;

export function HostToolsCard({ bottomInset }: OverlayProps) {
  const cmds = getHostCommands(appStore, rpcCall);
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);

  // mod+d (rows.host.ts, every scope but agents) resolves to "host.toggle" —
  // the handler lives here because the outlet keeps this component mounted on
  // every screen (it renders null while closed).
  useEffect(() => registerActionHandler("host.toggle", () => cmds.toggle()), [cmds]);

  // Open-only registrations: the card's capture listener AND the mouse
  // affordances below both dispatch through these ids (keyboard parity).
  useEffect(() => {
    if (!state.open) return;
    const offs = [
      registerActionHandler("host.up", () => cmds.move(-1)),
      registerActionHandler("host.down", () => cmds.move(1)),
      registerActionHandler("host.cycle", () => void cmds.cycle()),
      registerActionHandler("host.profileEdit", () => cmds.profileEdit()),
    ];
    return () => { for (const off of offs) off(); };
  }, [state.open, cmds]);

  // Capture-phase keys while open (QuestionCard pattern): the per-tab
  // up/down rows would win resolveChord otherwise (HOST_ROWS compose last),
  // so the card claims its chords directly and stops propagation. esc stays
  // with OverlayCard's own capture handler (onClose → cmds.escape tiering);
  // mod+d re-toggle stays with the keymap row (every scope but agents).
  useEffect(() => {
    if (!state.open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const run = (action: string): void => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        runAction(action, appStore);
      };
      if (ev.key === "ArrowUp") { run("host.up"); return; }
      if (ev.key === "ArrowDown") { run("host.down"); return; }
      if (ev.key === " ") { run("host.cycle"); return; }
      if (ev.key === "p") { run("host.profileEdit"); return; }
      // ←→ only act inside the per-profile edit cursor (mock has no row use for them)
      if (cmds.getState().profileCursor !== null && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        cmds.moveProfileCursor(ev.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [state.open, cmds]);

  // The header's "last scan Xm ago" ages while the card sits open.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!state.open) return;
    setNowTick(Date.now());
    const t = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [state.open, state.fetchedAt]);

  // HOST-TOOLS-PER-ROW: every discovered tool is its own row now, so the
  // list can scroll (.body: max-height + overflow-y:auto) — keep the
  // selected row in view as up/down moves past the fold.
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state.open) selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.open, state.selected]);

  // HOST-TOOLS-PROFILE-VISIBILITY: keep the cursored profile chip visible in
  // .cellProfiles too — its horizontal ellipsis clips chips past the fixed
  // cell width, so a cursor on a clipped profile was otherwise invisible.
  // block:"nearest" keeps this scroll from fighting selectedRowRef's own
  // vertical scroll of the (overflow-y:auto) row list above.
  const cursoredPartRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (state.open && state.profileCursor !== null) {
      cursoredPartRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [state.open, state.profileCursor, state.selected]);

  if (!state.open) return null;

  const rows = cmds.rows();
  const cursored = cursoredProfile(rows[state.selected], state.reply, state.profileCursor);

  return (
    <OverlayCard width={760} align="center" bottomInset={bottomInset} onClose={() => cmds.escape()}>
      <div data-host-tools-card>
        <OverlayCardHeader
          title="host tools"
          meta="auto-discovery"
          hint={<span title={AGE_NOTE}>{fmtScanAge(state.fetchedAt, nowTick)} · {displayChord("mod+d")} / esc</span>}
        />
        <div className={styles.colHead}>
          <div className={styles.colHost}>host</div>
          <div className={styles.colTool}>tool</div>
          <div className={styles.colVersion}>version</div>
          <div className={styles.colProfiles}>profiles / contexts</div>
          <div className={styles.colAccess}>agent access</div>
        </div>
        <div className={styles.body}>
          {state.reply === null ? (
            <div className={styles.emptyHint}>{EMPTY.hostToolsScanning}</div>
          ) : rows.length === 0 ? (
            <div className={styles.emptyHint}>{EMPTY.hostToolsNone}</div>
          ) : (
            rows.map((row, i) => {
              const selected = i === state.selected;
              const editingThisRow = selected && state.profileCursor !== null;
              const rowClass = [styles.row, row.sep ? styles.rowSep : null, selected ? styles.rowSelected : null]
                .filter(Boolean)
                .join(" ");
              const profilesCellClass = editingThisRow
                ? `${styles.cellProfiles} ${styles.cellProfilesEditing}`
                : styles.cellProfiles;
              return (
                <div
                  key={row.key}
                  ref={selected ? selectedRowRef : null}
                  className={rowClass}
                  onClick={() => cmds.select(i)}
                  data-host-row={row.key}
                >
                  <div className={row.remote ? styles.cellHostRemote : styles.cellHost}>{row.hostMark ?? ""}</div>
                  <div className={styles.cellTool}>{row.name}</div>
                  <div className={styles.cellVersion}>{row.version}</div>
                  <div className={profilesCellClass}>
                    {row.profileLabel !== null && <span>{row.profileLabel}: </span>}
                    {row.profileParts.map((p, pi) => {
                      const isCursor = selected && state.profileCursor === pi && row.profileTools.length > 0;
                      const cls = [p.danger ? styles.profDanger : null, isCursor ? styles.profCursor : null]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <span key={pi} ref={isCursor ? cursoredPartRef : null}>
                          {pi > 0 && " · "}
                          <span className={cls === "" ? undefined : cls}>{p.text}</span>
                        </span>
                      );
                    })}
                  </div>
                  <div
                    className={styles.cellAccess}
                    onClick={(e) => {
                      // mouse = the keyboard's action id (select, then space)
                      e.stopPropagation();
                      cmds.select(i);
                      runAction("host.cycle", appStore);
                    }}
                  >
                    {row.access.map((seg, si) => (
                      <span key={si}>
                        {si > 0 && " · "}
                        <span className={styles[`mode_${modeTone(seg.mode)}`]}>{seg.mode}</span>
                        {seg.names !== null && <span className={styles.accessNames}> {seg.names}</span>}
                      </span>
                    ))}
                    {row.peerNote !== null && <span className={styles.accessNames}> {row.peerNote}</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className={styles.footer}>
          <span className={styles.footHint}>
            {cursored !== null
              ? HINTS.hostToolsFootEdit(cursored.toolName, cursored.profileText, cursored.mode)
              : state.profileCursor !== null
                ? HINTS.hostToolsFootEditFallback
                : FOOT_HINT}
          </span>
          <span className={styles.footSpacer} />
          <span className={styles.footNote}>{FOOT_NOTE}</span>
        </div>
      </div>
    </OverlayCard>
  );
}

registerOverlay("host-tools", HostToolsCard, () => {
  const cmds = getHostCommands(appStore, rpcCall);
  if (cmds.getState().open) cmds.toggle();
});
