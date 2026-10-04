import type { CSSProperties, ReactNode } from "react";
import styles from "./Panel.module.css";

// W3 — the titled frame every pane uses (PLAN §5 "Layout"): a --panel box with
// a floating label chip sitting ON the top border (mock: absolute -9px, panel
// bg so it visually breaks the border). The label accepts rich children
// (counts/meta spans). `focused` paints the accent focus ring.
export function Panel({
  label,
  focused = false,
  className,
  style,
  children,
}: {
  label: ReactNode;
  focused?: boolean;
  className?: string;
  // PANE-RESIZE: lets a caller hand the panel a live custom property (--pane-w) without this
  // component learning anything about panes. Deliberately narrow — a full style passthrough would
  // invite callers to restyle a panel inline and route around the token system.
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const cls = [styles.panel, focused ? styles.focused : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <section className={cls} {...(style ? { style } : {})}>
      <div className={styles.label}>{label}</div>
      {children}
    </section>
  );
}

/** The key-hint line every pane bottom shows (mock: border-top --line-soft,
 * faint 12px, padding 6px 14px 0). */
export function PanelFooter({ children }: { children?: ReactNode }) {
  return <div className={styles.footer}>{children}</div>;
}
