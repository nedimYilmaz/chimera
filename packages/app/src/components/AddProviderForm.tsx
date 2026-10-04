import { useState } from "react";
import { appStore } from "../state/store";
import { rpcCall } from "../rpc/bridge";
import { getSettingsCommands } from "../state/commands.settings";
import { maskKey, type ProviderCatalogRow } from "../state/selectors.settings";
import styles from "../screens/SettingsScreen.module.css";

const cmds = getSettingsCommands(appStore, rpcCall);

// ONBOARDING-PROVIDER: the generic "add provider" form, shared by the Settings
// providers section AND the WelcomeScreen's zero-account onboarding state. Offers
// TWO auth paths — api key (accounts.add + accounts.setKey, the pre-existing
// path) or subscription (accounts.add_subscription, riding the provider CLI's own
// ambient login) — the latter gated to catalog kind "agentic-sdk" (claude/codex;
// ProviderCatalogRow.supportsSubscriptionLogin), matching the per-provider catalog
// card's own "connect with subscription" button (ProviderCatalogCard.tsx).
export function AddProviderForm({
  initialProvider, providerOptions, catalogRows, onDone,
}: {
  initialProvider: string;
  providerOptions: readonly string[];
  catalogRows: readonly ProviderCatalogRow[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState(initialProvider);
  const [authType, setAuthType] = useState<"apiKey" | "subscription">("apiKey");
  // The key lives ONLY here while typing; it is handed to accounts.setKey on
  // submit and immediately dropped — never lifted into any store (F09).
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const catalogRow = catalogRows.find((r) => r.id === provider);
  const subscriptionEligible = catalogRow?.supportsSubscriptionLogin ?? false;
  const subscriptionConnected = catalogRow?.subscriptionLoginConnected ?? false;

  const selectProvider = (p: string): void => {
    setProvider(p);
    const eligible = catalogRows.find((r) => r.id === p)?.supportsSubscriptionLogin ?? false;
    if (authType === "subscription" && !eligible) setAuthType("apiKey");
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    if (authType === "subscription") {
      if (!subscriptionEligible || subscriptionConnected) return;
      setBusy(true);
      const ok = await cmds.connectSubscription(provider);
      setBusy(false);
      if (ok) onDone();
      return;
    }
    if (!name.trim()) return;
    setBusy(true);
    const ok = await cmds.addProvider(name.trim(), provider, key, catalogRow?.requiresKey === false);
    setBusy(false);
    if (ok) { setKey(""); setName(""); onDone(); } // clear the secret draft on success
  };

  const onEnterOrEscape = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") onDone();
  };

  return (
    <div className={styles.addForm} data-add-form>
      <div className={styles.addHead}>
        <span className={styles.addTitle}>add provider</span>
        <span className={styles.spacer} />
        <span className={styles.faint}>{authType === "subscription" ? "enter connect · esc cancel" : "enter save → Keychain · esc cancel"}</span>
      </div>
      <div className={styles.formGrid}>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>provider</span>
          <select className={styles.select} value={provider} onChange={(e) => selectProvider(e.target.value)} data-provider-select>
            {providerOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>auth</span>
          <button
            type="button"
            className={authType === "apiKey" ? styles.primaryBtn : styles.ghostBtn}
            onClick={() => setAuthType("apiKey")}
            data-auth-type-apikey
          >api key</button>
          <button
            type="button"
            className={authType === "subscription" ? styles.primaryBtn : styles.ghostBtn}
            disabled={!subscriptionEligible}
            title={!subscriptionEligible ? "CLI subscription is claude/codex only" : undefined}
            onClick={() => setAuthType("subscription")}
            data-auth-type-subscription
          >subscription</button>
          {!subscriptionEligible && <span className={styles.faint}>CLI subscription is claude/codex only</span>}
        </label>

        {authType === "apiKey" ? (
          <>
            <label className={styles.formRow}>
              <span className={styles.formLabel}>name</span>
              <input
                className={styles.input}
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onEnterOrEscape}
                data-provider-name
              />
            </label>
            {catalogRow?.requiresKey !== false ? <label className={styles.formRow}>
              <span className={styles.formLabelKey}>api key</span>
              <input
                className={styles.inputKey}
                type="password"
                value={key}
                placeholder="write-only — never read back"
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={onEnterOrEscape}
                data-provider-key
              />
              <span className={styles.faint}>{key ? maskKey(key.length) : "→ Keychain"}</span>
            </label> : <div className={styles.formRow}><span className={styles.formLabel}>auth</span><span className={styles.faint}>no API key required</span></div>}
          </>
        ) : (
          <div className={styles.formRow}>
            <span className={styles.faint}>
              {subscriptionConnected
                ? `already connected via ${provider}'s CLI subscription`
                : `rides ${provider}'s own CLI login — no key needed, no name to set`}
            </span>
          </div>
        )}
      </div>
      <div className={styles.addActions}>
        {authType === "apiKey" ? (
          <button className={styles.primaryBtn} disabled={busy || !name.trim()} onClick={() => void submit()} data-provider-save>
            {catalogRow?.requiresKey === false ? "save" : "save → Keychain"}
          </button>
        ) : (
          <button
            className={styles.primaryBtn}
            disabled={busy || !subscriptionEligible || subscriptionConnected}
            onClick={() => void submit()}
            data-provider-connect-subscription
          >connect</button>
        )}
        <span className={styles.faint}>
          {authType === "apiKey"
            ? catalogRow?.requiresKey === false
              ? "no secret is stored — connectivity is tested after save"
              : "only name · provider · authRef are written to config — test with t once saved"
            : "no key ever leaves the provider CLI's own login"}
        </span>
      </div>
    </div>
  );
}
