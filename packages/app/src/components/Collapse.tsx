import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./Collapse.module.css";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Shared open/close animation for every "toggle a list item's detail" spot
 * (F-TOGGLE-ANIM): master-detail panes, inline per-row inspectors, role-
 * instruction blocks. `children` is only read WHILE `open` is true — the
 * caller is free to pass `null`/`undefined` once it flips `open` to false
 * (the common `selected ? <X/> : null` shape), because Collapse caches the
 * last non-closing children itself so the exit transition has something to
 * animate instead of collapsing an already-blank box. Unmounts for real once
 * the close transition ends (or immediately under prefers-reduced-motion,
 * which never fires a transitionend for a `transition: none` element).
 *
 * `fill`: for the handful of call sites where Collapse wraps a WHOLE
 * detail pane that itself contains a "fixed header + flex:1 scrollable
 * body" (QueuesScreen/TeamsScreen/ProjectsScreen/MemoryScreen's
 * .tasksBody/.agentsBody/.sessBody pattern) — without it the grid's 1fr
 * track sizes to the content's full max-content height instead of the
 * Panel's actual available height, so the inner flex:1 scroll body never
 * gets a bounded height to scroll within. Leave it off for content that's
 * already self-bounded (AgentDetailPanel/AgentInspector's own max-height,
 * .rolePrompt's own max-height) or that should just size to its content
 * (role-instruction blocks, TranscriptPanel's agent-info panel). */
export function Collapse({ open, children, className, fill }: { open: boolean; children?: ReactNode; className?: string; fill?: boolean }) {
  const [mounted, setMounted] = useState(open);
  const rendered = useRef<ReactNode>(children);
  if (open) rendered.current = children;

  useEffect(() => {
    if (open) { setMounted(true); return; }
    if (prefersReducedMotion()) setMounted(false); // no transitionend will ever fire
  }, [open]);

  if (!mounted) return null;

  const cls = [styles.collapse, open ? styles.open : "", fill ? styles.fill : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      onTransitionEnd={(e) => { if (e.propertyName === "grid-template-rows" && !open) setMounted(false); }}
    >
      <div className={styles.inner}>{rendered.current}</div>
    </div>
  );
}
