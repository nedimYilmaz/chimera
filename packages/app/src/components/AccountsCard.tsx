import { useEffect, useState } from "react";
import type { AccountStatus, UiState } from "@chimera/ui-state";
import type { AccountQuotaWindow } from "@chimera/protocol";
import { registerOverlay } from "./OverlayOutlet";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import {
  accountToneVar, quotaAbsoluteReset, quotaFillFraction, quotaReasonLabel, quotaRelativeCountdown, quotaTone,
  quotaWindow, quotaWindowState,
} from "../state/selectors";
import { accountSpendLabel } from "../state/selectors.system";
import { coolingLong, useSystemLocal } from "../state/commands.system";
import { displayChord } from "../keymap";
import styles from "./AccountsCard.module.css";

// W6 build item 1 — the AccountsCard (mock showAccounts, lines 327-348):
// 680 card, "accounts & peers" header w/ "mod+u / esc close" hint, the
// account table (▪ identity color · provider · health w/ ticking cooling
// countdown · spend today · failover order) + the federation block (local
// engine ◆ row, per-peer ⇅ state/outbox/grants incl. the partitioned copy).
// Data: ui-state accounts (daemon.status projection — cooling/coolingUntil/
// authExpired live) + accountList (accounts.list detail, loaded on open by
// SystemCommands.toggleAccounts) + systemLocal engineId/peerAccounts.
// Failover order = the config autoOrder index: the registry serves accounts
// in config order, so the row's position IS its failover slot (coverage B7).
// KEYMAP-REDESIGN: mod+u is bound on every scope EXCEPT "agents" (letter-budget
// trade, rows.system.ts's everyScopeExceptAgents) — on the agents tab this card
// is reachable only via the command palette (mod+b).
// ACCOUNT-QUOTA-METERS Layer 2 — "all of it must be visible", nothing hover-only. One labelled
// row per window (session/weekly), each with a full-width meter (spendMeter's SAME ▓/░ glyphs
// and quotaTone's SAME 70/90% threshold — no second meter style, no second threshold scale),
// the used %, and BOTH a relative countdown and the absolute reset time (design mockup: session
// reads "resets in <rel> (<abs>)", weekly reads "<abs> (in <rel>)" — the weekday-qualified form
// reads first when the reset is typically days out). A window with no data (every codex
// account, always — see claude.ts's normalizeClaudeRateLimit) or a STALE one (past its claimed
// resetsAt — a new window has silently begun and the old % no longer describes it) renders
// dimmed with an explicit caveat instead of a live-looking bar. No block at all when an account
// has NEVER reported any window — nothing to show is not the same as something hidden.
function quotaRowText(w: AccountQuotaWindow, now: number): string {
  const rel = quotaRelativeCountdown(w.resetsAt, now);
  const abs = quotaAbsoluteReset(w.resetsAt, w.kind);
  return w.kind === "session" ? `resets in ${rel} (${abs})` : `${abs} (in ${rel})`;
}

// WEEKLY-QUOTA-VARIANT-KEYS: an account can report several simultaneous weekly buckets (e.g.
// seven_day_opus AND seven_day_sonnet) — normalizeClaudeUsagePoll picks the most-constraining one
// and names it in `w.variant`. Surfacing that label here is what keeps a multi-bucket account's
// "weekly 94%" from reading as an unqualified blended figure when it's really just one bucket.
function quotaLabelText(label: string, w: AccountQuotaWindow): string {
  return w.variant ? `${label} (${w.variant})` : label;
}

const QUOTA_TONE_CLASS: Record<ReturnType<typeof quotaTone>, string> = { success: styles.ok, warn: styles.warn, danger: styles.danger };

function QuotaRow({ label, w, now }: { label: string; w: AccountQuotaWindow | undefined; now: number }) {
  if (!w) return (
    <div className={styles.quotaRow} data-quota-row={label}>
      <span className={styles.quotaLabel}>{label}</span>
      <span className={styles.faint}>no data</span>
    </div>
  );
  const state = quotaWindowState(w, now);
  const pct = Math.round(quotaFillFraction(w) * 100);
  if (state !== "live") {
    return (
      <div className={styles.quotaRow} data-quota-row={label} data-quota-state={state}>
        <span className={styles.quotaLabel}>{quotaLabelText(label, w)}</span>
        <span className={styles.faint}>last known {pct}% (stale — window has likely reset)</span>
      </div>
    );
  }
  const toneClass = QUOTA_TONE_CLASS[quotaTone(w, now)];
  return (
    <div className={styles.quotaRow} data-quota-row={label} data-quota-state={state}>
      <span className={styles.quotaLabel}>{quotaLabelText(label, w)}</span>
      <span className={styles.quotaMeter} role="meter" aria-label={`${label} quota used`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span className={toneClass} style={{ width: `${pct}%` }} /></span>
      <span className={styles.muted}> {pct}%</span>
      <span className={styles.faint}> · {quotaRowText(w, now)}</span>
    </div>
  );
}

function AccountQuotaBlock({ account, now }: { account: AccountStatus; now: number }) {
  const session = quotaWindow(account.quota, "session");
  const weekly = quotaWindow(account.quota, "weekly");
  if (!session && !weekly) {
    // QUOTA-ABSENCE-IS-INVISIBLE: no bars to show — say WHY instead of rendering nothing, so
    // "not supported" reads differently from "polling is failing" from "never tried yet".
    const label = quotaReasonLabel(account.quotaReason);
    if (!label) return null;
    return (
      <div className={styles.quotaBlock} data-quota-block={account.name} data-quota-reason={account.quotaReason?.kind}>
        <span className={styles.faint}>{label}</span>
      </div>
    );
  }
  return (
    <div className={styles.quotaBlock} data-quota-block={account.name}>
      <div className={styles.quotaLegend}>top-bar chip border: top = session, bottom = weekly</div>
      <QuotaRow label="session" w={session} now={now} />
      <QuotaRow label="weekly" w={weekly} now={now} />
    </div>
  );
}

export function AccountsCard() {
  const open = useStore((s: UiState) => s.accountsOpen);
  const accounts = useStore((s: UiState) => s.accounts);
  const peers = useStore((s: UiState) => s.peers);
  const engineId = useSystemLocal((s) => s.engineId);
  const peerAccounts = useSystemLocal((s) => s.peerAccounts);

  // cooling countdown ticks once per second while any account cools (B7); ACCOUNT-QUOTA-METERS
  // extends the same ticker to any account with at least one recorded quota window, so the
  // relative countdowns/pace-implied % keep moving live while the card is open (design: "the
  // interval doesn't run when nothing is counting" — mirrors TopBarChips.tsx's identical idiom).
  const anyCooling = accounts.some((a) => a.cooling && a.coolingUntil !== null);
  const anyQuota = accounts.some((a) => (a.quota?.windows.length ?? 0) > 0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || (!anyCooling && !anyQuota)) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(id);
  }, [open, anyCooling, anyQuota]);

  if (!open) return null;
  const close = (): void => appStore.dispatch({ type: "accountsOpen", open: false });
  const hasCodex = accounts.some((a) => a.provider === "codex");

  return (
    <OverlayCard width={680} align="center" onClose={close}>
      <OverlayCardHeader title="accounts & peers" hint={`${displayChord("mod+u")} / esc close`} />
      <div className={styles.table}>
      <div className={styles.cols}>
        <div className={styles.colAccount}>account</div>
        <div className={styles.colProvider}>provider</div>
        <div className={styles.colHealth}>health</div>
        <div className={styles.colSpend}>spend today</div>
        <div className={styles.colFailover}>failover</div>
      </div>
      <div className={styles.rows} data-accounts-rows>
        {accounts.length === 0 ? (
          <div className={styles.empty}>no accounts configured</div>
        ) : (
          accounts.map((a, i) => (
            <div key={a.name} className={styles.rowGroup}>
              <div className={styles.row}>
                <div data-label="account" className={styles.colAccount}>
                  <span style={{ color: `var(${accountToneVar(a.name)})` }}>▪</span> {a.name}
                </div>
                <div data-label="provider" className={`${styles.colProvider} ${styles.muted}`}>{a.provider}</div>
                <div data-label="health" className={styles.colHealth}>
                  {a.authExpired ? (
                    <>
                      <span className={styles.danger}>✗</span>
                      <span className={styles.danger}> auth expired</span>
                    </>
                  ) : a.cooling ? (
                    <>
                      <span className={styles.warn}>◌</span>
                      <span className={styles.warn}> cooling</span>
                      {a.coolingUntil !== null && (
                        <span className={styles.faint}> {coolingLong(a.coolingUntil, now)}</span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className={styles.ok}>●</span>
                      <span className={styles.muted}> healthy</span>
                    </>
                  )}
                </div>
                <div data-label="spend today" className={`${styles.colSpend} ${styles.muted}`}>
                  {accountSpendLabel(a as unknown as Record<string, unknown>)}
                </div>
                <div data-label="failover" className={`${styles.colFailover} ${styles.muted}`}>{i + 1}</div>
              </div>
              <AccountQuotaBlock account={a} now={now} />
            </div>
          ))
        )}
        {hasCodex ? (
          <div className={styles.codexNote}>
            Codex spend is estimated from token usage; quotas are reported by the provider.
          </div>
        ) : null}
      </div>
      </div>
      <div className={styles.federation} data-federation>
        <div className={styles.fedRow}>
          <span className={styles.fedLabel}>federation</span>
          <span>
            <span className={styles.fedLocal}>◆ {engineId ?? "local"}</span>
            <span className={styles.faint}> · local engine · this machine</span>
          </span>
        </div>
        {peers.map((p) => {
          const grants = peerAccounts[p.engineId];
          const partitioned = p.state !== "connected";
          return (
            <div key={p.engineId} className={styles.fedRow}>
              <span className={styles.fedLabel} />
              <span>
                {partitioned ? (
                  // partitioned variant copy (mock peer_part, line 42)
                  <>
                    <span className={styles.danger}>⇅ {p.engineId} partitioned</span>
                    <span className={styles.muted}> · {p.outboxPending} out</span>
                  </>
                ) : (
                  <>
                    <span className={styles.ok}>⇅ {p.engineId}</span>
                    <span className={styles.muted}> {p.state}</span>
                    <span className={styles.faint}>
                      {" "}· outbox {p.outboxPending}
                      {grants && grants.length > 0 ? ` · grants: accounts: ${grants.join(", ")}` : ""}
                    </span>
                  </>
                )}
              </span>
            </div>
          );
        })}
        <div className={styles.fedRow}>
          <span className={styles.fedLabel} />
          <span className={styles.ghost}>
            credentials never cross to a peer · remote agent rows carry the ⇅ @engine tag · while partitioned the outbox accumulates, then drains when the link returns
          </span>
        </div>
      </div>
    </OverlayCard>
  );
}

registerOverlay("system.accounts", AccountsCard);
