import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UiState } from "@chimera/ui-state";
import { useStore } from "../state/useStore";
import { useConnState } from "../rpc/useConnState";
import { displayChord, registerActionHandler } from "../keymap";
import { Composer } from "../components/Composer";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { SpawnCard } from "../components/SpawnCard";
import { AddProviderForm } from "../components/AddProviderForm";
import { PathPicker } from "../components/PathPicker";
import { composerLocal, useComposerLocal } from "../state/commands.agents";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { getSettingsCommands } from "../state/commands.settings";
import { buildProviderCatalogRows, providerOptionsFor, initialProviderFor, validateImportDir } from "../state/selectors.settings";
import settingsStyles from "./SettingsScreen.module.css";
import styles from "./WelcomeScreen.module.css";

const settingsCmds = getSettingsCommands(appStore, rpcCall);

// W6 build item 11 — the WelcomeScreen (mock s_welcome, lines 802-819): shown
// by App when the agents tab is active with an EMPTY agentOrder (coverage
// B11: "empty agentOrder + live status line; ❯ type → A2; disappears on the
// first message"). The status line is LIVE (conn state + first account + peers).
// The composer band rides along so "❯ type a message" genuinely starts the A2
// lazy-main flow — the first agent_started flips agentOrder non-empty and App
// swaps back to the AgentsScreen (same store, nothing to hand over). mod+o's
// spawn form works here too (the same registry action id AgentsScreen binds).
export function WelcomeScreen() {
  const conn = useConnState();
  const accounts = useStore((s: UiState) => s.accounts);
  const peers = useStore((s: UiState) => s.peers);
  const spawnOpen = useComposerLocal((s) => s.spawnOpen);

  // mod+o parity while the AgentsScreen (its usual owner) is unmounted.
  useEffect(
    () => registerActionHandler("agents.spawn", () => composerLocal.set({ spawnOpen: !composerLocal.getState().spawnOpen })),
    [],
  );

  // decision-card inset parity with AgentsScreen (the outlet's strips/cards
  // float above the composer band).
  const bandRef = useRef<HTMLDivElement | null>(null);
  const [bottomInset, setBottomInset] = useState(48);
  useEffect(() => {
    const el = bandRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setBottomInset(el.offsetHeight + 8));
    ro.observe(el);
    setBottomInset(el.offsetHeight + 8);
    return () => ro.disconnect();
  }, []);

  const first = accounts[0];

  // ONBOARDING-PROVIDER: a fresh install has zero accounts — daemon.status's 5s poll
  // (App.tsx) keeps `accounts` live, so the moment one is added this flips back to the
  // normal spawn-first-agent welcome with no extra wiring needed.
  const noAccounts = accounts.length === 0;
  const settingsState = useSyncExternalStore(settingsCmds.subscribe, settingsCmds.getState);
  useEffect(() => {
    if (noAccounts) void settingsCmds.loadProviders();
    if (!settingsState.loaded.general) void settingsCmds.loadGeneral();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noAccounts]);
  const catalogRows = buildProviderCatalogRows(settingsState.providers);
  const providerOptions = providerOptionsFor(catalogRows);

  // ONBOARDING-GATE R1: the project import dir field — same edit/save/cancel
  // shape and wording as Settings→general's row (settingsStyles reused so the
  // two surfaces render identically), prefilled from the effective config.
  // This doubles as the MAIN conductor's cwd (part 1, MAIN-CONDUCTOR-PERSISTENT).
  const [dirDraft, setDirDraft] = useState<string | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const editingDir = dirDraft !== null;
  const startEditDir = (): void => { setDirError(null); setDirDraft(settingsState.projectImportDir ?? ""); };
  const submitDir = async (): Promise<void> => {
    if (dirDraft === null || dirBusy) return;
    const parsed = validateImportDir(dirDraft);
    if (!parsed.ok) { setDirError(parsed.error); return; }
    setDirBusy(true);
    const ok = await settingsCmds.setProjectImportDir(parsed.value);
    setDirBusy(false);
    if (ok) { setDirDraft(null); setDirError(null); }
  };

  return (
    <div className={styles.wrap} data-welcome-screen>
      <div className={styles.column}>
        <div className={styles.panel}>
          <div className={styles.center}>
            <div className={styles.brandBlock}>
              <div className={styles.brand}>◆ chimera</div>
              <div className={styles.tagline}>one daemon · many heads — provider-agnostic agent orchestration</div>
            </div>
            <div className={settingsStyles.kvRow} data-welcome-import-dir>
              <span className={settingsStyles.kvLabel}>project import dir</span>
              {editingDir ? (
                <>
                  <PathPicker
                    value={dirDraft ?? ""}
                    onChange={setDirDraft}
                    mode="directory"
                    placeholder="$CHIMERA_HOME/projects"
                    className={settingsStyles.input}
                    dataAttr="welcome-import-dir"
                  />
                  <button className={settingsStyles.primaryBtn} disabled={dirBusy} onClick={() => void submitDir()} data-import-dir-save>save</button>
                  <button className={settingsStyles.ghostBtn} onClick={() => { setDirDraft(null); setDirError(null); }}>cancel</button>
                </>
              ) : (
                <>
                  <span className={settingsStyles.value} data-import-dir-value>{settingsState.projectImportDir ?? "$CHIMERA_HOME/projects"}</span>
                  <button className={settingsStyles.linkBtn} onClick={startEditDir} data-import-dir-edit>edit</button>
                  <span className={settingsStyles.faint}>base dir for git-imported projects (also the main conductor's working dir)</span>
                </>
              )}
            </div>
            {dirError && <div className={settingsStyles.errorLine}>{dirError}</div>}
            {noAccounts ? (
              <div className={styles.onboarding} data-welcome-onboarding>
                <div className={styles.onboardingExplainer}>
                  connect a provider to start spawning agents — an api key, or for claude/codex, your existing CLI subscription.
                </div>
                <AddProviderForm
                  initialProvider={initialProviderFor(providerOptions, settingsState.preferredProvider)}
                  providerOptions={providerOptions}
                  catalogRows={catalogRows}
                  onDone={() => {}}
                />
              </div>
            ) : (
              <div className={styles.hints}>
                <div>
                  <span className={styles.prompt}>❯</span> <span className={styles.hintBody}>type a message</span>{" "}
                  <span className={styles.hintDim}>— starts the main conductor</span>
                </div>
                <div>
                  <span className={styles.key}>{displayChord("mod+o")}</span>{" "}
                  <span className={styles.hintDim}>spawn form — start a targeted agent</span>
                </div>
                <div>
                  <span className={styles.key}>/</span> <span className={styles.hintDim}>command palette</span>
                  <span className={styles.ghost}> · </span>
                  <span className={styles.key}>?</span> <span className={styles.hintDim}>shortcuts</span>
                </div>
              </div>
            )}
            <div className={styles.status} data-welcome-status>
              {conn === "connected" ? (
                <>
                  <span className={styles.ok}>●</span> chimerad connected
                </>
              ) : conn === "reconnecting" ? (
                <>
                  <span className={styles.warn}>◌</span> chimerad reconnecting…
                </>
              ) : (
                <>
                  <span className={styles.danger}>○</span> chimerad disconnected
                </>
              )}
              {first ? (
                <>
                  {" "}· <span className={styles.ok}>▪</span> {first.name}:{first.provider} ready
                </>
              ) : null}
              {peers.map((p) => (
                <span key={p.engineId}> · ⇅ {p.engineId} {p.state === "connected" ? "linked" : p.state}</span>
              ))}
            </div>
          </div>
        </div>
        {!noAccounts && (
          <div ref={bandRef} className={styles.band}>
            <Composer />
          </div>
        )}
        {!noAccounts && spawnOpen ? <SpawnCard onClose={() => composerLocal.set({ spawnOpen: false })} /> : null}
        <OverlayOutlet host="agents" bottomInset={bottomInset} />
      </div>
    </div>
  );
}
