import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentView } from "@chimera/ui-state";
import { displayChord, registerActionHandler } from "../keymap";
import { displayName, flattenFlow, flowIcon, flowMeta, flowStatusVisual } from "../state/selectors";
import { Panel, PanelFooter } from "./Panel";
import styles from "./FlowPane.module.css";

// W3 — the left-pane alternate (mod+r): the selected agent's flowTree as the
// mock's tree lines. Node cursor + fold state are LOCAL (view state, not a
// projection); while mounted this pane claims the agents-scope movement/fold
// actions from the keymap registry, so the same chords drive whichever left
// pane is showing (PLAN §4: one keymap table).

const toneClass: Record<string, string> = {
  success: styles.toneSuccess!,
  warn: styles.toneWarn!,
  danger: styles.toneDanger!,
};

export function FlowPane({ agent }: { agent: AgentView | undefined }) {
  const [cursor, setCursor] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = agent?.flowTree ?? [];
  const rows = useMemo(() => flattenFlow(tree, collapsed), [tree, collapsed]);

  // Reset local view state when the selected agent changes.
  const agentKey = agent?.agentId ?? "";
  useEffect(() => {
    setCursor(0);
    setCollapsed(new Set());
  }, [agentKey]);

  // [FLOW-VIEW-SCROLL] The row list is the scroll container (.body:
  // overflow-y:auto) so a long flow overflows/clips — the mouse wheel scrolls
  // it, but ↑↓ node movement changed only the `.selected` class and left the
  // viewport put, so the cursor could walk off-screen. Keep the selected row in
  // view on every cursor move (and on the reset-to-0 agent switch), the same
  // block:"nearest" idiom HostToolsCard's row list uses — nearest never scrolls
  // when the row is already visible, so ordinary in-window steps don't jump.
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows.length]);

  useEffect(() => {
    const move = (delta: number) => () =>
      setCursor((c) => Math.min(Math.max(0, rows.length - 1), Math.max(0, c + delta)));
    const fold = (open: boolean) => () => {
      const row = rows[cursor];
      if (!row || !row.hasChildren) return;
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (open) next.delete(row.node.id);
        else next.add(row.node.id);
        return next;
      });
    };
    const offs = [
      registerActionHandler("agents.up", move(-1)),
      registerActionHandler("agents.down", move(1)),
      registerActionHandler("agents.foldLeft", fold(false)),
      registerActionHandler("agents.foldRight", fold(true)),
    ];
    return () => offs.forEach((off) => off());
  }, [rows, cursor]);

  return (
    <Panel
      label={
        <>
          flow{agent ? <span className={styles.faint}> · {displayName(agent)}</span> : null}
        </>
      }
      className={styles.pane}
    >
      <div className={styles.body}>
        {rows.length === 0 ? (
          <div className={styles.empty}>no flow yet</div>
        ) : (
          rows.map((row, i) => {
            const status = flowStatusVisual(row.node.status);
            const meta = flowMeta(row.node);
            const pending = row.node.status === "pending";
            const selected = i === cursor;
            const rowCls = [
              row.depth === 0 ? styles.rowRoot : pending ? styles.rowPending : styles.row,
              selected ? styles.selected : "",
            ].filter(Boolean).join(" ");
            return (
              <div
                key={`${row.node.id}:${i}`}
                ref={selected ? selectedRowRef : undefined}
                className={rowCls}
                onClick={() => setCursor(i)}
              >
                {row.depth > 0 ? <span className={styles.tree}>{row.isLast ? "└" : "├"}</span> : null}
                {row.depth > 0 ? " " : ""}
                <span className={row.depth === 0 ? styles.rootIcon : undefined}>{flowIcon(row.node, row.depth)}</span>{" "}
                {row.hasChildren && row.collapsed ? <span className={styles.faint}>▸ </span> : null}
                {row.node.label}
                {status && row.depth > 0 ? (
                  <span className={`${toneClass[status.tone] ?? ""}${status.pulse ? ` ${styles.pulse}` : ""}`}> {status.glyph}</span>
                ) : null}
                {meta ? (
                  <span className={row.depth === 0 ? styles.rootMeta : pending ? styles.ghost : styles.faint}> {meta}</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
      {/* Review finding 12: the mock's "enter jump to turn" hint is DROPPED —
          the TUI's FlowPane implements no enter-jump (its footer reads
          "↑↓ node · →/← expand · mod+r list · esc") and shipping a dead
          affordance is worse than omitting the mock line item. If enter-jump
          ever lands in the TUI, port the handler and restore the hint. */}
      <PanelFooter>↑↓ node · ←→ fold · {displayChord("mod+r")} list</PanelFooter>
    </Panel>
  );
}
