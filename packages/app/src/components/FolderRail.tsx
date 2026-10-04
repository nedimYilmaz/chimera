import { useMemo, useState } from "react";
import type { MemoryFolderSel } from "@chimera/ui-state";
import { onRowKeyDown } from "../a11y";
import { visibleFolderNodes, type MemoryFolderNode } from "../state/selectors.coord";
import styles from "./FolderRail.module.css";

// MEM-5 (PLAN-MEMORY.md §8) — the Memory tab's folder rail. Virtual "all" +
// "unfiled" entries, then the folder tree derived from memory.stats.byFolder
// (buildFolderTree, roll-up counts). Clicking an entry sets the folder
// selection, which the screen composes into memory.search (all → no filter;
// unfiled → null-folder post-filter; folder → inclusive prefix). Collapsible:
// a ▸/▾ toggle on any node with children hides/shows its subtree (rail-local
// state — the selection persists in ui-state, the fold is pure presentation).

function sameSel(a: MemoryFolderSel, b: MemoryFolderSel): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "folder" && b.kind === "folder" ? a.path === b.path : true;
}

export function FolderRail({ tree, total, unfiled, selected, onSelect }: {
  tree: MemoryFolderNode[];
  total: number;
  unfiled: number;
  selected: MemoryFolderSel;
  onSelect: (sel: MemoryFolderSel) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const visible = useMemo(() => visibleFolderNodes(tree, collapsed), [tree, collapsed]);

  const toggleFold = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  const entry = (key: string, sel: MemoryFolderSel, label: string, count: number, depth: number, foldable: boolean) => {
    const on = sameSel(selected, sel);
    return (
      <div
        key={key}
        className={on ? styles.entrySelected : styles.entry}
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        onClick={() => onSelect(sel)}
        onKeyDown={onRowKeyDown(() => onSelect(sel))}
        role="button"
        tabIndex={0}
        data-folder-entry={key}
      >
        {foldable ? (
          <span
            className={styles.caret}
            role="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); toggleFold(sel.kind === "folder" ? sel.path : ""); }}
            data-folder-fold={sel.kind === "folder" ? sel.path : ""}
          >
            {collapsed.has(sel.kind === "folder" ? sel.path : "") ? "▸" : "▾"}
          </span>
        ) : (
          <span className={styles.caretSpacer} />
        )}
        <span className={styles.name}>{label}</span>
        <span className={styles.count}>{count}</span>
      </div>
    );
  };

  return (
    <div className={styles.rail} data-memory-folder-rail>
      {entry("all", { kind: "all" }, "all", total, 0, false)}
      {entry("unfiled", { kind: "unfiled" }, "unfiled", unfiled, 0, false)}
      {visible.map((n) => entry(`f:${n.path}`, { kind: "folder", path: n.path }, n.name, n.count, n.depth, n.hasChildren))}
    </div>
  );
}
