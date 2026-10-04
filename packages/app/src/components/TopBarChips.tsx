import { useEffect, useState } from "react";
import { type UiState } from "@chimera/ui-state";
import { useConn } from "../rpc/useConnState";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { runAction } from "../keymap";
import type { AccountStatus } from "@chimera/ui-state";
import {
  accountToneVar, fmtCost, quotaChipTitle, quotaElapsedFraction, quotaFillFraction,
  quotaTone, quotaWindow, quotaWindowState, spendMeter, totalSpendUsd,
} from "../state/selectors";
import { peerChipModel } from "../state/selectors.system";
import { coolingMSS, spendTone, useSystemLocal } from "../state/commands.system";
import styles from "./TopBarChips.module.css";

// Top-bar STATUS CHIPS, split out of TopBar so the chip internals (W6: real
// spendTodayUsd/dailyCapUsd + threshold colors, partitioned peers, cooling
// accounts, click->AccountsCard) and the tab strip (W7: projects tab, unseen
// badge) evolve under different owners without touching one file together.

// The three conn states, markup 1:1 from the mock (conn_ok / conn_re / conn_off).
// RTT is a real measurement (one daemon.status round-trip per connect) rather
// than the mock's static "rtt 1.1ms"; the span is omitted while unknown.
export function ConnChip() {
  const { state, rttMs } = useConn();
  if (state === "reconnecting") {
    return (
      <div className={styles.conn}>
        <span className={styles.connDotRe}>◌</span>
        <span className={styles.connRe}> reconnecting…</span>
      </div>
    );
  }
  if (state === "disconnected") {
    return (
      <div className={styles.conn}>
        <span className={styles.connOff}>○ disconnected</span>
      </div>
    );
  }
  return (
    <div className={styles.conn}>
      <span className={styles.connDotOk}>●</span>
      <span className={styles.connName}> chimerad</span>
      {rttMs !== null && <span className={styles.connRtt}> rtt {rttMs.toFixed(1)}ms</span>}
    </div>
  );
}

/** The chip click = the SAME action id mod+u dispatches (mouse=keyboard). */
const openAccounts = (): void => { runAction("system.accounts", appStore); };

/** W21 (F19): the spend chip opens the usage & cost card instead of the
 * accounts card — accounts/peer chips still open AccountsCard via
 * openAccounts above. */
const openUsage = (): void => { runAction("system.usage", appStore); };

/** Federation peers (daemon.status). ONE chip regardless of peer count: a
 * single peer keeps the per-peer form ("⇅ studio 0 out" / partitioned variant
 * from mock peer_part line 42), N>1 collapse into "⇅ N peers" (coverage B1)
 * with a hover title listing every peer. ANY partitioned peer tips the chip to
 * the danger tint. Click → the AccountsCard's federation block. Hidden when
 * unfederated. */
export function PeerChips() {
  const peers = useStore((s: UiState) => s.peers);
  const model = peerChipModel(peers);
  if (model === null) return null;

  if (model.kind === "single") {
    return model.partitioned ? (
      <button type="button" className={styles.chipPart} onClick={openAccounts} data-peer-chip={model.engineId}>
        <span className={styles.peerPart}>⇅ {model.engineId} partitioned</span>
        <span className={styles.muted}> · {model.outboxPending} out</span>
      </button>
    ) : (
      <button type="button" className={styles.chipClick} onClick={openAccounts} data-peer-chip={model.engineId}>
        <span className={styles.peerName}>⇅ {model.engineId}</span>
        <span className={styles.dim}> {model.outboxPending} out</span>
      </button>
    );
  }

  // N>1 → one aggregate chip; danger tone + out count when any peer partitioned.
  return model.partitioned ? (
    <button type="button" className={styles.chipPart} onClick={openAccounts} title={model.title} data-peer-chip-agg>
      <span className={styles.peerPart}>⇅ {model.count} peers</span>
      {model.outboxPending > 0 && <span className={styles.muted}> · {model.outboxPending} out</span>}
    </button>
  ) : (
    <button type="button" className={styles.chipClick} onClick={openAccounts} title={model.title} data-peer-chip-agg>
      <span className={styles.peerName}>⇅ {model.count} peers</span>
    </button>
  );
}

const QUOTA_TONE_VAR: Record<ReturnType<typeof quotaTone>, string> = { success: "--success", warn: "--warn", danger: "--danger" };

/** ACCOUNT-QUOTA-METERS: one edge (top=session / bottom=weekly) of an account box's quota
 * border. `state` decides the whole rendering: "unknown"/"stale" (or the account is COOLING —
 * see AccountsChip's precedence comment) paint a flat faint track with no fill claim and no
 * pace notch, never a plausible-looking number with nothing behind it. "live" paints a
 * hard-stop gradient plus a 1px notch at the pace-marker position — fill reaching past the
 * notch reads as over-pace (the notch's own color, not the fill's, is what visually breaks
 * there). The fill color is identity-by-default / alarm-when-it-matters: it's the SAME account
 * color as the "▪ name" dot next to it (the user asked the quota bar to read as "this
 * account's meter", not a generic traffic light) EXCEPT at warn/danger, where the tone color
 * takes over — that is the one signal that says "you are about to run out" and must not be
 * silently replaced by identity color. Pure presentation glue over already-tested selectors.ts
 * math (quotaFillFraction/quotaElapsedFraction/quotaTone) — nothing here recomputes a fraction.
 */
function QuotaEdge({ w, now, edge, suppressed, accountColorVar }: { w: AccountStatus["quota"]; now: number; edge: "top" | "bottom"; suppressed: boolean; accountColorVar: string }) {
  const kind = edge === "top" ? "session" : "weekly";
  const window = quotaWindow(w, kind);
  const state = suppressed ? "unknown" : quotaWindowState(window, now);
  const edgeClass = edge === "top" ? styles.quotaEdgeTop : styles.quotaEdgeBottom;
  if (state !== "live" || !window) {
    return <span className={`${styles.quotaEdge} ${edgeClass}`} style={{ background: "var(--line-soft)" }} />;
  }
  const fillPct = quotaFillFraction(window) * 100;
  const tone = quotaTone(window, now);
  const toneVar = tone === "success" ? accountColorVar : QUOTA_TONE_VAR[tone];
  const notchPct = Math.min(99, quotaElapsedFraction(window, now) * 100);
  return (
    <>
      <span
        className={`${styles.quotaEdge} ${edgeClass}`}
        style={{ background: `linear-gradient(to right, var(${toneVar}) 0%, var(${toneVar}) ${fillPct}%, var(--line-soft) ${fillPct}%, var(--line-soft) 100%)` }}
      />
      <span className={`${styles.quotaNotch} ${edgeClass}`} style={{ left: `${notchPct}%` }} />
    </>
  );
}

/** W6: a COOLING account renders warn-tinted with its remaining m:ss ticking
 * (coverage B1: "cooling'de ad sarı + süre"); click opens the AccountsCard.
 * ACCOUNT-QUOTA-METERS: each account is its own inline-block box, framed by its
 * OWN quota state — top border = session (5h), bottom border = weekly (see
 * quotaChipTitle's hover text for the explicit legend). Cooling wins over quota
 * (design decision): a cooling account is the harder state — out right now, not
 * just trending toward a limit — so its box's borders render as a flat neutral
 * track (QuotaEdge's `suppressed` prop) instead of competing tone colors; the
 * quota NUMBERS still appear in the title, only the border's own color signal
 * is suppressed. */
export function AccountsChip() {
  const accounts = useStore((s: UiState) => s.accounts);
  const anyCooling = accounts.some((a) => a.cooling && a.coolingUntil !== null);
  const anyQuota = accounts.some((a) => (a.quota?.windows.length ?? 0) > 0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyCooling && !anyQuota) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(id);
  }, [anyCooling, anyQuota]);
  if (accounts.length === 0) return null;
  return (
    <button type="button" className={styles.chipClick} onClick={openAccounts} aria-label="Accounts and peers" data-accounts-chip>
      {accounts.map((a, i) => {
        // identity color: "main"/first → success, else hash slot --acct-1..6 — the SAME
        // color the quota edges' fill uses (see QuotaEdge) so the bar reads as "this
        // account's meter", not a detached traffic light.
        const acctColorVar = i === 0 && !accounts.some((x) => x.name === "main") ? "--success" : accountToneVar(a.name);
        return (
          <span key={a.name}>
            {i > 0 && <span className={styles.dim}> · </span>}
            <span className={styles.acctBox} title={quotaChipTitle(a.quota, now)} data-account-box={a.name}>
              <QuotaEdge w={a.quota} now={now} edge="top" suppressed={a.cooling} accountColorVar={acctColorVar} />
              {a.cooling ? (
                <span className={styles.cooling}>
                  ▪ {a.name}
                  {a.coolingUntil !== null ? ` ${coolingMSS(a.coolingUntil, now)}` : ""}
                </span>
              ) : (
                <span style={{ color: `var(${acctColorVar})` }}>
                  ▪ {a.name}
                </span>
              )}
              <span className={styles.dim}>:{a.provider}</span>
              <QuotaEdge w={a.quota} now={now} edge="bottom" suppressed={a.cooling} accountColorVar={acctColorVar} />
            </span>
          </span>
        );
      })}
    </button>
  );
}

/** W6 (B1): real daemon spend when the daemon serves it — spendTodayUsd /
 * dailyCapUsd off the 5s status poll (systemLocal) — falling back to the
 * Σ costUsd session total against the mock's $10 cap. Meter threshold colors
 * green → warn@70% → danger@90% (commands.system.ts spendTone); click opens
 * the usage & cost card (W21/F19) — that card computes its own "today" figure
 * from the SAME spendToday/cap expression, so the two numbers never drift. */
export function SpendChip() {
  const sessionSpend = useStore(totalSpendUsd);
  const spendToday = useSystemLocal((s) => s.spendTodayUsd);
  const dailyCap = useSystemLocal((s) => s.dailyCapUsd);
  const spend = spendToday ?? sessionSpend;
  const cap = dailyCap ?? 10;
  const meter = spendMeter(spend, cap);
  const tone = spendTone(spend, cap);
  const toneClass = tone === "danger" ? styles.meterDanger : tone === "warn" ? styles.meterWarn : styles.meterFill;
  const title = spendToday !== null
    ? `daily spend / cap — daemon ledger${dailyCap !== null ? "" : " (no configured cap; $10 default meter)"}`
    : "session total costUsd / cap (daemon spend ledger unavailable)";
  return (
    <button type="button" aria-label="Usage and cost" className={styles.chipClick} title={title} onClick={openUsage} data-spend-chip>
      <span className={toneClass === styles.meterFill ? styles.spend : toneClass}>{fmtCost(spend)}</span>
      <span className={styles.dim}>/{Number.isInteger(cap) ? cap : cap.toFixed(2)} </span>
      <span className={toneClass}>{meter.fill}</span>
      <span className={styles.meterEmpty}>{meter.empty}</span>
    </button>
  );
}
