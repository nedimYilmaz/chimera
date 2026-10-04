import {
  useCallback, useEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type ReactElement, type RefObject,
} from "react";
import {
  clampPaneWidth, paneMinWidth, paneWidth, resetPaneWidth, setPaneWidth, subscribePanes,
  type PaneKey,
} from "../state/panes";
import styles from "./PaneDivider.module.css";

// PANE-RESIZE — the seam between any two panes, on either axis.
//
// It replaces the gaps that used to sit between panels: the panes are flush now and this IS the
// border, drawn heavier than an ordinary panel edge. A gap says "separate cards"; a seam says "two
// halves of one surface, and the split is yours to move".
//
// TWO THINGS VARY, and both matter:
//   axis — "x" resizes a width and drags horizontally; "y" resizes a height and drags vertically.
//   side — WHICH element carries the size. A left rail is sized and sits BEFORE its divider; a
//          composer band or a terminal dock is sized and sits AFTER, growing as you drag toward it.
//          Getting this wrong makes the pane move the opposite way under the pointer, which reads
//          as a broken control rather than an inverted one.
//
// It also comes in two flavours. Store-backed (a `paneKey`) is the default and gets persistence,
// per-pane floors and reset for free. Controlled (`value`/`onChange`) exists for a pane whose size
// already lives somewhere else — the terminal dock keeps its height in ui-state with its own
// persistence, and a second home here would be two sources for one number.

export type PaneAxis = "x" | "y";
export type PaneSide = "before" | "after";

/** The divider's own thickness in px — mirrors the stylesheet. Kept as a constant rather than
 *  measured: reading layout on every pointer move is a reflow per frame. */
const THICKNESS = 7;

/** Read the current size for `key`, and re-render when it changes. */
export function usePaneWidth(key: PaneKey): number {
  return useSyncExternalStore(subscribePanes, () => paneWidth(key), () => paneWidth(key));
}

type Common = {
  axis?: PaneAxis;
  side?: PaneSide;
  /** The element the two panes share — its box is what a drag is measured and clamped against.
   *
   *  OPTIONAL. Without it the divider measures by DELTA instead: the size at grab time plus how far
   *  the pointer has moved. That is the right strategy for a pane anchored to an edge of something
   *  this component cannot see (the terminal dock sits at the bottom of a column owned by another
   *  file) — there is no box to measure against, and inventing one would be worse than not needing
   *  one. The trade is that the clamp has no container to derive its ceiling from, so `maxSize`
   *  supplies it. */
  containerRef?: RefObject<HTMLElement | null>;
  /** Upper bound for delta mode, where there is no container to derive one from. */
  maxSize?: number;
  label?: string;
};

type StoreBacked = Common & {
  paneKey: PaneKey;
  value?: undefined; onChange?: undefined; min?: undefined; onReset?: undefined;
};
type Controlled = Common & {
  paneKey?: undefined;
  value: number;
  onChange: (px: number) => void;
  min?: number;
  /** Double-click restores this pane. Absent ⇒ double-click does nothing, rather than guessing. */
  onReset?: () => void;
};

export function PaneDivider(props: StoreBacked | Controlled): ReactElement {
  const axis: PaneAxis = props.axis ?? "x";
  const side: PaneSide = props.side ?? "before";
  const { containerRef } = props;
  const key = props.paneKey;

  const stored = useSyncExternalStore(
    subscribePanes,
    () => (key ? paneWidth(key) : 0),
    () => (key ? paneWidth(key) : 0),
  );
  const size = key ? stored : props.value;
  const min = key ? paneMinWidth(key) : (props.min ?? 120);
  const onChange = key ? undefined : props.onChange;

  const [dragging, setDragging] = useState(false);
  // The pointer's offset INSIDE the divider at grab time. Without it the pane jumps by up to the
  // divider's own thickness on the first move, which reads as the handle slipping.
  const grabOffset = useRef(0);
  // Delta mode's anchor: where the pointer started and how big the pane was then.
  const grabAnchor = useRef<{ pointer: number; size: number }>({ pointer: 0, size: 0 });

  const commit = useCallback((px: number, containerSize: number) => {
    const next = clampPaneWidth(px, containerSize, min);
    if (key) setPaneWidth(key, next);
    else onChange?.(next);
  }, [key, onChange, min]);

  const apply = useCallback((clientX: number, clientY: number) => {
    const pointerNow = axis === "x" ? clientX : clientY;
    const el = containerRef?.current;
    if (!el) {
      // DELTA MODE. "after" means the pane grows as the pointer moves toward its edge, i.e. the
      // opposite direction — dragging the dock's seam UP makes the dock taller.
      const moved = pointerNow - grabAnchor.current.pointer;
      const proposed = grabAnchor.current.size + (side === "before" ? moved : -moved);
      commit(proposed, props.maxSize ?? Number.MAX_SAFE_INTEGER);
      return;
    }
    const rect = el.getBoundingClientRect();
    const pointer = axis === "x" ? clientX : clientY;
    const start = axis === "x" ? rect.left : rect.top;
    const end = axis === "x" ? rect.right : rect.bottom;
    const extent = axis === "x" ? rect.width : rect.height;
    // "before": the sized pane runs from the container's start to the divider.
    // "after":  it runs from the divider to the container's end — mirrored arithmetic, and a
    //           mirrored grab offset, because the pointer now sits at the sized pane's LEADING edge.
    const proposed = side === "before"
      ? pointer - start - grabOffset.current
      : end - pointer - (THICKNESS - grabOffset.current);
    commit(proposed, extent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, axis, side, commit, props.maxSize]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent): void => { e.preventDefault(); apply(e.clientX, e.clientY); };
    const stop = (): void => setDragging(false);
    // Listened on the WINDOW, not the divider. A fast drag outpaces a 7px element, and binding to
    // the element alone drops the pointer the moment it leaves — the classic "resize stops
    // halfway" bug, which is exactly the shape the terminal dock's own handle had before this.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging, apply, axis]);

  const reset = (): void => {
    if (key) resetPaneWidth(key);
    else props.onReset?.();
  };

  const nudge = (delta: number): void => {
    const el = containerRef?.current;
    const extent = el ? (axis === "x" ? el.clientWidth : el.clientHeight)
      : (props.maxSize ?? Number.MAX_SAFE_INTEGER);
    commit(size + delta, extent);
  };

  const cls = [
    styles.divider,
    axis === "x" ? styles.vertical : styles.horizontal,
    dragging ? styles.dragging : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={cls}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={props.label ?? (axis === "x" ? "resize panes" : "resize pane height")}
      aria-valuenow={size}
      tabIndex={0}
      data-pane-divider={key ?? "controlled"}
      data-pane-axis={axis}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        grabOffset.current = axis === "x" ? e.clientX - r.left : e.clientY - r.top;
        grabAnchor.current = { pointer: axis === "x" ? e.clientX : e.clientY, size };
        setDragging(true);
      }}
      // Double-click restores this pane, the way a window edge does. The global reset lives in
      // settings; this is the local, no-hunting-required version.
      onDoubleClick={reset}
      onKeyDown={(e) => {
        // The divider is focusable, so it has to do something when focused. The arrow that GROWS
        // the sized pane depends on which side of the seam it is on — the keys follow the pointer.
        const step = e.shiftKey ? 40 : 8;
        const growKey = axis === "x"
          ? (side === "before" ? "ArrowRight" : "ArrowLeft")
          : (side === "before" ? "ArrowDown" : "ArrowUp");
        const shrinkKey = axis === "x"
          ? (side === "before" ? "ArrowLeft" : "ArrowRight")
          : (side === "before" ? "ArrowUp" : "ArrowDown");
        if (e.key === growKey) { e.preventDefault(); nudge(step); }
        else if (e.key === shrinkKey) { e.preventDefault(); nudge(-step); }
      }}
    >
      <span className={styles.grip} aria-hidden />
    </div>
  );
}

/** Everything a screen needs to make its VERTICAL split resizable, in one call.
 *
 *  The size rides as a CUSTOM PROPERTY on the container, so it INHERITS: the pane's own stylesheet
 *  keeps owning the rule and its default. An inline width would beat every stylesheet forever and
 *  move the layout decision out of CSS. */
export function usePaneRow(paneKey: PaneKey, opts?: {
  /** The custom property the sized pane's stylesheet reads. Defaults to `--pane-w`; a row with
   *  MORE THAN ONE split needs a distinct name per seam (memory has a rail, a list and a detail),
   *  and naming them is clearer than indexing them. */
  cssVar?: string;
  /** Share one row element across several splits — pass the same ref to each. */
  ref?: RefObject<HTMLDivElement | null>;
}): {
  rowProps: { ref: RefObject<HTMLDivElement | null>; style: CSSProperties };
  divider: ReactElement;
} {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const ref = opts?.ref ?? ownRef;
  const width = usePaneWidth(paneKey);
  return {
    rowProps: { ref, style: { [opts?.cssVar ?? "--pane-w"]: `${width}px` } as CSSProperties },
    divider: <PaneDivider paneKey={paneKey} containerRef={ref} />,
  };
}

/** The horizontal counterpart: a column whose BOTTOM child carries the size (a composer band, a
 *  dock). Exposes `--pane-h` for that child's stylesheet to read. */
export function usePaneColumn(paneKey: PaneKey): {
  columnProps: { ref: RefObject<HTMLDivElement | null>; style: CSSProperties };
  divider: ReactElement;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const height = usePaneWidth(paneKey);
  return {
    columnProps: { ref, style: { "--pane-h": `${height}px` } as CSSProperties },
    divider: <PaneDivider paneKey={paneKey} containerRef={ref} axis="y" side="after" />,
  };
}
