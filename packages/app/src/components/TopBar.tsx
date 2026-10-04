import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { attentionInbox, isOnboardingGated, type TabId, type UiState } from "@chimera/ui-state";
import { appStore } from "../state/store";
import { useStore } from "../state/useStore";
import { registerActionHandler } from "../keymap";
import { APP_TABS, type AppTab } from "../keymap/rows.tabs";
import { unseenTotal } from "../state/selectors.projects";
import { splitTabs, type TabSplit } from "../state/selectors.tabs";
import { AccountsChip, ConnChip, PeerChips, SpendChip } from "./TopBarChips";
import styles from "./TopBar.module.css";

// TOPBAR-OVERFLOW — the tab strip's per-tab widths are measured off a hidden
// shadow copy (position:absolute, visibility:hidden) rather than the live
// nav: once a slot collapses into the overflow list it un-mounts from the
// live nav and would stop being measurable, breaking the "widening restores
// tabs" continuity. The shadow copy always renders all nine slots so their
// natural widths stay available every recompute. .bar's own 28px gap (×2, one
// each side of .tabs) and .tabs's own 22px inter-tab gap aren't captured by
// getBoundingClientRect, so both are folded in as constants below — an
// intentional slight overcount that only costs a little slack, never causes
// an underfit.
const BAR_GAP = 28;
const BAR_PADDING_X = 16;
const TAB_GAP = 22;
const OVERFLOW_CONTROL_WIDTH = 32 + TAB_GAP; // must match .overflowBtn's CSS width

const ALL_VISIBLE: TabSplit = { visible: APP_TABS.map((_, i) => i), hidden: [] };

/** A ref's measured width, or null when the node exposes no layout API at all.
 * A ref is not guaranteed to be a laid-out DOM element — a non-DOM renderer
 * (or any host that hands back a bare object) has no getBoundingClientRect,
 * and calling it there threw out of a layout effect and took the whole shell
 * down. Measurement is best-effort: no numbers ⇒ degrade to "everything
 * visible", never crash. */
function measuredWidth(el: { getBoundingClientRect?: () => { width: number } } | null): number | null {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  const width = el.getBoundingClientRect().width;
  return typeof width === "number" && Number.isFinite(width) ? width : null;
}

function tabClassName(slot: AppTab, activeTab: TabId, locked: boolean): string {
  return slot.tab === null || locked ? styles.tabInert : slot.tab === activeTab ? styles.tabActive : styles.tab;
}

function TabBadges({ slot, badge, inboxBlocking }: { slot: AppTab; badge: number; inboxBlocking: number }) {
  if (slot.tab === "events" && badge > 0) return <span className={styles.badge} data-events-badge>{badge}</span>;
  if (slot.tab === "inbox" && inboxBlocking > 0) return <span className={styles.badge} data-inbox-badge>{inboxBlocking}</span>;
  return null;
}

// W0 static → W3 live → W5 six slots → W7 all six LIVE: tabs render from
// APP_TABS (rows.tabs.ts, mock lines 24-35). A slot's click dispatches the
// same selectTab its number chord does; the events tab wears the UNSEEN badge
// (coverage B1 row 3: derived unseen permission+question+error count, folded
// by ui-state while the events tab is off-screen and reset by landing on it).
// Status chips live in TopBarChips.tsx (their own owner — see the note there).

/** The mock-order six-slot cycle (agents → projects → teams → …). Registered
 * over tab.next/tab.prev because the built-in dispatch cycles ui-state's
 * TAB_ORDER — the TUI's locked FIVE-tab surface, which "projects" must never
 * join. Dispatching selectTab (not tabNext) also keeps the unseen-badge
 * landed-on-events reset on one reducer path. Exported for tests. */
export function cycleTab(active: UiState["activeTab"], dir: 1 | -1): UiState["activeTab"] {
  const order = APP_TABS.filter((t) => t.tab !== null).map((t) => t.tab!);
  const i = order.indexOf(active);
  return order[((i < 0 ? 0 : i) + dir + order.length) % order.length]!;
}

export function TopBar() {
  const activeTab = useStore((s: UiState) => s.activeTab);
  const unseen = useStore((s: UiState) => s.unseen);
  // B1 row 1 (final-acceptance fix): the version tag is the daemon's
  // protocolVersion (daemon.status → ui-state), HIDDEN until the first status
  // lands — "sabit marka + daemon.status→protocolVersion (yoksa gizli)".
  const protocolVersion = useStore((s: UiState) => s.protocolVersion);
  const badge = unseenTotal(unseen);
  // FEATURE-9: only the "blocking" tier badges the tab — the same "count what's
  // actually actionable, not a raw total" intent as the events-tab badge above
  // (a failed/blocked task is FYI-tier, not a reason to redden the tab).
  const inboxBlocking = useStore((s: UiState) => attentionInbox(s).filter((i) => i.urgency === "blocking").length);
  // ONBOARDING-GATE R2: zero CONFIRMED accounts — every slot but "agents" is
  // locked (visible, dimmed, inert) until the first provider lands.
  const gated = useStore((s: UiState) => isOnboardingGated(s));

  // TOPBAR-OVERFLOW: which slots fit the strip right now, computed off real
  // measurements (see the module doc comment). Defaults to "everything
  // visible" — the correct degrade when ResizeObserver is unavailable (an
  // old webview, or a non-DOM test render).
  const [split, setSplit] = useState<TabSplit>(ALL_VISIBLE);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);
  const brandRef = useRef<HTMLDivElement | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const measureRefs = useRef<Array<HTMLDivElement | null>>([]);
  const overflowBtnRef = useRef<HTMLButtonElement | null>(null);
  const overflowPopupRef = useRef<HTMLDivElement | null>(null);
  const activeIndex = APP_TABS.findIndex((t) => t.tab === activeTab);

  useLayoutEffect(() => {
    if (typeof window === "undefined" || typeof ResizeObserver === "undefined") return undefined;
    const recompute = (): void => {
      const barW = measuredWidth(barRef.current);
      const brandW = measuredWidth(brandRef.current);
      const chipsW = measuredWidth(chipsRef.current);
      if (barW === null || brandW === null || chipsW === null) return void setSplit(ALL_VISIBLE);
      const available = barW <= 760
        ? barW - 2 * BAR_PADDING_X
        : barW - 2 * BAR_PADDING_X - brandW - chipsW - 2 * BAR_GAP;
      const widths = APP_TABS.map((_, i) => measuredWidth(measureRefs.current[i]));
      // An unmeasurable slot is not a zero-width slot: treating it as 0 would
      // claim it always fits and silently overfill the strip, so one missing
      // number degrades the whole recompute to "everything visible".
      if (widths.some((w) => w === null)) return void setSplit(ALL_VISIBLE);
      setSplit(splitTabs(available, widths.map((w) => w! + TAB_GAP), activeIndex, OVERFLOW_CONTROL_WIDTH));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    // Same best-effort contract as the measurement above: a host that gave us
    // something ResizeObserver won't accept costs us live resizes, not the shell.
    for (const el of [barRef.current, brandRef.current, chipsRef.current]) {
      if (!el) continue;
      try { ro.observe(el); } catch { /* not an observable element on this host */ }
    }
    return () => ro.disconnect();
  }, [activeIndex, badge, inboxBlocking, gated, protocolVersion]);

  // Close the popup once it has nothing left to show (e.g. the window widened
  // and every slot now fits in the live strip).
  useEffect(() => {
    if (split.hidden.length === 0) setOverflowOpen(false);
  }, [split.hidden.length]);

  // Dismiss on outside click or Escape. The keydown listener runs
  // capture-phase to match OverlayCard's own established pattern (MEM-5: the
  // app shell's capture-phase Escape handling beats a bubble-phase React
  // handler, so a popup that wants to own Escape has to get there first too).
  useEffect(() => {
    if (!overflowOpen) return undefined;
    if (typeof document === "undefined" || typeof window === "undefined") return undefined;
    const onDown = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (overflowPopupRef.current?.contains(target)) return;
      if (overflowBtnRef.current?.contains(target)) return;
      setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOverflowOpen(false);
      overflowBtnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [overflowOpen]);

  // W7: the projects slot + six-slot cycle handlers live HERE (the one
  // always-mounted owner of the strip) — see cycleTab's doc comment.
  useEffect(() => {
    // ONBOARDING-GATE R2: same swallow-except-agents rule dispatchAction's
    // built-in tab.* branch applies — these four slots bypass that branch
    // entirely (registry lookups win over the built-in), so they need their
    // own gate check.
    const gatedDispatch = (tab: UiState["activeTab"]): void => {
      if (isOnboardingGated(appStore.getState())) return;
      appStore.dispatch({ type: "selectTab", tab });
    };
    const offs = [
      registerActionHandler("tab.projects", () => gatedDispatch("projects")),
      // W9: the settings slot rides the same registry path as projects (chord 7
      // + click); it is not in TAB_ORDER, so the built-in dispatch can't reach it.
      registerActionHandler("tab.settings", () => gatedDispatch("settings")),
      // FEATURE-9: the inbox slot rides the same registry path (chord 8 + click).
      registerActionHandler("tab.inbox", () => gatedDispatch("inbox")),
      registerActionHandler("tab.slo", () => gatedDispatch("slo")),
      // ROLES-TAB S5: the tenth slot rides the same registry path (chord 0 + click).
      registerActionHandler("tab.roles", () => gatedDispatch("roles")),
    registerActionHandler("tab.runs", () => gatedDispatch("runs")),
      registerActionHandler("tab.next", () => gatedDispatch(cycleTab(appStore.getState().activeTab, 1))),
      registerActionHandler("tab.prev", () => gatedDispatch(cycleTab(appStore.getState().activeTab, -1))),
    ];
    return () => { for (const off of offs) off(); };
  }, []);

  // TOPBAR-OVERFLOW #5: badge info must survive a collapse — the overflow
  // control itself carries the sum of any hidden badged tab's count.
  const hiddenBadgeTotal = split.hidden.reduce((sum, i) => {
    const tab = APP_TABS[i]!.tab;
    if (tab === "events") return sum + badge;
    if (tab === "inbox") return sum + inboxBlocking;
    return sum;
  }, 0);

  const selectTab = (tab: TabId): void => {
    appStore.dispatch({ type: "selectTab", tab });
    setOverflowOpen(false);
  };

  return (
    <header className={styles.bar} ref={barRef} data-topbar-bar>
      <div className={styles.brand} ref={brandRef} data-topbar-brand>
        <span className={styles.brandMark}>◆ chimera</span>
        {protocolVersion !== null && <span className={styles.brandVersion}>v{protocolVersion}</span>}
      </div>
      <nav className={styles.tabs} data-topbar-nav>
        <div className={styles.tabList}>
          {split.visible.map((i) => {
            const slot = APP_TABS[i]!;
            const locked = gated && slot.tab !== null && slot.tab !== "agents";
            return (
              <button
                type="button"
                key={slot.label}
                className={tabClassName(slot, activeTab, locked)}
                title={locked ? "connect a provider to unlock" : slot.title}
                onClick={slot.tab === null || locked ? undefined : () => selectTab(slot.tab!)}
                disabled={slot.tab === null || locked}
                aria-current={slot.tab === activeTab ? "page" : undefined}
                data-tab-locked={locked ? "" : undefined}
                data-topbar-tab={slot.tab ?? slot.label}
              >
                <span className={styles.tabNumber}>{slot.num} </span>
                {slot.label}
                <TabBadges slot={slot} badge={badge} inboxBlocking={inboxBlocking} />
              </button>
            );
          })}
        </div>
        {split.hidden.length > 0 && (
          <div className={styles.tabWrap}>
            <button
              type="button"
              ref={overflowBtnRef}
              className={styles.overflowBtn}
              title="more tabs"
              onClick={() => setOverflowOpen((v) => !v)}
              aria-label="More navigation tabs"
              aria-expanded={overflowOpen}
              aria-controls="topbar-overflow-menu"
              data-tab-overflow
            >
              »
              {hiddenBadgeTotal > 0 && <span className={styles.overflowBadge} data-tab-overflow-badge>{hiddenBadgeTotal}</span>}
            </button>
            {overflowOpen && (
              <div id="topbar-overflow-menu" className={styles.overflowPopup} ref={overflowPopupRef} data-tab-overflow-popup>
                {split.hidden.map((i) => {
                  const slot = APP_TABS[i]!;
                  const locked = gated && slot.tab !== null && slot.tab !== "agents";
                  return (
                    <button
                      type="button"
                      key={slot.label}
                      className={locked ? styles.overflowRowInert : styles.overflowRow}
                      title={locked ? "connect a provider to unlock" : slot.title}
                      onClick={slot.tab === null || locked ? undefined : () => selectTab(slot.tab!)}
                      disabled={slot.tab === null || locked}
                      aria-current={slot.tab === activeTab ? "page" : undefined}
                      data-tab-locked={locked ? "" : undefined}
                      data-topbar-overflow-tab={slot.tab ?? slot.label}
                    >
                      <span className={styles.tabNumber}>{slot.num} </span>
                      {slot.label}
                      <TabBadges slot={slot} badge={badge} inboxBlocking={inboxBlocking} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </nav>
      <div className={styles.chips} ref={chipsRef} data-topbar-chips>
        <ConnChip />
        <PeerChips />
        <AccountsChip />
        <SpendChip />
      </div>
      {/* Off-screen shadow copy of every slot, used only to measure natural
          per-tab widths (see the module doc comment) — never visible, never
          interactive. */}
      <div className={styles.measure} aria-hidden="true">
        {APP_TABS.map((slot, i) => (
          <div
            key={slot.label}
            ref={(el) => { measureRefs.current[i] = el; }}
            className={styles.tab}
            data-topbar-measure={slot.num}
          >
            <span className={styles.tabNumber}>{slot.num} </span>
            {slot.label}
            <TabBadges slot={slot} badge={badge} inboxBlocking={inboxBlocking} />
          </div>
        ))}
      </div>
    </header>
  );
}
