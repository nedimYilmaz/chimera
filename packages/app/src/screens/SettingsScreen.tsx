import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { UiState } from "@chimera/ui-state";
import { findMcpOAuthGateway, type McpOAuthGateway, type McpStoreServerSpec } from "@chimera/protocol";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { rpcCall, onDaemonEvent, openArtifactUrl } from "../rpc/bridge";
import { runAction, isEditableTarget, registerActionHandler, displayChord, actionChord } from "../keymap";
import { writeClipboard } from "../state/copyOnSelect";
import { getSettingsCommands } from "../state/commands.settings";
import { SecretsSection } from "../components/SecretsSection";
import { ComputerUseCard } from "../components/ComputerUseCard";
import { InstallMcpPackageForm } from "../components/InstallMcpPackageForm";
import {
  SETTINGS_SECTIONS,
  stepSection,
  buildProviderRows,
  buildProviderCatalogRows,
  providerOptionsFor,
  keyBadgeLabel,
  credentialTypeLabel,
  networkView,
  cloudflareView,
  authKeyBadge,
  mcpListenerView,
  parseDailyCap,
  fmtDailyCap,
  parseMaxAgentsTotal,
  concurrencyCapView,
  LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS,
  dynamicCapDraft,
  parseDynamicCapDraft,
  parsePerAccountCap,
  type DynamicCapDraft,
  parseArgsInput,
  parseEnvInput,
  extractAuthHeader,
  mcpAuthKeychainRef,
  mcpImportableRowView,
  mcpToolsRow,
  mcpToolsBadge,
  mcpToolsStatusLine,
  truncateToolDescription,
  mcpOAuthScopeCatalog,
  defaultMcpOAuthScopeSelection,
  resolveMcpOAuthScopes,
  mcpStoreAuthRowView,
  mcpAuthChipView,
  mcpStoreIsEnabled,
  type SettingsSection,
} from "../state/selectors.settings";
import { Panel, PanelFooter } from "../components/Panel";
import { OverlayOutlet } from "../components/OverlayOutlet";
import { FederationPairing } from "../components/FederationPairing";
import { ProviderCatalogCard } from "../components/ProviderCatalogCard";
import { AddProviderForm } from "../components/AddProviderForm";
import { AddCustomProviderForm } from "../components/AddCustomProviderForm";
import { PathPicker } from "../components/PathPicker";
import { listEngines } from "../voice/registry";
import { setSpeakRepliesEnabled, useSpeakReplies } from "../voice/ttsGate";
import styles from "./SettingsScreen.module.css";
import { hasCustomPaneWidths, resetPaneWidths, subscribePanes } from "../state/panes";
import { setUserTurnColor, subscribeAppearance, userTurnColor, userTurnCssValue, USER_TURN_DEFAULT, USER_TURN_PRESETS } from "../state/appearance";
import { usePaneRow } from "../components/PaneDivider";

// W9 — the Settings screen (mock ?screen=settings, coverage B15/B16; F09):
// a left section rail (providers & accounts / network & federation / host tools
// / general) + a right detail pane per section. All writes go to the config.d/
// ui.json overlay via the daemon (config.patch / accounts.* / fed.*); the UI
// refreshes ITSELF on config_changed / network_changed (no refresh button) and
// toasts on config_error. Token-only styling; every string English (F11).
//
// The tools section deliberately does NOT fork a host-tools UI — it reuses the
// mod+d HostToolsCard (mounted through this screen's OverlayOutlet).

const cmds = getSettingsCommands(appStore, rpcCall);

function copyWithToast(text: string): void {
  if (!text) return;
  void writeClipboard(text).then((ok) => {
    if (ok) appStore.dispatch({ type: "notice", message: `${text.length} characters copied to clipboard` });
  });
}

export function SettingsScreen() {
  // PANE-RESIZE: the row carries the width and is the drag ceiling.
  const pane = usePaneRow("settings");
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const section = state.section;

  // tab entry: load every section's read data once, then keep them fresh off
  // daemon events (F09 self-refresh — config_changed / network_changed).
  useEffect(() => {
    void cmds.loadProviders();
    void cmds.loadNetwork();
    void cmds.loadCloudflare();
    void cmds.loadGeneral();
    void cmds.loadMcpStore();
    const off = onDaemonEvent((e) => cmds.onDaemonEvent(e.kind, e.data as Record<string, unknown>));
    // F49.UI: the mcp-listener block lists LIVE grants, and a grant appears/vanishes with no
    // daemon event to refresh off — without this tick the roster freezes the moment the tab
    // opens. loadGeneral is the same read that populated it, so this adds no new RPC surface.
    const tick = setInterval(() => { void cmds.loadGeneral(); }, 10_000);
    // MCPSTORE-OAUTH-CANCEL: navigating away from Settings mid-flow must not leave the
    // module-scoped poll timer(s) ticking against an unmounted row.
    return () => { off(); clearInterval(tick); cmds.stopAllMcpStoreOAuthPolling(); cmds.stopAllProviderOAuthPolling(); };
  }, []);

  // ↑↓ section cursor (mock "↑↓ section"). Skipped while an input owns the keys
  // and while an overlay (e.g. the host-tools card) is capturing.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (isEditableTarget(ev.target)) return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === "ArrowUp") { ev.preventDefault(); cmds.setSection(stepSection(cmds.getState().section, -1)); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); cmds.setSection(stepSection(cmds.getState().section, 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div data-screen-layout="split" className={styles.row} {...pane.rowProps}>
      <Panel
        label={<>settings <span className={styles.labelMeta}>· config.d/ui.json</span></>}
        className={styles.railPane}
      >
        <div className={styles.rail}>
          {SETTINGS_SECTIONS.map((s) => (
            <div
              key={s.id}
              className={s.id === section ? styles.railRowActive : styles.railRow}
              onClick={() => {
                cmds.setSection(s.id);
                if (s.id === "tools") runAction("host.toggle", appStore); // reuse the mod+d card
                if (s.id === "notify") runAction("notify.toggle", appStore); // reuse the notify-rules card
                if (s.id === "hooks") runAction("hooks.toggle", appStore); // reuse the hooks-rules card
              }}
              data-settings-section={s.id}
            >
              <div className={styles.railLabel}>{s.label}</div>
              <div className={styles.railHint}>{s.id === "tools" ? actionChord("host.toggle") + " card" : s.hint}</div>
            </div>
          ))}
        </div>
        <div className={styles.railFoot}>↑↓ section · enter focus · changes apply instantly</div>
      </Panel>

      {/* PANE-RESIZE: the seam, in place of the gap. */}
      {pane.divider}
      <Panel label={detailLabel(section)} className={styles.detailPane}>
        <div className={styles.detail}>
          {section === "providers" ? <ProvidersSection />
            : section === "network" ? <NetworkSection />
            : section === "tools" ? <ToolsSection />
            : section === "notify" ? <NotifySection />
            : section === "hooks" ? <HooksSection />
            : section === "mcp" ? <McpStoreSection />
            : section === "secrets" ? <SecretsSection />
            : <GeneralSection />}
        </div>
        <PanelFooter>{footerHint(section)}</PanelFooter>
        <OverlayOutlet host="settings" />
      </Panel>
    </div>
  );
}

function detailLabel(section: SettingsSection): string {
  return SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "settings";
}

function footerHint(section: SettingsSection): string {
  switch (section) {
    case "providers": return `${displayChord("mod+o")} add · ${displayChord("mod+k")} test · ${displayChord("mod+shift+x")} remove · ${displayChord("mod+shift+up")}/${displayChord("mod+shift+down")} move · ${displayChord("mod+e")} re-key · changes apply instantly · new spawns see the new set (running envs unchanged)`;
    case "network": return "writes go to the config.d/ui.json overlay · daemon watcher diff-applies · broken config → previous stays active + toast";
    case "tools": return `host-tool policy lives in the ${displayChord("mod+d")} card · space allow→ask→deny · deny=command refusal, ask=⚠ card`;
    case "notify": return "notify rules live in the rules card · ctrl+o new · e edit · space on/off · t test · d delete";
    case "hooks": return "lifecycle hooks live in the rules card · ctrl+o new · e edit · space on/off · d delete · config.hooks, hot-reloaded";
    case "mcp": return "install once, every agent on every provider can call it via mcp_store_tools/mcp_store_call · import copies a local claude/codex server's command into the store";
    case "secrets": return "values live in the macOS keychain and are never shown again · default is deny: a secret with no grant is unreadable by every agent · reveal = the model sees it, inject = it goes into the agent's process env instead ($CHIMERA_SECRET_*) and applies at its next start · a grant dies with its agent";
    case "general": return "engine.id is this daemon's federation identity · daily cap is an advisory spend meter · import dir sets where git-imported projects clone to";
  }
}

// ---------------------------------------------------------------------------
// providers & accounts (mock lines 951-978)
// ---------------------------------------------------------------------------

function ProvidersSection() {
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const statusAccounts = useStore((s: UiState) => s.accounts);
  const rows = buildProviderRows(state.accounts, state.autoOrder, statusAccounts, state.tests, state.testDetails);
  const catalogRows = buildProviderCatalogRows(state.providers, state.tests);

  const [selected, setSelected] = useState(0);
  const [addFormProvider, setAddFormProvider] = useState<string | null>(null);
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Re-key: a write-only draft, held ONLY here while the field is open — never
  // put in the store, never rendered back (same secret discipline as
  // AddProviderForm's key field). null = the row-level rekey field is closed.
  const [rekeyTarget, setRekeyTarget] = useState<string | null>(null);
  const [rekeyDraft, setRekeyDraft] = useState("");

  // KEYMAP-REDESIGN (rule 8): mod+o add / mod+k test / mod+shift+x remove /
  // mod+shift+up|down move / mod+e re-key now route through the shared
  // KEYMAP (rows.settings.ts) — the root useHotkeys hook already applies the
  // isEditableTarget guard, so this screen only needs to register what each
  // action DOES, the same registry pattern every other coordination screen
  // uses.
  useEffect(() => {
    const offs = [
      registerActionHandler("settings.providerAdd", () => {
        setAddFormProvider((v) => (v === null ? providerOptionsFor(catalogRows)[0]! : null));
      }),
      registerActionHandler("settings.providerTest", () => {
        const r = rows[selected];
        if (r) void cmds.testAccount(r.name);
      }),
      registerActionHandler("settings.providerRemove", () => {
        const r = rows[selected];
        if (r) setConfirmRemove(r.name);
      }),
      registerActionHandler("settings.providerMoveUp", () => {
        const r = rows[selected];
        if (r) void cmds.reorderAccount(r.name, "up");
      }),
      registerActionHandler("settings.providerMoveDown", () => {
        const r = rows[selected];
        if (r) void cmds.reorderAccount(r.name, "down");
      }),
      registerActionHandler("settings.providerRekey", () => {
        const r = rows[selected];
        if (r && state.accounts.find((a) => a.name === r.name)?.authType === "keychain") {
          setRekeyTarget((v) => (v === r.name ? null : r.name));
          setRekeyDraft("");
        }
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [rows, selected, catalogRows, state.accounts]);

  // blank draft never submits (write-only, blank = unchanged) — the "save
  // key" button is already disabled on empty, this guards the Enter-key path.
  const submitRekey = async () => {
    if (!rekeyTarget || !rekeyDraft) return;
    const name = rekeyTarget;
    const ok = await cmds.rekeyAccount(name, rekeyDraft);
    setRekeyDraft("");
    if (ok) setRekeyTarget(null);
  };

  return (
    <div className={styles.section}>
      <div className={styles.catalogList} data-provider-catalog>
        {catalogRows.length === 0 ? (
          <div className={styles.emptyHint}>loading provider catalog…</div>
        ) : catalogRows.map((p) => (
          <ProviderCatalogCard
            key={p.id}
            row={p}
            onAddKey={() => setAddFormProvider(p.id)}
            onTest={(name) => void cmds.testAccount(name)}
            onRemove={(name) => setConfirmRemove(name)}
            onSaveOverride={(v) => void cmds.setProviderOverride(p.id, v)}
            // KIMI-CODE-SUBSCRIPTION-UI: ONE "connect with subscription" affordance,
            // routed by which mechanism the provider actually has — agentic-sdk
            // (claude/codex) rides accounts.add_subscription (the CLI's own ambient
            // login), everything else with authModes oauth (copilot/grok-build/any
            // future oauth-mode entry) rides accounts.oauth_start/finish. The card
            // itself doesn't know or care which RPC ran underneath.
            onConnectSubscription={() => void (p.kind === "agentic-sdk" ? cmds.connectSubscription(p.id) : cmds.connectProviderOAuth(p.id))}
            oauth={state.providerOAuth[p.id]}
            onCancelOAuth={() => cmds.cancelProviderOAuth(p.id)}
          />
        ))}
      </div>

      <div className={styles.tableHead}>
        <div className={styles.colAccount}>account</div>
        <div className={styles.colProvider}>provider</div>
        <div className={styles.colKey}>key</div>
        <div className={styles.colFailover}>failover</div>
        <div className={styles.colSpend}>spend today</div>
      </div>
      <div className={styles.tableBody} data-provider-rows>
        {rows.length === 0 ? (
          <div className={styles.emptyHint}>no accounts configured</div>
        ) : rows.map((r, i) => (
          <div
            key={r.name}
            className={i === selected ? styles.tableRowSel : styles.tableRow}
            onClick={() => setSelected(i)}
            data-provider-row={r.name}
          >
            <div className={styles.colAccount}>{r.name}</div>
            <div className={`${styles.colProvider} ${styles.muted}`}>{r.provider}</div>
            <div className={styles.colKey}>
              <span className={r.badgeTone === "success" ? styles.ok : r.badgeTone === "warn" ? styles.warn : styles.danger}>
                {keyBadgeLabel(r.badge)}
              </span>
              {/* OAUTH-TOKEN-ACCOUNTS: credential type + structured probe detail,
                  replacing what used to be a bare "invalid" with no explanation.
                  credentialType is undefined for a non-keychain account (subscription/
                  env/command/oauth), so those rows render nothing extra. */}
              {r.credentialType ? <span className={styles.faint}>{` · ${credentialTypeLabel(r.credentialType)}`}</span> : null}
              {r.detail ? (
                <span className={r.badgeTone === "warn" ? styles.warn : styles.danger}>{` · ${r.detail}`}</span>
              ) : null}
            </div>
            <div className={`${styles.colFailover} ${styles.muted}`}>
              {r.failover ?? "—"}
              {i === selected && (
                <>
                  <button
                    className={styles.ghostBtn}
                    title="move up in failover priority"
                    disabled={i === 0}
                    onClick={(e) => { e.stopPropagation(); void cmds.reorderAccount(r.name, "up"); }}
                  >↑</button>
                  <button
                    className={styles.ghostBtn}
                    title="move down in failover priority"
                    disabled={i === rows.length - 1}
                    onClick={(e) => { e.stopPropagation(); void cmds.reorderAccount(r.name, "down"); }}
                  >↓</button>
                </>
              )}
            </div>
            <div className={`${styles.colSpend} ${styles.muted}`}>{r.spendLabel}</div>
          </div>
        ))}
      </div>

      {confirmRemove !== null && (
        <div className={styles.confirmRow} data-remove-confirm>
          <span className={styles.warn}>remove account "{confirmRemove}"?</span>
          <button
            className={styles.dangerBtn}
            onClick={() => { const n = confirmRemove; setConfirmRemove(null); void cmds.removeProvider(n); }}
          >remove</button>
          <button className={styles.ghostBtn} onClick={() => setConfirmRemove(null)}>cancel</button>
        </div>
      )}

      <div className={styles.rowActions}>
        <button className={styles.ghostBtn} onClick={() => setAddFormProvider((v) => (v === null ? providerOptionsFor(catalogRows)[0]! : null))} data-add-provider>
          {addFormProvider !== null ? "cancel" : "+ add provider"}
        </button>
        <button className={styles.ghostBtn} onClick={() => setCustomFormOpen((v) => !v)} data-add-custom-provider>
          {customFormOpen ? "cancel custom" : "+ custom provider"}
        </button>
        {rows[selected] && (
          <>
            <button className={styles.ghostBtn} onClick={() => void cmds.testAccount(rows[selected]!.name)}>{displayChord("mod+k")} test</button>
            <button className={styles.ghostBtn} onClick={() => setConfirmRemove(rows[selected]!.name)}>{displayChord("mod+shift+x")} remove</button>
            {state.accounts.find((a) => a.name === rows[selected]!.name)?.authType === "keychain" && (
              <button
                className={styles.ghostBtn}
                onClick={() => { const n = rows[selected]!.name; setRekeyTarget((v) => (v === n ? null : n)); setRekeyDraft(""); }}
                data-rekey-provider
              >{displayChord("mod+e")} {rekeyTarget === rows[selected]!.name ? "cancel re-key" : "re-key"}</button>
            )}
          </>
        )}
      </div>

      {rekeyTarget !== null && (
        <div className={styles.authRow} data-rekey-form>
          <span className={styles.authLabel}>
            new key for "{rekeyTarget}"
            {(() => {
              const ct = rows.find((r) => r.name === rekeyTarget)?.credentialType;
              return ct ? ` (${credentialTypeLabel(ct)})` : "";
            })()}
          </span>
          <input
            className={styles.inputKey}
            type="password"
            value={rekeyDraft}
            placeholder="write-only — blank leaves the stored key unchanged"
            onChange={(e) => setRekeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submitRekey(); }}
            data-rekey-input
            autoFocus
          />
          <button
            className={styles.ghostBtn}
            disabled={!rekeyDraft}
            onClick={() => void submitRekey()}
            data-rekey-submit
          >save key</button>
          <button className={styles.ghostBtn} onClick={() => { setRekeyTarget(null); setRekeyDraft(""); }}>cancel</button>
        </div>
      )}

      {addFormProvider !== null && (
        <AddProviderForm
          initialProvider={addFormProvider}
          providerOptions={providerOptionsFor(catalogRows)}
          catalogRows={catalogRows}
          onDone={() => setAddFormProvider(null)}
        />
      )}
      {customFormOpen && (
        <AddCustomProviderForm
          existingIds={catalogRows.map((row) => row.id)}
          onDone={() => setCustomFormOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CLOUDFLARE-APP-SURFACE — the Cloudflare federation block, mirroring the
// tailscale block above exactly in structure: a domain + write-only API-token
// input, a configure/provision button (fed.cloudflare.up), and a status
// display switching on cloudflareView()'s 4 states. The token is a local draft
// only (never stored in `state`) and is cleared the moment a submit succeeds —
// same discipline as the tailscale auth-key field. The invite blob / the token
// handed to the OTHER side is FederationPairing's existing shown-once idiom;
// this block only ever shows MY OWN non-secret hostname once ready.
// ---------------------------------------------------------------------------

function CloudflareSection() {
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const view = cloudflareView(state.cloudflare);
  const [domain, setDomain] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [busy, setBusy] = useState(false);

  const toneClass = (tone: string): string =>
    tone === "success" ? styles.ok : tone === "warn" ? styles.warn : tone === "danger" ? styles.danger : styles.muted;

  const submit = async (): Promise<void> => {
    if (!domain || busy) return;
    setBusy(true);
    const ok = await cmds.cloudflareUp(domain, apiToken || undefined);
    setBusy(false);
    if (ok) {
      setApiToken(""); // drop the write-only secret draft
      setDomain("");
    }
  };

  return (
    <div className={styles.card} data-cloudflare-block>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>cloudflare</span>
        <span className={toneClass(view.statusTone)}>● {view.statusLabel}</span>
      </div>
      {view.state === "ready" && (
        <div className={styles.metaRow}>
          <span>endpoint <span className={styles.value}>{view.hostname ?? "—"}</span>
            {view.hostname && <button className={styles.linkBtn} onClick={() => copyWithToast(view.hostname!)}>c copy</button>}
          </span>
        </div>
      )}
      <div className={styles.authRow}>
        <span className={styles.authLabel}>domain</span>
        <input
          className={styles.inputKey}
          type="text"
          value={domain}
          placeholder="example.com"
          onChange={(e) => setDomain(e.target.value)}
          data-cloudflare-domain
        />
      </div>
      <div className={styles.authRow}>
        <span className={styles.authLabel}>api token</span>
        <input
          className={styles.inputKey}
          type="password"
          value={apiToken}
          placeholder="cf-token (write-only, blank to reuse stored)"
          onChange={(e) => setApiToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          data-cloudflare-token
        />
        <button className={styles.ghostBtn} disabled={busy || !domain} onClick={() => void submit()} data-cloudflare-up>
          {view.state === "unconfigured" ? "configure" : "re-provision"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// network & federation (mock lines 927-949) — tailscale block is W9; the
// invite/join/peers pairing UI is W10 (seamed placeholder below).
// ---------------------------------------------------------------------------

function NetworkSection() {
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const view = networkView(state.network);
  const keyBadge = authKeyBadge(state.authKeyStored);
  const [authKey, setAuthKey] = useState("");
  const [busy, setBusy] = useState(false);
  const authRef = useRef<HTMLInputElement | null>(null);

  const submitAuthKey = async (): Promise<void> => {
    if (!authKey || busy) return;
    setBusy(true);
    const ok = await cmds.setAuthKey(authKey);
    setBusy(false);
    if (ok) setAuthKey(""); // drop the secret draft
  };

  const toneClass = (tone: string): string =>
    tone === "success" ? styles.ok : tone === "warn" ? styles.warn : tone === "danger" ? styles.danger : styles.muted;

  return (
    <div className={styles.section}>
      <div className={styles.card} data-tailscale-block>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>tailscale</span>
          <span className={toneClass(view.statusTone)}>● {view.statusLabel}</span>
          <span className={styles.spacer} />
          <span className={styles.faint}>ssh: {view.sshLabel}</span>
        </div>
        {view.installed ? (
          <>
            <div className={styles.metaRow}>
              <span>ip <span className={styles.value}>{view.ip4 ?? "—"}</span>
                {view.ip4 && <button className={styles.linkBtn} onClick={() => copyWithToast(view.ip4!)}>c copy</button>}
              </span>
              <span>magicdns <span className={styles.value}>{view.magicDnsLabel}</span></span>
            </div>
            <div className={styles.authRow}>
              <span className={styles.authLabel}>auth-key</span>
              <input
                ref={authRef}
                className={styles.inputKey}
                type="password"
                value={authKey}
                placeholder="tskey-auth-… (write-only)"
                onChange={(e) => setAuthKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void submitAuthKey(); }}
                data-auth-key
              />
              <button className={styles.ghostBtn} disabled={busy || !authKey} onClick={() => void submitAuthKey()} data-auth-key-save>set</button>
              <span className={keyBadge.tone === "success" ? styles.ok : styles.faint}>{keyBadge.label}</span>
              <span className={styles.faint}>in Keychain · auto up --auth-key on next restart when logged out</span>
            </div>
            <div className={styles.authRow}>
              <span className={styles.authLabel} />
              <button className={styles.ghostBtn} onClick={() => void cmds.networkUp()} data-network-up>
                {view.statusLabel === "connected" ? "re-check" : "connect / login"}
              </button>
              {state.authUrl && (
                <span className={styles.authUrl}>
                  open to authenticate:{" "}
                  <span className={styles.value}>{state.authUrl}</span>
                  <button className={styles.linkBtn} onClick={() => copyWithToast(state.authUrl!)}>copy</button>
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className={styles.installHint}>{view.installHint ?? "…"}</div>
            {view.installCmd && (
              <div className={styles.installCmdRow}>
                <code className={styles.installCmd}>{view.installCmd}</code>
                <button className={styles.linkBtn} onClick={() => copyWithToast(view.installCmd!)}>copy</button>
                {view.installUrl && <span className={styles.faint}>or {view.installUrl}</span>}
              </div>
            )}
          </>
        )}
      </div>

      <CloudflareSection />

      {/* F49.2 — read-only mcp-listener block. Never renders a grant's bearer
          token: McpListenerStatus carries no token field at all. */}
      <div className={styles.card} data-mcp-listener>
        {(() => {
          const listener = mcpListenerView(state.mcpListener, state.loaded.general);
          return (
            <>
              <div className={styles.cardHead}>
                <span className={styles.cardTitle}>mcp listener</span>
              </div>
              <div className={styles.metaRow} data-mcp-listener-state>{listener.headline}</div>
              {listener.rows.map((row) => (
                <div className={styles.metaRow} data-mcp-listener-grant key={row.agentId}>
                  {row.agentId.slice(0, 8)} · {row.provider} · since {row.sinceLabel}
                </div>
              ))}
              <div className={styles.faint}>{listener.footnote}</div>
            </>
          );
        })()}
      </div>

      {/* W10 (F10 · B15) — federation pairing UI lands at the W9 seam: invite
          generation + active list, the join field + step indicator, and the
          peers table with the space→grant menu. engine.id comes from the same
          general-section read (daemon.status). */}
      <div data-federation-pairing-seam>
        <FederationPairing engineId={state.engineId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// host tools — reuse the mod+d HostToolsCard (do not fork it)
// ---------------------------------------------------------------------------

function ToolsSection() {
  return (
    <div className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>host tools</span>
          <span className={styles.spacer} />
          <span className={styles.faint}>PATH auto-discovery · policy → permission gate</span>
        </div>
        <div className={styles.toolsBody}>
          Host-tool access policy (kubectl / aws / gcloud / …) is managed in the
          host-tools card — the same surface as everywhere else.
        </div>
        <div className={styles.rowActions}>
          <button className={styles.primaryBtn} onClick={() => runAction("host.toggle", appStore)} data-open-host-tools>
            open host tools ({displayChord("mod+d")})
          </button>
        </div>
      </div>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>plugins &amp; commands</span>
          <span className={styles.spacer} />
          <span className={styles.faint}>global skills · project commands</span>
        </div>
        <div className={styles.toolsBody}>
          Inspect discovered plugins, skills, and project commands in the shared
          plugins card; toggles apply to new spawns.
        </div>
        <div className={styles.rowActions}>
          <button
            className={styles.primaryBtn}
            onClick={() => runAction("plugins.toggleCard", appStore)}
            data-open-plugins
          >
            open plugins &amp; commands ({displayChord("mod+y")})
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// notifications — reuse the notify-rules card (mock showNotifRules, W20 · F18)
// ---------------------------------------------------------------------------

function NotifySection() {
  return (
    <div className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>notification rules</span>
          <span className={styles.spacer} />
          <span className={styles.faint}>notify.* rules · os/toast/a2a/webhook</span>
        </div>
        <div className={styles.toolsBody}>
          permission pending / question pending / job failed / budget ≥80% /
          peer partitioned — each rule picks a channel, a throttle window, and
          an on/off switch in the rules card, the same surface everywhere else.
        </div>
        <div className={styles.rowActions}>
          <button className={styles.primaryBtn} onClick={() => runAction("notify.toggle", appStore)} data-open-notify-rules>
            open notification rules
          </button>
        </div>
      </div>
    </div>
  );
}

// HOOK-6 (PLAN-HOOKS.md §7) — reuse the hooks-rules card (mirrors NotifySection).
function HooksSection() {
  return (
    <div className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>lifecycle hooks</span>
          <span className={styles.spacer} />
          <span className={styles.faint}>config.hooks · on → actions</span>
        </div>
        <div className={styles.toolsBody}>
          declarative on → actions rules — a curated topic (agent settled / task
          state / gate verdict / queue drained / repo landed / memory added / …)
          fires notify, push, spawn, run, or channel actions. Observational only
          (never vetoes) and loop-safe (chain depth ≤3, 20 fires/hour). Edit them
          in the rules card, the same surface as everywhere else.
        </div>
        <div className={styles.rowActions}>
          <button className={styles.primaryBtn} onClick={() => runAction("hooks.toggle", appStore)} data-open-hooks-rules>
            open lifecycle hooks
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP store (mcpstore.list/add/remove/importables/import): install an MCP
// server once and every agent on every provider can discover/call it via the
// chimera MCP's mcp_store_tools/mcp_store_call meta-tools — no per-agent config.
// ---------------------------------------------------------------------------

export function McpStoreSection() {
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const [adding, setAdding] = useState(false);
  const [installingPackage, setInstallingPackage] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // MCP-REMOTE-IMPORT slice 3: which importable row currently has its masked
  // token field open (`${source}:${name}`, or a claude.ai-managed row's key —
  // those default to open, see render below) + that field's draft value. Only
  // ever sent as a bare RPC argument (importMcpStore/connectManagedMcpStore),
  // never retained past the click.
  const [authDraftKey, setAuthDraftKey] = useState<string | null>(null);
  const [authSecret, setAuthSecret] = useState("");

  // toggle open/closed; opening always (re-)fetches — mcpstore.tools is never
  // called eagerly for every server up front, only on this per-row expand.
  // MCPSTORE-LIFECYCLE-UI: a disabled server is never connected (core filters it out of
  // mcpstore.tools entirely) — the panel shows a static "disabled" hint instead of firing
  // a doomed fetch that would just land as a confusing "no such server" error.
  const toggle = (name: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else {
        next.add(name);
        const entry = state.mcpServers.find((srv) => srv.name === name);
        if (entry && mcpStoreIsEnabled(entry)) void cmds.loadMcpServerTools(name);
      }
      return next;
    });
  };

  return (
    <div className={styles.section}>
      <ComputerUseCard />
      {/* MCPSTORE-LAYOUT: the head used to be name/command/args — a STDIO shape. An http
          server has a url and no command, so every http row rendered its url under "command"
          and a bare em-dash under "args", which read as broken alignment rather than as a
          different kind of server. One "endpoint" column holds a url or a command+args, and
          the transport is a chip on the row instead of being inferred from which column is
          empty. */}
      <div className={styles.tableHead}>
        <div className={styles.colMcpName}>name</div>
        <div className={styles.colMcpKind}>transport</div>
        <div className={styles.colMcpEndpoint}>endpoint</div>
      </div>
      <div className={styles.tableBody} data-mcp-store-rows>
        {state.mcpServers.length === 0 ? (
          <div className={styles.emptyHint}>no MCP servers installed</div>
        ) : state.mcpServers.map((s) => {
          const isOpen = expanded.has(s.name);
          const toolsRow = mcpToolsRow(state.mcpTools, s.name);
          const badge = mcpToolsBadge(toolsRow);
          const enabled = mcpStoreIsEnabled(s);
          // MCPSTORE-LIFECYCLE-UI: the auth control's full view model (show/label/busy/
          // error) is a pure derivation off type/authKind/oauth-state/tools-state — see
          // selectors.settings.ts's mcpStoreAuthRowView doc comment for why this no longer
          // gates on the detect probe (state.mcpDetectedOAuth) the way it used to.
          const authKind = s.type === "http" ? s.auth?.kind : undefined;
          const oauth = state.mcpOAuth[s.name];
          // MCP-AUTH-STATUS: the at-rest verdict, fetched with the server list — this is what
          // makes the row honest on a cold page open, where `oauth` and `toolsRow` are both empty.
          const authStatus = state.mcpAuthStatus[s.name];
          const authChip = mcpAuthChipView(authStatus);
          const rowAuth = mcpStoreAuthRowView({ type: s.type, authKind, oauth, toolsConnected: toolsRow.connected, toolsStatus: toolsRow.status, authState: authStatus?.state });
          // MCP-OAUTH-DISCOVERABILITY: the probe (loadMcpStore's best-effort detectAuth)
          // now drives ONLY the informational "oauth detected" chip below, never whether
          // the Authorize control itself renders.
          const detectedOAuth = state.mcpDetectedOAuth[s.name] === true;
          const onAuthorize = async (): Promise<void> => {
            if (rowAuth.needsConvert) {
              const converted = await cmds.convertMcpStoreAuthKind(s.name);
              if (!converted) return;
            }
            const authorizeUrl = await cmds.authorizeMcpStore(s.name);
            if (!authorizeUrl) return;
            try { await openArtifactUrl(authorizeUrl); } catch { /* best-effort open — the poll below still completes if the user opens it manually */ }
            cmds.startMcpStoreOAuthPolling(s.name);
          };
          return (
            <div key={s.name} data-mcp-store-server={s.name}>
              <div className={`${styles.tableRow} ${enabled ? "" : styles.disabledRow}`} data-mcp-store-row={s.name}>
                <button
                  className={`${styles.colMcpName} ${styles.linkBtn}`}
                  onClick={() => toggle(s.name)}
                  data-mcp-store-expand={s.name}
                >{isOpen ? "▾" : "▸"} {s.name}</button>
                <div className={styles.colMcpKind}>
                  <span className={styles.transportChip} data-mcp-store-transport={s.name}>{s.type === "http" ? "http" : "stdio"}</span>
                </div>
                <div className={`${styles.colMcpEndpoint} ${styles.endpoint}`} title={s.type === "http" ? s.url : [s.command, ...s.args].join(" ")}>
                  {s.type === "http" ? s.url : [s.command, ...s.args].filter(Boolean).join(" ")}
                </div>
                {!enabled && <span className={styles.warn} data-mcp-store-disabled-badge={s.name}>disabled</span>}
                {s.type === "stdio" && s.managed && <span className={styles.faint} title={`${s.managed.packageName}@${s.managed.version}`}>npm · {s.managed.version}</span>}
                {/* PROVENANCE: the marker is stamped by the daemon from the runtime manifest and cannot be
                    supplied over RPC, so this badge is proof the server ships with Chimera -- a custom
                    server that merely shares the name never gets it. */}
                {s.type === "stdio" && s.builtIn && <span className={styles.ok} data-mcp-store-builtin-badge={s.name} title={`Ships with Chimera (${s.builtIn.id} ${s.builtIn.version}) and is managed by it. Not an external MCP server.`}>built-in · {s.builtIn.version}</span>}
                {badge && (
                  <span className={toolsRow.connected ? styles.faint : styles.danger} data-mcp-store-badge={s.name}>{badge}</span>
                )}
                {s.direct && <span className={styles.ok} data-mcp-store-direct-badge={s.name}>direct</span>}
                {s.trust === "untrusted" && <span className={styles.warn} data-mcp-store-trust-badge={s.name}>untrusted</span>}
                {authChip.label && (
                  <span
                    className={authChip.tone === "ok" ? styles.ok : authChip.tone === "warn" ? styles.warn : styles.faint}
                    data-mcp-store-auth-chip={s.name}
                    data-mcp-store-auth-state={authStatus?.state}
                    title={authChip.title}
                  >{authChip.label}</span>
                )}
                {rowAuth.needsConvert && detectedOAuth && !rowAuth.connected && (
                  <span className={styles.faint} data-mcp-store-oauth-detected={s.name} title="this server's endpoint resolves an OAuth 2.1 authorization server — Authorize will switch it from a static token to OAuth">oauth detected</span>
                )}
                <span className={styles.spacer} />
                {rowAuth.showAuthorize && (
                  <button
                    className={styles.linkBtn}
                    disabled={rowAuth.busy}
                    onClick={() => void onAuthorize()}
                    data-mcp-store-authorize={s.name}
                  >{rowAuth.busy ? "authorizing…" : rowAuth.authorizeLabel}</button>
                )}
                {rowAuth.busy && (
                  <button
                    className={styles.linkBtn}
                    onClick={() => void cmds.cancelMcpStoreOAuth(s.name)}
                    data-mcp-store-oauth-cancel={s.name}
                    title="abandon this authorize attempt — the browser tab can be closed safely"
                  >cancel</button>
                )}
                <button
                  className={styles.linkBtn}
                  onClick={() => void cmds.setMcpStoreDirect(s.name, !s.direct)}
                  data-mcp-store-direct-toggle={s.name}
                  title="when on, this server's tools are injected as native tools (no mcp_store_tools discovery hop) for orchestration-enabled agents — still callable via mcp_store_call either way"
                >{s.direct ? "make proxy-only" : "make direct"}</button>
                <button
                  className={styles.linkBtn}
                  onClick={() => void cmds.setMcpStoreEnabled(s.name, !enabled)}
                  data-mcp-store-enable-toggle={s.name}
                  title="disable keeps this server's spec and credentials, but stops connecting it and hides it from agents (mcp_store_tools/mcp_store_call, direct tools) until re-enabled"
                >{enabled ? "disable" : "enable"}</button>
                <button
                  className={styles.linkBtn}
                  onClick={() => void cmds.setMcpStoreTrust(s.name, s.trust === "untrusted" ? "full" : "untrusted")}
                  data-mcp-store-trust-toggle={s.name}
                  title="untrusted means this server's DATA is not trusted, even though the daemon trusts the connection enough to have installed it — a write-capable tool call on an untrusted server by an agent requires approval"
                >{s.trust === "untrusted" ? "mark trusted" : "mark untrusted"}</button>
                {/* A built-in is part of the install, so removing it is refused by the daemon; disable it instead. */}
                {!(s.type === "stdio" && s.builtIn) && <button className={styles.linkBtn} onClick={() => setConfirmRemove(s.name)} data-mcp-store-uninstall={s.name}>uninstall</button>}
              </div>
              {rowAuth.errorMessage && (
                <div className={styles.danger} data-mcp-store-oauth-error={s.name}>authorize failed: {rowAuth.errorMessage}</div>
              )}
              {isOpen && (
                <div className={styles.mcpToolsPanel} data-mcp-store-tools={s.name}>
                  {!enabled ? (
                    <div className={styles.emptyHint} data-mcp-store-disabled-hint={s.name}>server is disabled — enable it to inspect tools</div>
                  ) : toolsRow.status === "loading" ? (
                    <div className={styles.emptyHint}>connecting…</div>
                  ) : (
                    <>
                      <div className={toolsRow.connected ? styles.faint : styles.danger} data-mcp-store-status={s.name}>
                        {mcpToolsStatusLine(toolsRow)}
                      </div>
                      {toolsRow.connected && (
                        toolsRow.tools.length === 0 ? (
                          <div className={styles.emptyHint}>no tools</div>
                        ) : (
                          <div data-mcp-store-tool-list={s.name}>
                            {toolsRow.tools.map((t) => (
                              <div key={t.name} className={styles.mcpToolRow} data-mcp-store-tool={t.name}>
                                <span className={styles.mcpToolName}>{t.name}</span>
                                <span className={`${styles.faint} ${styles.mcpToolDesc}`}>{truncateToolDescription(t.description)}</span>
                              </div>
                            ))}
                          </div>
                        )
                      )}
                      <button className={styles.linkBtn} onClick={() => void cmds.loadMcpServerTools(s.name)} data-mcp-store-refresh={s.name}>refresh</button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmRemove !== null && (
        <div className={styles.confirmRow} data-remove-confirm>
          <span className={styles.warn}>uninstall MCP server "{confirmRemove}"? this also purges its stored credentials. Managed package files are moved to a recoverable .removed directory under Chimera’s mcp-packages folder.</span>
          <button
            className={styles.dangerBtn}
            onClick={() => { const n = confirmRemove; setConfirmRemove(null); void cmds.removeMcpStore(n); }}
          >uninstall</button>
          <button className={styles.ghostBtn} onClick={() => setConfirmRemove(null)}>cancel</button>
        </div>
      )}

      <div className={styles.rowActions}>
        <button className={styles.ghostBtn} disabled={packageBusy} onClick={() => setInstallingPackage((v) => !v)} data-install-mcp-package>
          {installingPackage ? "hide package installer" : "+ install package"}
        </button>
        <button className={styles.ghostBtn} onClick={() => void cmds.loadMcpStore()}>refresh store</button>
        <button className={styles.ghostBtn} onClick={() => setAdding((v) => !v)} data-add-mcp-store>
          {adding ? "cancel" : "+ add server"}
        </button>
      </div>

      {adding && <AddMcpStoreForm onDone={() => setAdding(false)} oauthGateways={state.mcpOAuthGateways} />}
      {installingPackage && <InstallMcpPackageForm inspect={cmds.inspectMcpPackage} install={cmds.installMcpPackage} onBusyChange={setPackageBusy} onDone={() => { setPackageBusy(false); setInstallingPackage(false); }} />}

      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>importable</span>
        <span className={styles.spacer} />
        <span className={styles.faint}>servers already configured for claude/codex on this machine — http and stdio alike</span>
      </div>
      <div className={styles.tableBody} data-mcp-store-importables>
        {state.mcpImportables.length === 0 ? (
          <div className={styles.emptyHint}>none found</div>
        ) : state.mcpImportables.map((imp) => {
          const errorKey = `${imp.source}:${imp.name}`;
          const row = mcpImportableRowView(imp, state.mcpServers);
          const title = imp.notImportableReason ?? (row.alreadyInstalled ? `"${imp.name}" is already installed` : undefined);
          const error = state.mcpImportErrors[errorKey];
          const promptOpen = authDraftKey === errorKey;
          const closePrompt = (): void => { setAuthDraftKey(null); setAuthSecret(""); };
          return (
            <div key={errorKey}>
              <div className={styles.tableRow} data-mcp-store-importable={imp.name}>
                <div className={styles.colMcpName}>
                  <span className={styles.sourceChip}>{imp.source}</span> <span className={styles.value}>{imp.name}</span>
                </div>
                <div className={styles.colMcpKind}>
                  <span className={styles.transportChip} data-mcp-importable-transport={imp.name}>{row.transport}</span>
                </div>
                <div className={`${styles.colMcpEndpoint} ${styles.endpoint}`} title={row.detail}>{row.detail}</div>
                {/* The two states an operator most wants at a glance and could not get from the
                    old layout: this one is already in the store, or importing it will rename it. */}
                {row.alreadyInstalled && (
                  <span className={styles.faint} data-mcp-importable-installed={imp.name}>installed</span>
                )}
                {!row.alreadyInstalled && row.storeName !== imp.name && (
                  <span className={styles.faint} data-mcp-importable-rename={imp.name} title={`imports as "${row.storeName}" — store names are lowercase letters, digits and dashes`}>→ {row.storeName}</span>
                )}
                {!row.claudeAiManaged && (
                  <button
                    className={styles.ghostBtn}
                    disabled={row.disabled}
                    title={title}
                    onClick={() => {
                      if (row.needsAuth) { setAuthDraftKey(errorKey); setAuthSecret(""); }
                      else void cmds.importMcpStore(imp.source, imp.name);
                    }}
                    data-mcp-store-import={imp.name}
                  >import</button>
                )}
              </div>
              {imp.notImportableReason && (
                <div className={styles.danger} data-mcp-store-not-importable={imp.name}>{imp.notImportableReason}</div>
              )}
              {/* a plain remote row's masked token prompt, opened by "import" above —
                  submitting runs import THEN mcpstore.setAuth (setAuth needs the entry
                  to already exist, so this order can't be reversed). */}
              {row.needsAuth && !row.claudeAiManaged && promptOpen && (
                <div className={styles.authRow} data-mcp-store-import-auth={imp.name}>
                  <span className={styles.authLabel}>token</span>
                  <input
                    className={styles.inputKey}
                    type="password"
                    autoFocus
                    value={authSecret}
                    placeholder="write-only, optional"
                    onChange={(e) => setAuthSecret(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { const s = authSecret; closePrompt(); void cmds.importMcpStore(imp.source, imp.name, undefined, s); }
                      if (e.key === "Escape") closePrompt();
                    }}
                    data-mcp-store-import-auth-input={imp.name}
                  />
                  <button
                    className={styles.ghostBtn}
                    onClick={() => { const s = authSecret; closePrompt(); void cmds.importMcpStore(imp.source, imp.name, undefined, s); }}
                    data-mcp-store-import-auth-connect={imp.name}
                  >import</button>
                  <button className={styles.ghostBtn} onClick={closePrompt}>cancel</button>
                </div>
              )}
              {/* claude.ai-managed: mcpstore.import always rejects notImportableReason
                  rows, so this is the ONLY path in — mcpstore.add (with auth wired) +
                  mcpstore.setAuth, using the operator's own token instead of the
                  unreachable claude.ai session credential. */}
              {row.claudeAiManaged && (
                <div className={styles.authRow} data-mcp-store-managed-auth={imp.name}>
                  <span className={styles.faint}>needs your own token/OAuth —</span>
                  <span className={styles.authLabel}>token</span>
                  <input
                    className={styles.inputKey}
                    type="password"
                    value={promptOpen ? authSecret : ""}
                    placeholder="write-only"
                    onChange={(e) => { setAuthDraftKey(errorKey); setAuthSecret(e.target.value); }}
                    disabled={row.alreadyInstalled}
                    data-mcp-store-managed-auth-input={imp.name}
                  />
                  <button
                    className={styles.ghostBtn}
                    disabled={row.alreadyInstalled || !promptOpen || !authSecret.trim()}
                    onClick={() => { const s = authSecret; closePrompt(); void cmds.connectManagedMcpStore(imp, s); }}
                    data-mcp-store-managed-auth-connect={imp.name}
                  >connect</button>
                  {row.alreadyInstalled && <span className={styles.faint}>already installed</span>}
                </div>
              )}
              {error && (
                <div className={styles.danger} data-mcp-store-import-error={imp.name}>{error}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AddMcpStoreForm({
  onDone, addMcpStore = cmds.addMcpStore, setMcpStoreAuth = cmds.setMcpStoreAuth, detectMcpStoreOAuth = cmds.detectMcpStoreOAuth,
  oauthGateways = [],
}: {
  onDone: () => void;
  addMcpStore?: (name: string, spec: McpStoreServerSpec) => Promise<boolean>;
  /** MCP-REMOTE-IMPORT slice 3 (security fix): the http branch's Authorization
   * header (if any) never reaches mcpstore.add's `headers` — it's routed here
   * (mcpstore.setAuth → Keychain) instead of persisted in mcpstore.json. */
  setMcpStoreAuth?: (name: string, secret: string) => Promise<boolean>;
  /** MCP-OAUTH-DISCOVERABILITY: probed once the url field loses focus (see onUrlBlur below) —
   * the user shouldn't have to know bearer vs oauth for a server that's plainly OAuth. */
  detectMcpStoreOAuth?: (opts: { url?: string; name?: string }) => Promise<{ oauth: boolean } | null>;
  /** MCP-OAUTH-GATEWAYS: config's mcpOAuthGateways — the scope checkbox catalog comes from
   * whichever one the typed url matches; none matched means free-text scopes only. */
  oauthGateways?: readonly McpOAuthGateway[];
}) {
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsRaw, setArgsRaw] = useState("");
  const [envRaw, setEnvRaw] = useState("");
  const [url, setUrl] = useState("");
  const [headersRaw, setHeadersRaw] = useState("");
  // MCP-OAUTH slice 3: an http entry's auth is either a static bearer token (extracted
  // from the headers field, unchanged from before) or an oauth grant configured here —
  // the Authorize button (McpStoreSection) drives the rest once this entry exists.
  const [authMode, setAuthMode] = useState<"bearer" | "oauth">("bearer");
  // MCP-OAUTH-FOREIGN-SCOPES: seeded from the url, so a gateway's catalog is shown (and its
  // defaults pre-checked) ONLY for that gateway's own hosts. The re-seed is keyed on the MATCHED
  // GATEWAY, not the url: further typing within one gateway's hosts must not silently undo the
  // operator's own clicks, while a url moving to a different gateway (or to none) swaps the
  // whole catalog, so clicks made against the old one no longer mean anything.
  // Serialized, not the object: a loadMcpStore re-run while the form is open hands back
  // equal-but-new gateway objects, and that must not wipe the operator's clicks either.
  const scopeGatewayKey = JSON.stringify(findMcpOAuthGateway(url, oauthGateways) ?? null);
  const scopeCatalog = mcpOAuthScopeCatalog(url, oauthGateways);
  const [scopeSelection, setScopeSelection] = useState<Record<string, boolean>>(() => defaultMcpOAuthScopeSelection());
  const [extraScopesRaw, setExtraScopesRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setScopeSelection(defaultMcpOAuthScopeSelection(url, oauthGateways));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeGatewayKey]);

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (!name.trim()) { setError("name is required"); return; }
    if (kind === "stdio" && !command.trim()) { setError("name and command are required"); return; }
    if (kind === "http" && !url.trim()) { setError("name and url are required"); return; }
    if (kind === "http") {
      try {
        const parsedUrl = new URL(url.trim());
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error();
      } catch {
        setError("url must be a valid http or https URL");
        return;
      }
    }
    const pairs = parseEnvInput(kind === "stdio" ? envRaw : headersRaw);
    if (!pairs.ok) { setError(pairs.error); return; }
    setError(null);
    setBusy(true);
    const trimmedName = name.trim();
    let ok: boolean;
    if (kind === "stdio") {
      ok = await addMcpStore(trimmedName, { type: "stdio", command: command.trim(), args: parseArgsInput(argsRaw), env: pairs.value, direct: false, enabled: true, trust: "full" });
    } else if (authMode === "oauth") {
      // No secret is entered here — the daemon mints/stores the token via the Authorize
      // button's PKCE/DCR exchange (mcpstore.oauth.start/finish), keychain-only.
      ok = await addMcpStore(trimmedName, {
        type: "http", url: url.trim(), headers: pairs.value, direct: false, enabled: true, trust: "full",
        auth: { kind: "oauth" as const, keychainRef: mcpAuthKeychainRef(trimmedName), scopes: resolveMcpOAuthScopes(scopeSelection, extraScopesRaw, scopeCatalog) },
      });
    } else {
      const extracted = extractAuthHeader(pairs.value);
      ok = await addMcpStore(trimmedName, {
        type: "http", url: url.trim(), headers: extracted.headers, direct: false, enabled: true, trust: "full",
        ...(extracted.secret ? { auth: { kind: "bearer" as const, keychainRef: mcpAuthKeychainRef(trimmedName), ...(extracted.scheme ? { scheme: extracted.scheme } : {}) } } : {}),
      });
      if (ok && extracted.secret) ok = await setMcpStoreAuth(trimmedName, extracted.secret);
    }
    setBusy(false);
    if (ok) onDone();
  };

  const onEnterOrEscape = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") onDone();
  };

  // MCP-OAUTH-DISCOVERABILITY: probe once the user finishes typing the url (blur, not every
  // keystroke) — a hit defaults the form to oauth mode so the user never has to know bearer
  // vs oauth for a server that's plainly OAuth. Best-effort: a probe failure/miss leaves the
  // mode exactly as the user already had it (never forces bearer back on).
  const onUrlBlur = (): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    void detectMcpStoreOAuth({ url: trimmed })
      .then((res) => { if (res?.oauth) setAuthMode("oauth"); })
      .catch(() => { /* best-effort — see the prop doc comment above */ });
  };

  return (
    <div className={styles.addForm} data-add-mcp-store-form>
      <div className={styles.addHead}>
        <span className={styles.addTitle}>add MCP server</span>
        <span className={styles.spacer} />
        <span className={styles.faint}>enter save · esc cancel</span>
      </div>
      <div className={styles.addActions}>
        <button className={kind === "stdio" ? styles.primaryBtn : styles.ghostBtn} onClick={() => { setKind("stdio"); setError(null); }} data-mcp-store-type-stdio>package (stdio)</button>
        <button className={kind === "http" ? styles.primaryBtn : styles.ghostBtn} onClick={() => { setKind("http"); setError(null); }} data-mcp-store-type-http>api server (http)</button>
      </div>
      <div className={styles.formGrid}>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>name</span>
          <input className={styles.input} value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={onEnterOrEscape} data-mcp-store-name-input />
        </label>
        {kind === "stdio" ? <>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>command</span>
          <input className={styles.input} value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} onKeyDown={onEnterOrEscape} data-mcp-store-command-input />
        </label>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>args</span>
          <input className={styles.input} value={argsRaw} placeholder="-y @some/mcp-server" onChange={(e) => setArgsRaw(e.target.value)} onKeyDown={onEnterOrEscape} data-mcp-store-args-input />
        </label>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>env</span>
          <input className={styles.input} value={envRaw} placeholder="KEY=value, OTHER=v2" onChange={(e) => setEnvRaw(e.target.value)} onKeyDown={onEnterOrEscape} data-mcp-store-env-input />
        </label>
        </> : <>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>url</span>
          <input className={styles.input} value={url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setUrl(e.target.value)} onBlur={onUrlBlur} onKeyDown={onEnterOrEscape} data-mcp-store-url-input />
        </label>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>headers</span>
          <input
            className={styles.input}
            value={headersRaw}
            placeholder={authMode === "oauth" ? "X-Key=… (no Authorization — oauth drives that)" : "Authorization=Bearer …, X-Key=…"}
            onChange={(e) => setHeadersRaw(e.target.value)}
            onKeyDown={onEnterOrEscape}
            data-mcp-store-headers-input
          />
        </label>
        </>}
      </div>
      {kind === "http" && (
        <div className={styles.addActions}>
          <button className={authMode === "bearer" ? styles.primaryBtn : styles.ghostBtn} onClick={() => setAuthMode("bearer")} data-mcp-store-auth-bearer>token</button>
          <button className={authMode === "oauth" ? styles.primaryBtn : styles.ghostBtn} onClick={() => setAuthMode("oauth")} data-mcp-store-auth-oauth>oauth</button>
        </div>
      )}
      {kind === "http" && authMode === "oauth" && (
        <div className={styles.formGrid} data-mcp-store-oauth-scopes>
          {scopeCatalog.length > 0 && <div className={styles.chipRow}>
            {scopeCatalog.map((scope) => (
              <button
                key={scope}
                type="button"
                className={scopeSelection[scope] ? styles.chipOn : styles.chipOff}
                onClick={() => setScopeSelection((prev) => ({ ...prev, [scope]: !prev[scope] }))}
                data-mcp-store-scope={scope}
              >{scope}</button>
            ))}
          </div>}
          <label className={styles.formRow}>
            <span className={styles.formLabel}>extra scopes</span>
            <input className={styles.input} value={extraScopesRaw} placeholder="comma,separated" onChange={(e) => setExtraScopesRaw(e.target.value)} onKeyDown={onEnterOrEscape} data-mcp-store-extra-scopes-input />
          </label>
        </div>
      )}
      {error && <div className={styles.errorLine}>{error}</div>}
      <div className={styles.addActions}>
        <button className={styles.primaryBtn} disabled={busy || !name.trim() || (kind === "stdio" ? !command.trim() : !url.trim())} onClick={() => void submit()} data-mcp-store-save>save</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VOICE S6 — engine/privacy settings scaffold (§2, §7): lists the voice/
// registry's engines with their privacy metadata. Every engine today is
// isLocal:true (no audio leaves the machine); the "⚠ audio leaves your
// machine" flag is wired now so S8's cloud opt-in adapters need no new UI.
// ---------------------------------------------------------------------------

function VoiceEngineSection() {
  const engines = listEngines();
  // Subscribed, not mirrored: the pref is also flipped from the command palette and this box has
  // to follow it (a useState copy silently went stale the moment anything else set it).
  const speakReplies = useSpeakReplies();
  return (
    <div className={styles.card} data-voice-engine-card>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>voice engines</span>
        <span className={styles.spacer} />
        <span className={styles.faint}>local-first · cloud engines are opt-in, none ship yet (S8)</span>
      </div>
      <div className={styles.kvRow}>
        <span className={styles.kvLabel}>speak agent replies</span>
        <label className={styles.faint}>
          <input
            type="checkbox"
            checked={speakReplies}
            onChange={(e) => { setSpeakRepliesEnabled(e.target.checked); }}
            data-voice-speak-replies
          />{" "}
          {speakReplies ? "replies are spoken aloud · Esc stops the current one" : "muted — voice input still works"}
        </label>
      </div>
      {engines.map((e) => (
        <div className={styles.kvRow} key={e.id} data-voice-engine-row={e.id}>
          <span className={styles.kvLabel}>{e.label}</span>
          <span className={e.healthy ? styles.ok : styles.danger}>{e.healthy ? "ready" : "unavailable"}</span>
          {e.isLocal ? (
            <span className={styles.faint}>on-device</span>
          ) : (
            <span className={styles.warn}>⚠ audio leaves your machine</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// general — engine.id (readonly + copy) · daily cap (config.patch)
// ---------------------------------------------------------------------------

function GeneralSection() {
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirDraft, setDirDraft] = useState<string | null>(null);
  const [dirBusy, setDirBusy] = useState(false);

  const editing = capDraft !== null;
  const startEdit = (): void => { setError(null); setCapDraft(state.dailyCapUsd !== null ? String(state.dailyCapUsd) : ""); };

  const submitCap = async (): Promise<void> => {
    if (capDraft === null || busy) return;
    const parsed = parseDailyCap(capDraft);
    if (!parsed.ok) { setError(parsed.error); return; }
    setBusy(true);
    const ok = await cmds.setDailyCap(parsed.value);
    setBusy(false);
    if (ok) { setCapDraft(null); setError(null); }
  };

  // IMPORT-DIR: project import directory edit — same edit/save/cancel shape as
  // dailyCap above, but the input is a PathPicker (native folder browse).
  const editingDir = dirDraft !== null;
  const startEditDir = (): void => setDirDraft(state.projectImportDir ?? "");

  const submitDir = async (): Promise<void> => {
    if (dirDraft === null || dirBusy) return;
    setDirBusy(true);
    const ok = await cmds.setProjectImportDir(dirDraft.trim() || null);
    setDirBusy(false);
    if (ok) setDirDraft(null);
  };

  return (
    <div className={styles.section}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>general</span>
        </div>
        <div className={styles.kvRow}>
          <span className={styles.kvLabel}>engine.id</span>
          <span className={styles.value}>{state.engineId ?? "—"}</span>
          {state.engineId && <button className={styles.linkBtn} onClick={() => copyWithToast(state.engineId!)}>copy</button>}
          <span className={styles.faint}>this daemon's federation identity (read-only)</span>
        </div>
        <div className={styles.kvRow}>
          <span className={styles.kvLabel}>daily cap</span>
          {editing ? (
            <>
              <input
                className={styles.input}
                value={capDraft ?? ""}
                autoFocus
                placeholder="USD (blank clears)"
                onChange={(e) => { setCapDraft(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void submitCap(); if (e.key === "Escape") { setCapDraft(null); setError(null); } }}
                data-cap-input
              />
              <button className={styles.primaryBtn} disabled={busy} onClick={() => void submitCap()} data-cap-save>save</button>
              <button className={styles.ghostBtn} onClick={() => { setCapDraft(null); setError(null); }}>cancel</button>
            </>
          ) : (
            <>
              <span className={styles.value} data-cap-value>{fmtDailyCap(state.dailyCapUsd)}</span>
              <button className={styles.linkBtn} onClick={startEdit} data-cap-edit>edit</button>
              <span className={styles.faint}>advisory spend meter (config.patch dailyCapUsd)</span>
            </>
          )}
        </div>
        {error && <div className={styles.errorLine}>{error}</div>}
        <div className={styles.kvRow}>
          <span className={styles.kvLabel}>project import dir</span>
          {editingDir ? (
            <>
              <PathPicker
                value={dirDraft ?? ""}
                onChange={setDirDraft}
                mode="directory"
                placeholder="$CHIMERA_HOME/projects"
                className={styles.input}
                dataAttr="project-import-dir"
              />
              <button className={styles.primaryBtn} disabled={dirBusy} onClick={() => void submitDir()} data-import-dir-save>save</button>
              <button className={styles.ghostBtn} onClick={() => setDirDraft(null)}>cancel</button>
            </>
          ) : (
            <>
              <span className={styles.value} data-import-dir-value>{state.projectImportDir ?? "$CHIMERA_HOME/projects"}</span>
              <button className={styles.linkBtn} onClick={startEditDir} data-import-dir-edit>edit</button>
              <span className={styles.faint}>base dir for git-imported projects (project.import clones under &lt;dir&gt;/&lt;name&gt;)</span>
            </>
          )}
        </div>
      </div>
      <ConcurrencyCapSection />
      <VoiceEngineSection />
      <LayoutResetSection />
      <AppearanceSection />
    </div>
  );
}

// PANE-RESIZE: the escape hatch that makes dragging safe to try. Without it, an operator who drags
// a pane somewhere unusable has to find and fix each screen by hand — and a divider dragged nearly
// shut is exactly the state in which it is hardest to grab again.
//
// Layout is LOCAL, not config: it lives in this browser's storage, not in config.d/, so it is not
// a config.patch and it is not shared with the daemon or another machine. The copy says so, because
// "reset" next to a list of daemon settings otherwise reads as something more destructive.
function LayoutResetSection() {
  const custom = useSyncExternalStore(subscribePanes, hasCustomPaneWidths, hasCustomPaneWidths);
  return (
    <div className={styles.block}>
      <div className={styles.blockTitle}>layout</div>
      {/* kvRow/kvLabel, matching every other settings row — `row` is this screen's two-pane
          CONTAINER class, and reusing it here made an item row a flex container with the wrong
          padding. */}
      <div className={styles.kvRow}>
        <span className={styles.kvLabel}>pane widths</span>
        <span className={styles.value} data-pane-widths-state>{custom ? "customised" : "default"}</span>
        <button
          className={styles.linkBtn}
          onClick={() => resetPaneWidths()}
          // Disabled rather than hidden when there is nothing to reset: a control that vanishes is
          // one an operator goes looking for.
          disabled={!custom}
          data-pane-widths-reset
        >
          reset
        </button>
        <span className={styles.faint}>
          drag the divider between panes to resize · double-click one to reset just that screen · stored on this machine only
        </span>
      </div>
    </div>
  );
}

// HUMAN-TURN-COLOR: which colour your own transcript turns are drawn in. Local like the pane
// widths above (this machine's storage, not config.d/) and for the same reason — it is how YOU want
// to read the screen, not something the daemon or another operator should inherit.
function AppearanceSection() {
  const color = useSyncExternalStore(subscribeAppearance, userTurnColor, () => USER_TURN_DEFAULT);
  return (
    <div className={styles.block}>
      <div className={styles.blockTitle}>appearance</div>
      <div className={styles.kvRow}>
        <span className={styles.kvLabel}>your messages</span>
        <span className={styles.swatchRow} data-user-turn-swatches>
          {USER_TURN_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.swatch}
              style={{ background: userTurnCssValue(p.id) }}
              // Selection is marked with an attribute, not by recolouring the button: the button IS
              // the colour, so anything drawn on top of it has to survive every preset.
              aria-pressed={p.id === color}
              data-swatch={p.id}
              data-swatch-selected={p.id === color || undefined}
              title={p.label}
              onClick={() => setUserTurnColor(p.id)}
            />
          ))}
        </span>
        <span className={styles.faint}>
          the box around your own turns in the transcript · stored on this machine only
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CONCURRENCY-CAP-UI — a typed control for caps.maxAgentsTotal/dynamicCap/
// perAccount, replacing the raw-JSON config_patch escape hatch for this one
// knob (that hatch itself stays, unchanged, for everything else). Three
// blocks: the live effective-cap readout (daemon.status agentCap, never
// recomputed client-side), the static ceiling edit, and the optional
// resource-aware narrowing + per-account sub-forms.
// ---------------------------------------------------------------------------

export function ConcurrencyCapSection() {
  const state = useSyncExternalStore(cmds.subscribe, cmds.getState);
  const view = concurrencyCapView(state.maxAgentsTotal, state.dynamicCap, state.agentCap, state.agentsRunning);

  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [capBusy, setCapBusy] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const editingCap = capDraft !== null;
  const startEditCap = (): void => { setCapError(null); setCapDraft(String(state.maxAgentsTotal)); };
  const submitCap = async (): Promise<void> => {
    if (capDraft === null || capBusy) return;
    const parsed = parseMaxAgentsTotal(capDraft);
    if (!parsed.ok) { setCapError(parsed.error); return; }
    setCapBusy(true);
    const ok = await cmds.setMaxAgentsTotal(parsed.value);
    setCapBusy(false);
    if (ok) { setCapDraft(null); setCapError(null); }
  };

  const [dynDraft, setDynDraft] = useState<DynamicCapDraft | null>(null);
  const [dynBusy, setDynBusy] = useState(false);
  const [dynError, setDynError] = useState<string | null>(null);
  const editingDyn = dynDraft !== null;
  const startEditDyn = (): void => { setDynError(null); setDynDraft(dynamicCapDraft(state.dynamicCap)); };
  const submitDyn = async (): Promise<void> => {
    if (dynDraft === null || dynBusy) return;
    const parsed = parseDynamicCapDraft(dynDraft);
    if (!parsed.ok) { setDynError(parsed.error); return; }
    setDynBusy(true);
    const ok = await cmds.setDynamicCap(parsed.value);
    setDynBusy(false);
    if (ok) { setDynDraft(null); setDynError(null); }
  };
  const setDynField = (key: keyof DynamicCapDraft, value: string | boolean): void => {
    setDynDraft((d) => (d ? { ...d, [key]: value } : d));
    setDynError(null);
  };

  const [acctEdit, setAcctEdit] = useState<string | null>(null);
  const [acctDraft, setAcctDraft] = useState("");
  const [acctError, setAcctError] = useState<string | null>(null);
  const [acctBusy, setAcctBusy] = useState(false);
  const startEditAccount = (name: string): void => {
    setAcctError(null);
    setAcctEdit(name);
    setAcctDraft(state.perAccount[name] !== undefined ? String(state.perAccount[name]) : "");
  };
  const submitAccount = async (): Promise<void> => {
    if (acctEdit === null || acctBusy) return;
    const parsed = parsePerAccountCap(acctDraft);
    if (!parsed.ok) { setAcctError(parsed.error); return; }
    setAcctBusy(true);
    const ok = await cmds.setPerAccountCap(acctEdit, parsed.value);
    setAcctBusy(false);
    if (ok) { setAcctEdit(null); setAcctError(null); }
  };

  return (
    <div className={styles.card} data-concurrency-cap-card>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>concurrency cap</span>
      </div>

      <div className={styles.kvRow} data-cap-live>
        <span className={styles.kvLabel}>running now</span>
        <span className={styles.value} data-cap-running>{view.agentsRunning}</span>
        <span className={styles.kvLabel}>effective cap</span>
        <span className={styles.value} data-cap-effective>
          {view.narrowing ? `${view.cap} of ${view.ceiling}` : view.cap}
        </span>
        {!view.dynamicEnabled && <span className={styles.faint} data-cap-dynamic-state>static ceiling — dynamic cap off</span>}
        {view.dynamicEnabled && !view.narrowing && <span className={styles.faint} data-cap-dynamic-state>dynamic cap on — no pressure right now</span>}
        {view.dynamicEnabled && view.narrowing && <span className={styles.warn} data-cap-dynamic-state>dynamic cap narrowing the ceiling</span>}
        {!view.healthy && <span className={styles.danger} data-cap-unhealthy>probe failed — using static ceiling</span>}
      </div>
      {view.explain && <div className={styles.faint} data-cap-explain>{view.explain}</div>}

      <div className={styles.kvRow}>
        <span className={styles.kvLabel}>ceiling</span>
        {editingCap ? (
          <>
            <input
              className={styles.input}
              value={capDraft ?? ""}
              autoFocus
              onChange={(e) => { setCapDraft(e.target.value); setCapError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void submitCap(); if (e.key === "Escape") { setCapDraft(null); setCapError(null); } }}
              data-maxagents-input
            />
            <button className={styles.primaryBtn} disabled={capBusy} onClick={() => void submitCap()} data-maxagents-save>save</button>
            <button className={styles.ghostBtn} onClick={() => { setCapDraft(null); setCapError(null); }}>cancel</button>
          </>
        ) : (
          <>
            <span className={styles.value} data-maxagents-value>{state.maxAgentsTotal}</span>
            <button className={styles.linkBtn} onClick={startEditCap} data-maxagents-edit>edit</button>
            <span className={styles.faint}>caps.maxAgentsTotal (config.patch)</span>
          </>
        )}
      </div>
      {capError && <div className={styles.errorLine} data-maxagents-error>{capError}</div>}

      {/* Unmissable at the point of editing (not a tooltip) — the operator's own
          question this whole control exists to answer. */}
      <div className={styles.faint} data-cap-lower-warning>{LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS}</div>

      <div className={styles.kvRow}>
        <span className={styles.kvLabel}>dynamic cap</span>
        <span className={styles.value} data-dynamiccap-summary>
          {state.dynamicCap?.enabled
            ? `on · floor ${state.dynamicCap.floor} · cpu ${state.dynamicCap.cpuLowWatermark}-${state.dynamicCap.cpuHighWatermark} · mem ${state.dynamicCap.memLowWatermarkGb}-${state.dynamicCap.memHighWatermarkGb}GB`
            : "off"}
        </span>
        <button className={styles.linkBtn} onClick={startEditDyn} data-dynamiccap-edit>edit</button>
        <span className={styles.faint}>narrows the ceiling under real CPU/memory pressure (never below floor)</span>
      </div>

      {editingDyn && dynDraft && (
        <div className={styles.confirmRow} data-dynamiccap-form>
          <label>
            <input type="checkbox" checked={dynDraft.enabled} onChange={(e) => setDynField("enabled", e.target.checked)} data-dynamiccap-enabled />
            <span> enabled</span>
          </label>
          {([
            ["floor", "floor (min agents, hard limit)"],
            ["cpuHighWatermark", "cpu high watermark (load/core ratio — enters pressure)"],
            ["cpuLowWatermark", "cpu low watermark (recovers below this)"],
            ["cpuCriticalRatio", "cpu critical ratio (fully collapsed to floor)"],
            ["memLowWatermarkGb", "mem low watermark GB (enters pressure)"],
            ["memHighWatermarkGb", "mem high watermark GB (recovers above this)"],
            ["memCriticalGb", "mem critical GB (fully collapsed to floor)"],
            ["emaAlpha", "EWMA smoothing (0-1)"],
          ] as const).map(([key, label]) => (
            <div className={styles.kvRow} key={key}>
              <span className={styles.kvLabel}>{label}</span>
              <input
                className={styles.input}
                value={dynDraft[key]}
                onChange={(e) => setDynField(key, e.target.value)}
                data-dynamiccap-field={key}
              />
            </div>
          ))}
          {dynError && <div className={styles.errorLine} data-dynamiccap-error>{dynError}</div>}
          <div className={styles.rowActions}>
            <button className={styles.primaryBtn} disabled={dynBusy} onClick={() => void submitDyn()} data-dynamiccap-save>save</button>
            <button className={styles.ghostBtn} onClick={() => { setDynDraft(null); setDynError(null); }}>cancel</button>
          </div>
        </div>
      )}

      <div className={styles.kvRow}>
        <span className={styles.kvLabel}>per-account caps</span>
        <span className={styles.faint}>optional — keeps one account from taking every slot</span>
      </div>
      <div data-peraccount-rows>
        {state.accounts.length === 0 ? (
          <div className={styles.emptyHint}>no accounts configured</div>
        ) : state.accounts.map((a) => (
          <div className={styles.kvRow} key={a.name} data-peraccount-row={a.name}>
            <span className={styles.kvLabel}>{a.name}</span>
            {acctEdit === a.name ? (
              <>
                <input
                  className={styles.input}
                  value={acctDraft}
                  autoFocus
                  placeholder="blank = no limit"
                  onChange={(e) => { setAcctDraft(e.target.value); setAcctError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitAccount(); if (e.key === "Escape") { setAcctEdit(null); setAcctError(null); } }}
                  data-peraccount-input={a.name}
                />
                <button className={styles.primaryBtn} disabled={acctBusy} onClick={() => void submitAccount()} data-peraccount-save={a.name}>save</button>
                <button className={styles.ghostBtn} onClick={() => { setAcctEdit(null); setAcctError(null); }}>cancel</button>
              </>
            ) : (
              <>
                <span className={styles.value} data-peraccount-value={a.name}>
                  {state.perAccount[a.name] !== undefined ? state.perAccount[a.name] : "no limit"}
                </span>
                <button className={styles.linkBtn} onClick={() => startEditAccount(a.name)} data-peraccount-edit={a.name}>edit</button>
              </>
            )}
            {acctEdit === a.name && acctError && <div className={styles.errorLine} data-peraccount-error>{acctError}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
