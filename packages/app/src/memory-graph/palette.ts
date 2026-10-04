// MEM-6 §5.2 — token→color resolution for the canvas renderer.
// Canvas 2D can't consume CSS `var()`, so we read the computed token values
// ONCE at mount via getComputedStyle and cache them. This keeps the token-only
// styling rule intact: NO literal hex lives in this component — every color is
// a CSS custom property resolved at runtime. `resolvePalette` takes an injected
// reader so it's unit-testable without a DOM.
import type { MemoryKind } from "@chimera/protocol";
import type { ColorMode, GraphPalette, SimNode } from "./types";

// kind → CSS token (the existing accent/semantic family, chosen against
// tokens.css §"accent + semantics"): decisions ride the lavender accent, facts
// are the success green, todos the warn amber, questions the human magenta,
// plain notes the muted grey. This is the one place the mapping is declared.
export const KIND_TOKEN: Record<MemoryKind, string> = {
  decision: "--accent",
  fact: "--success",
  todo: "--warn",
  question: "--human",
  note: "--muted",
};

// Folder-tint rotation for the "tint by folder" toggle — reuses the semantic
// token family (no new hues invented) so the cockpit palette stays coherent.
const FOLDER_TINT_TOKENS = ["--accent", "--success", "--warn", "--human", "--danger"];

export type CssVarReader = (name: string) => string;

/** Read a var, trimming; fall back to `fallback` when the reader returns "" (a
 *  detached node / missing token) so a color string is always non-empty. */
function readVar(read: CssVarReader, name: string, fallback: string): string {
  const v = read(name).trim();
  return v.length > 0 ? v : fallback;
}

// Fallbacks are CSS *named* colors (never literal hex — the token-only copy
// guard bans hex even as a fallback string). They are effectively dead in the
// real app: getComputedStyle always resolves the :root tokens; the fallback
// only fires for a detached node (tests) so a color string is always non-empty.
const FALLBACK_TINTS = ["mediumpurple", "mediumseagreen", "goldenrod", "orchid", "tomato"];

/** Resolve the whole graph palette from CSS tokens via an injected reader
 *  (production passes `n => getComputedStyle(el).getPropertyValue(n)`). */
export function resolvePalette(read: CssVarReader): GraphPalette {
  const kindColor = (k: MemoryKind, fb: string): string => readVar(read, KIND_TOKEN[k], fb);
  return {
    bg: readVar(read, "--bg", "black"),
    fg: readVar(read, "--fg", "gainsboro"),
    muted: readVar(read, "--muted", "gray"),
    line: readVar(read, "--line", "dimgray"),
    byKind: {
      decision: kindColor("decision", "mediumpurple"),
      fact: kindColor("fact", "mediumseagreen"),
      todo: kindColor("todo", "goldenrod"),
      question: kindColor("question", "orchid"),
      note: kindColor("note", "gray"),
    },
    ghost: readVar(read, "--muted", "gray"),
    folderTints: FOLDER_TINT_TOKENS.map((t, i) => readVar(read, t, FALLBACK_TINTS[i])),
  };
}

/** Deterministic folder→tint index (stable hash) so the same folder always
 *  gets the same color across renders. Unfiled (null) rides the muted grey. */
export function folderTintIndex(folder: string | null, tintCount: number): number {
  if (folder === null || tintCount === 0) return -1; // -1 ⇒ use muted (unfiled)
  let h = 0;
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) | 0;
  return Math.abs(h) % tintCount;
}

/** The color a node draws with under the current color mode. Ghost nodes always
 *  use the ghost/muted stroke color regardless of mode. */
export function nodeColor(node: SimNode, palette: GraphPalette, mode: ColorMode): string {
  if (node.ghost) return palette.ghost;
  if (mode === "folder") {
    const idx = folderTintIndex(node.folder, palette.folderTints.length);
    return idx < 0 ? palette.muted : palette.folderTints[idx];
  }
  return node.kind === null ? palette.muted : palette.byKind[node.kind];
}

/** Assign the resolved color onto every node once (called at setData / mode or
 *  palette change) so the draw loop is a pure read. */
export function applyNodeColors(nodes: SimNode[], palette: GraphPalette, mode: ColorMode): void {
  for (const n of nodes) n.color = nodeColor(n, palette, mode);
}
