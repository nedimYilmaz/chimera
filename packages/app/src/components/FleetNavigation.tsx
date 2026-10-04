import type { ReactNode } from "react";
import styles from "./FleetNavigation.module.css";
export type FleetView = "inspector" | "meetings" | "dashboard" | "liveboard";
export function FleetNavigation({ view, onChange, tools }: { tools?:ReactNode; view: FleetView; onChange: (view: FleetView) => void }) {
  return <nav className={styles.nav} aria-label="Agent views">
    {(["inspector", "meetings", "dashboard", "liveboard"] as const).map(item =>
      <button type="button" key={item} aria-current={view === item ? "page" : undefined} onClick={() => onChange(item)}>{item === "meetings" ? "meeting rooms" : item}</button>)}
    {tools}
  </nav>;
}
