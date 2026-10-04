import { createContext, type ReactNode, useContext, useEffect, useId, useRef } from "react";
import styles from "./OverlayCard.module.css";

// Multiple existing callers render a ConfirmCard inside a form OverlayCard.
// Only the topmost dialog owns Escape; a module-local DOM stack works across
// React roots and body portals without coupling the shell to callers.
const overlayStack: Array<{ element: HTMLElement; id: string; ancestors: string[] }> = [];
const OverlayContext = createContext({ titleId: undefined as string | undefined, ancestors: [] as string[] });

// The ONE overlay shell every card mounts through (PLAN §0.5 + §8): a scrim
// confined to the RIGHT content column (the host pane must be position:
// relative — AgentsScreen's right column / a screen's detail pane), with the
// card floating per the mock's geometry. The top bar and left rail are never
// covered because the scrim never escapes the host pane. esc closes (capture
// phase, before the root hotkey handler sees it); the opener key re-toggles
// at the opener's own call site (the TUI's toggle convention).
export type OverlayAlign = "center" | "bottom" | "top";

export function OverlayCard(props: {
  width: number;              // card width from the mock (640/680/560/620/700/760…)
  align?: OverlayAlign;       // mock: decision cards sit "bottom", forms "center", palettes "top"
  edge?: string;              // border-color token VALUE, e.g. "var(--edge-permission)"; default --line-strong
  onClose?: () => void;       // esc handler (also used by scrim click)
  children: ReactNode;
  /** Scrim reaches the pane bottom by default; the agents screen passes the
   * composer-strip height so decision cards float above it (mock: bottom:48px). */
  bottomInset?: number;
  /** Return true to let a CARD-LOCAL Escape consumer own this keypress instead of
   * closing the card — e.g. an open `[[` autocomplete popup that should dismiss on
   * Escape without tearing down the whole card. When it returns true, this shell
   * neither closes nor stops propagation, so the event flows on to the card's own
   * React keydown handler. Default (undefined) keeps the original close-on-Escape. */
  escGuard?: () => boolean;
  /** Override the accessible name supplied by the nearest OverlayCardHeader. */
  ariaLabel?: string;
}) {
  const parent = useContext(OverlayContext);
  const titleId = useId();
  const ancestors = parent.titleId ? [...parent.ancestors, parent.titleId] : [];
  const cardRef = useRef<HTMLDivElement | null>(null);
  // React applies a descendant's autoFocus during commit, before effects run.
  // Capture the invoker during the first render so autofocus cannot overwrite
  // the element that should receive focus when this card closes.
  const openerRef = useRef<{ captured: boolean; element: HTMLElement | null }>({ captured: false, element: null });
  if (!openerRef.current.captured) {
    openerRef.current = {
      captured: true,
      element: typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
  }
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  // Read the guard through a ref so the window listener (subscribed once per
  // mount) always sees the CURRENT popup state without re-subscribing per render.
  const escGuardRef = useRef(props.escGuard);
  escGuardRef.current = props.escGuard;
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const hasDocument = typeof document !== "undefined";
    const previousFocus = openerRef.current.element;
    const cardAtMount = cardRef.current;
    let mounted = true;
    if (hasDocument && cardAtMount) {
      // Descendant effects run before parents, including across React portals.
      // Keep that logical nesting order instead of trusting effect registration.
      const index = overlayStack.findIndex((entry) => entry.ancestors.includes(titleId));
      overlayStack.splice(index < 0 ? overlayStack.length : index, 0, { element: cardAtMount, id: titleId, ancestors });
    }
    const isRenderedFocusTarget = (el: HTMLElement): boolean => {
      if (!el.isConnected || el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") return false;
      if (el.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    };
    const focusable = (): HTMLElement[] => {
      const card = cardRef.current;
      if (!card) return [];
      return Array.from(card.querySelectorAll<HTMLElement>(
        'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])',
      )).filter((el) => el.tabIndex >= 0 && isRenderedFocusTarget(el));
    };
    // Child cards that own a deliberate initial focus (forms/palettes) win. A
    // passive card starts inside the dialog, but focus is deliberately NOT
    // trapped: PLAN-TAURI §0.5 keeps the top bar and left rail operable.
    if (hasDocument) queueMicrotask(() => {
      const card = cardRef.current;
      if (!mounted || !card || !card.isConnected || overlayStack[overlayStack.length - 1]?.element !== card) return;
      const active = document.activeElement;
      if (card.contains(active) || (active !== previousFocus && active !== document.body && active !== null)) return;
      (focusable()[0] ?? card).focus();
    });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented) return;
      const card = cardRef.current;
      if (hasDocument && card && overlayStack[overlayStack.length - 1]?.element !== card) return;
      // A caller-owned dialog may be portaled to body (for example an
      // expanded diagram). It owns its own keyboard scope while focused.
      const active = hasDocument && document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeDialog = active?.closest<HTMLElement>('[role="dialog"]') ?? null;
      if (card && activeDialog && activeDialog !== card && !card.contains(activeDialog)) return;
      if (ev.key === "Escape") {
        if (!onCloseRef.current || escGuardRef.current?.()) return; // a card-local consumer owns this Escape
        ev.stopPropagation();
        ev.preventDefault();
        onCloseRef.current?.();
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      mounted = false;
      window.removeEventListener("keydown", onKey, { capture: true });
      if (cardAtMount) {
        const index = overlayStack.findIndex((entry) => entry.element === cardAtMount);
        if (index >= 0) overlayStack.splice(index, 1);
      }
      if (hasDocument) queueMicrotask(() => {
        if (cardAtMount?.isConnected) return; // StrictMode effect replay is not a close.
        const activeAfterClose = document.activeElement;
        const top = overlayStack[overlayStack.length - 1]?.element;
        const focusWasAbandoned = activeAfterClose === document.body
          || activeAfterClose === null
          || !(activeAfterClose instanceof HTMLElement)
          || !activeAfterClose.isConnected
          || !!cardAtMount?.contains(activeAfterClose);
        if (
          previousFocus
          && isRenderedFocusTarget(previousFocus)
          && (!top || top.contains(previousFocus))
          && focusWasAbandoned
        ) previousFocus.focus({ preventScroll: true });
      });
    };
  }, []);

  const alignClass =
    props.align === "bottom" ? styles.alignBottom : props.align === "top" ? styles.alignTop : styles.alignCenter;
  return (
    <OverlayContext.Provider value={{ titleId, ancestors }}>
      <div
        className={`${styles.scrim} ${alignClass}`}
        style={{ bottom: props.bottomInset ?? 0 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) props.onClose?.();
        }}
      >
        <div
          ref={cardRef}
          className={styles.card}
          style={{ width: props.width, borderColor: props.edge ?? "var(--line-strong)" }}
          role="dialog"
          aria-label={props.ariaLabel}
          aria-labelledby={props.ariaLabel ? undefined : titleId}
          tabIndex={-1}
        >
          {props.children}
        </div>
      </div>
    </OverlayContext.Provider>
  );
}

/** The card header strip every mock card shares: title (+meta), right hint. */
export function OverlayCardHeader(props: { title: ReactNode; meta?: ReactNode; hint?: ReactNode; titleColor?: string }) {
  const { titleId } = useContext(OverlayContext);
  return (
    <div className={styles.header}>
      <span id={titleId} className={styles.title} style={props.titleColor ? { color: props.titleColor } : undefined}>
        {props.title}
      </span>
      {props.meta !== undefined && <span className={styles.meta}>{props.meta}</span>}
      <span className={styles.spacer} />
      {props.hint !== undefined && <span className={styles.hint}>{props.hint}</span>}
    </div>
  );
}
