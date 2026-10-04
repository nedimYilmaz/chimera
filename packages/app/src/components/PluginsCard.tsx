import { useEffect } from "react";
import type { UiState } from "@chimera/ui-state";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { registerOverlay, type OverlayProps } from "./OverlayOutlet";
import { isEditableTarget, registerActionHandler, runAction } from "../keymap";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall } from "../rpc/bridge";
import { getProjectsCommands, projectsLocal, useProjectsLocal } from "../state/commands.projects";
import { agentSkillRows, type PluginRowView } from "../state/selectors.projects";
import { displayName } from "../state/selectors";
import { HINTS, EMPTY } from "../copy";
import styles from "./PluginsCard.module.css";

// W7 — the plugins & commands card (mock showPlugins, lines 387-408; coverage
// B13): OverlayCard center 700 mounted through the OverlayOutlet on every
// screen. Rows = plugins.list's global catalog (skills ~/.claude/skills,
// marketplace plugins) + PROJECT commands for the SELECTED agent's cwd
// (agent.status → spec.cwd feeds plugins.list {cwd}) + the selected agent's
// spawn-spec skills from AgentView (system/init advertisement). space toggles
// via plugins.toggle (persisted daemon-side); the footer states the
// new-spawns-only rule VERBATIM from the mock. enter expands the selected
// row's full id/source detail. mod+y toggles (rows.projects.ts documents the
// chord decision — the mock's card declares none; bound on every scope EXCEPT
// "agents", letter-budget trade, reachable there only via the command
// palette, mod+b); esc closes (OverlayCard).
//
// This component is ALSO the slash-popup's project-command feeder: while
// mounted (always — the outlet renders it on every screen; it returns null
// when closed) it watches the selected agent and refreshes the plugins-list
// cache, which SlashPopup reads for its agent-scope "/deploy" extras.

const FOOT_HINT = HINTS.pluginsFoot;
const FOOT_NOTE = HINTS.pluginsNote;

export function PluginsCard({ bottomInset }: OverlayProps) {
  const commands = getProjectsCommands(appStore, rpcCall);
  const open = useProjectsLocal((s) => s.pluginsOpen);
  const catalog = useProjectsLocal((s) => s.pluginCatalog);
  const overrides = useProjectsLocal((s) => s.pluginOverrides);
  const pluginIdx = useProjectsLocal((s) => s.pluginIdx);
  const expanded = useProjectsLocal((s) => s.pluginDetail);
  const selectedAgentId = useStore((s: UiState) => s.selectedAgentId);
  const selectedAgent = useStore((s: UiState) => (s.selectedAgentId ? s.agents[s.selectedAgentId] : undefined));

  // mod+y (rows.projects.ts, every scope but agents) → toggle; registered here
  // because the outlet keeps this component mounted on every screen (HostToolsCard pattern).
  useEffect(() => registerActionHandler("plugins.toggleCard", () => {
    const s = projectsLocal.getState();
    projectsLocal.set({ pluginsOpen: !s.pluginsOpen, pluginDetail: false });
    if (!s.pluginsOpen) void commands.loadPluginCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Slash-popup feeder + open-card refresh: re-fetch the catalog whenever the
  // SELECTED agent changes (its cwd decides which project's commands exist).
  useEffect(() => {
    if (selectedAgentId) void commands.loadPluginCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId]);

  // Open-only registrations + capture-phase keys (HostToolsCard pattern): the
  // agents/coord up/down rows would win resolveChord otherwise; space/enter
  // are unclaimed but must not leak into the screen below the scrim.
  useEffect(() => {
    if (!open) return;
    const liveRows = (): PluginRowView[] => {
      const s = projectsLocal.getState();
      return rowsFor(s.pluginCatalog, selectedAgent?.skills, agentLabel(), s.pluginOverrides);
    };
    const offs = [
      registerActionHandler("plugins.up", () => {
        projectsLocal.set({ pluginIdx: Math.max(0, projectsLocal.getState().pluginIdx - 1), pluginDetail: false });
      }),
      registerActionHandler("plugins.down", () => {
        projectsLocal.set({ pluginIdx: Math.min(Math.max(0, liveRows().length - 1), projectsLocal.getState().pluginIdx + 1), pluginDetail: false });
      }),
      registerActionHandler("plugins.toggle", () => {
        const row = liveRows()[projectsLocal.getState().pluginIdx];
        if (row) void commands.togglePlugin(row.id, !row.enabled);
      }),
      registerActionHandler("plugins.detail", () => {
        projectsLocal.set({ pluginDetail: !projectsLocal.getState().pluginDetail });
      }),
    ];
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const run = (action: string): void => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        runAction(action, appStore);
      };
      if (ev.key === "ArrowUp") { run("plugins.up"); return; }
      if (ev.key === "ArrowDown") { run("plugins.down"); return; }
      if (ev.key === " ") { run("plugins.toggle"); return; }
      if (ev.key === "Enter") { run("plugins.detail"); }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      for (const off of offs) off();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedAgent]);

  function agentLabel(): string {
    return selectedAgent ? displayName(selectedAgent) : "—";
  }

  if (!open) return null;

  const rows = rowsFor(catalog, selectedAgent?.skills, agentLabel(), overrides);
  const idx = Math.min(pluginIdx, Math.max(0, rows.length - 1));

  return (
    <OverlayCard width={700} align="center" bottomInset={bottomInset} onClose={() => projectsLocal.set({ pluginsOpen: false })}>
      <div data-plugins-card>
        <OverlayCardHeader title="plugins & commands" meta="claude native" hint="esc close" />
        <div className={styles.colHead}>
          <div className={styles.colName}>name</div>
          <div className={styles.colType}>type</div>
          <div className={styles.colScope}>scope</div>
          <div className={styles.colSource}>source</div>
          <div className={styles.colState}>state</div>
        </div>
        <div className={styles.body}>
          {rows.length === 0 ? (
            <div className={styles.emptyHint}>{EMPTY.pluginsCatalog}</div>
          ) : (
            rows.map((row, i) => {
              const selected = i === idx;
              return (
                <div key={row.id + row.scope}>
                  <div
                    className={selected ? styles.rowSelected : styles.row}
                    onClick={() => projectsLocal.set({ pluginIdx: i, pluginDetail: false })}
                    data-plugin-row={row.id}
                  >
                    <div className={selected ? styles.cellNameSel : styles.cellName}>{row.kind === "command" ? `/${row.name}` : row.name}</div>
                    <div className={styles.cellType}>{row.kind}</div>
                    <div className={styles.cellScope}>{row.scope}</div>
                    <div className={styles.cellSource}>{row.source}</div>
                    <div
                      className={styles.cellState}
                      onClick={(e) => {
                        // mouse = the keyboard's action id (select, then space)
                        e.stopPropagation();
                        projectsLocal.set({ pluginIdx: i });
                        runAction("plugins.toggle", appStore);
                      }}
                      data-plugin-state={row.id}
                    >
                      {row.enabled ? <span className={styles.stateOn}>on</span> : <span className={styles.stateOff}>off</span>}
                    </div>
                  </div>
                  {selected && expanded && (
                    <div className={styles.detailLine}>
                      {row.id} · {row.source}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className={styles.footer}>
          <span className={styles.footHint}>{FOOT_HINT}</span>
          <span className={styles.footSpacer} />
          <span className={styles.footNote}>{FOOT_NOTE}</span>
        </div>
      </div>
    </OverlayCard>
  );
}

/** Card rows: the fetched catalog (global skills/plugins + project commands)
 * followed by the selected agent's spawn-spec skills (deduped by name; toggle
 * replies for these non-cataloged ids re-render via `overrides`). */
function rowsFor(catalog: PluginRowView[], skills: readonly string[] | undefined, agentLabel: string, overrides: Readonly<Record<string, boolean>> = {}): PluginRowView[] {
  return [...catalog, ...agentSkillRows(skills, agentLabel, catalog, overrides)];
}

registerOverlay("plugins", PluginsCard, () => {
  if (projectsLocal.getState().pluginsOpen) projectsLocal.set({ pluginsOpen: false, pluginDetail: false });
});
