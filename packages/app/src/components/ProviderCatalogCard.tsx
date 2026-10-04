import { useState } from "react";
import { compactionThresholdLabel, parseProviderOverride, type ProviderCatalogRow } from "../state/selectors.settings";
import type { ProviderOAuthState } from "../state/commands.settings";
import styles from "./ProviderCatalogCard.module.css";

// F23-2B (D5/D6) — one catalog card per provider (Settings' Providers section):
// capability chips, connection state, tosNote (subscription/oauth providers),
// base-URL/default-model override inputs, and per-provider actions (add key /
// connect via subscription / test / remove). A standalone presentational
// component (props only, no store/rpc import) so it renders and unit-tests in
// isolation — same discipline as WorkflowCard.tsx.
export function ProviderCatalogCard({
  row, onAddKey, onTest, onRemove, onSaveOverride, onConnectSubscription, oauth, onCancelOAuth,
}: {
  row: ProviderCatalogRow;
  onAddKey: () => void;
  onTest: (name: string) => void;
  onRemove: (name: string) => void;
  onSaveOverride: (value: { baseUrl?: string; defaultModel?: string; compactionThreshold?: number | null } | null) => void;
  /** KIMI-CODE-SUBSCRIPTION-UI: fires the unified "connect with subscription" click —
   * the CALLER picks accounts.add_subscription vs accounts.oauth_start based on
   * row.kind, this component doesn't need to know which. */
  onConnectSubscription: () => void;
  /** In-flight accounts.oauth_start/finish state for THIS row's oauth branch (undefined
   * = idle/never started). Irrelevant (and unused) for the agentic-sdk/CLI-subscription
   * branch, which has no polling step. */
  oauth?: ProviderOAuthState;
  onCancelOAuth?: () => void;
}) {
  const [editingOverride, setEditingOverride] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState(row.overridden ? row.baseUrl : "");
  const [modelDraft, setModelDraft] = useState(row.overridden ? row.defaultModel : "");
  const [compactionDraft, setCompactionDraft] = useState(typeof row.compactionThreshold === "number" ? String(row.compactionThreshold) : "");
  const [nativeDraft, setNativeDraft] = useState(row.compactionThreshold === null);

  const startEdit = (): void => {
    setBaseUrlDraft(row.overridden ? row.baseUrl : "");
    setModelDraft(row.overridden ? row.defaultModel : "");
    setCompactionDraft(typeof row.compactionThreshold === "number" ? String(row.compactionThreshold) : "");
    setNativeDraft(row.compactionThreshold === null);
    setEditingOverride(true);
  };
  const saveOverride = (): void => {
    onSaveOverride(parseProviderOverride(baseUrlDraft, modelDraft, compactionDraft, nativeDraft));
    setEditingOverride(false);
  };

  return (
    <div className={styles.card} data-provider-catalog-card={row.id}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{row.label}</span>
        <span className={styles.muted}>{row.kind}</span>
        {row.experimental && <span className={styles.warn} data-experimental>experimental</span>}
        <span className={styles.spacer} />
        <span className={row.connected ? styles.ok : styles.faint} data-connection-state>{row.connectionLabel}</span>
      </div>

      <div className={styles.chipRow} data-capability-chips>
        {row.chips.map((c) => (
          <span key={c.key} className={c.on ? styles.chipOn : styles.chipOff}>{c.label}</span>
        ))}
      </div>

      {row.tosNote && row.supportsSubscription && (
        <div className={styles.tosNote} data-tos-note>{row.tosNote}</div>
      )}

      {row.accounts.length > 0 && (
        <div className={styles.accountChipRow} data-connected-accounts>
          {row.accounts.map((a) => (
            <span key={a.name} className={styles.accountChip}>
              {a.name}
              <button className={styles.linkBtn} onClick={() => onTest(a.name)} data-catalog-test={a.name}>test</button>
              <button className={styles.linkBtn} onClick={() => onRemove(a.name)} data-catalog-remove={a.name}>remove</button>
            </span>
          ))}
        </div>
      )}

      {editingOverride ? (
        <div className={styles.authRow} data-override-form={row.id}>
          <input className={styles.input} placeholder={`base URL (default: ${row.baseUrl})`} value={baseUrlDraft} onChange={(e) => setBaseUrlDraft(e.target.value)} data-override-base-url />
          <input className={styles.input} placeholder={`default model (default: ${row.defaultModel})`} value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} data-override-model />
          <input className={styles.input} type="number" min={1} placeholder="compaction threshold (tokens)" value={nativeDraft ? "" : compactionDraft} disabled={nativeDraft} onChange={(e) => setCompactionDraft(e.target.value)} data-override-compaction-threshold />
          {/* COMPACTION-THRESHOLD-CONFIG: "native" is an EXPLICIT null, not an empty field — since
              F39 an absent threshold falls back to the provider's fleet default. It rides the
              CONFIG_PATCH_NULL escape through config.patch (see providerOverridePatch), so it is
              mutually exclusive with the tokens input above. */}
          <label className={styles.muted} data-override-native-label>
            <input type="checkbox" checked={nativeDraft} onChange={(e) => setNativeDraft(e.target.checked)} data-override-compaction-native />
            {" "}use model native
          </label>
          <button className={styles.primaryBtn} onClick={saveOverride} data-override-save>save</button>
          <button className={styles.ghostBtn} onClick={() => setEditingOverride(false)}>cancel</button>
          <div className={styles.muted}>set below the model's context window; empty = {compactionThresholdLabel(row.id, undefined)}; “use model native” = {compactionThresholdLabel(row.id, null)}.</div>
        </div>
      ) : (
        <div className={styles.metaRow}>
          <span>base url <span className={styles.value}>{row.baseUrl}</span></span>
          <span>default model <span className={styles.value}>{row.defaultModel}</span></span>
          <span>compaction threshold <span className={styles.value}>{compactionThresholdLabel(row.id, row.compactionThreshold)}</span></span>
          {row.overridden && <span className={styles.warn}>overridden</span>}
        </div>
      )}

      <div className={styles.rowActions}>
        {row.supportsApiKey && (
          <button className={styles.ghostBtn} onClick={onAddKey} data-catalog-add-key={row.id}>+ add api key</button>
        )}
        {/* KIMI-CODE-SUBSCRIPTION-UI: ONE "connect with subscription" affordance per
            provider — agentic-sdk (claude/codex) rides accounts.add_subscription (no
            polling: the CLI's own ambient login either resolves or errors immediately),
            everything else with an oauth authMode (copilot/grok-build/any future
            oauth-mode entry) rides accounts.oauth_start/finish, which MAY need to show
            a device code / authorize link and poll — `oauth` carries that state; for
            "immediate" CLI-file-backed flows it never visibly leaves "connecting…". */}
        {(row.supportsSubscriptionLogin || row.supportsSubscription) && (() => {
          const oauthBranch = !row.supportsSubscriptionLogin;
          const busy = oauthBranch && (oauth?.status === "starting" || oauth?.status === "awaiting" || oauth?.status === "polling");
          const connected = oauthBranch ? row.subscriptionOAuthConnected && oauth?.status !== "error" : row.subscriptionLoginConnected;
          return (
            <div className={styles.authRow} data-catalog-connect-subscription-group={row.id}>
              <button
                className={connected ? styles.subscriptionConnectedBtn : styles.ghostBtn}
                onClick={connected || busy ? undefined : onConnectSubscription}
                disabled={connected || busy}
                data-catalog-connect-subscription={row.id}
              >
                {connected ? "✓ connected with subscription" : busy ? "connecting…" : "connect with subscription"}
              </button>
              {oauthBranch && busy && (
                <button className={styles.linkBtn} onClick={onCancelOAuth} data-catalog-oauth-cancel={row.id}>cancel</button>
              )}
              {oauthBranch && oauth?.userCode && (
                <span className={styles.muted} data-catalog-oauth-code={row.id}>
                  code <span className={styles.value}>{oauth.userCode}</span>
                  {oauth.verificationUri ? <> at <span className={styles.value}>{oauth.verificationUri}</span></> : null}
                </span>
              )}
              {oauthBranch && oauth?.authorizeUrl && (
                <a className={styles.linkBtn} href={oauth.authorizeUrl} target="_blank" rel="noreferrer" data-catalog-oauth-url={row.id}>open authorize URL</a>
              )}
              {oauthBranch && oauth?.status === "error" && oauth.error && (
                <div className={styles.danger} data-catalog-oauth-error={row.id}>{oauth.error}</div>
              )}
            </div>
          );
        })()}
        {!editingOverride && (
          <button className={styles.linkBtn} onClick={startEdit} data-catalog-edit-override={row.id}>edit override (base-URL / model / compaction)</button>
        )}
      </div>
    </div>
  );
}
