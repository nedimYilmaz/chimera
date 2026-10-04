import type { CSSProperties } from "react";
import styles from "./MeetingAvatar.module.css";

// Identity, rather than roster position, keeps each participant's color stable.
export function MeetingAvatar({ name, identity, speaking, human = false }: { name: string; identity: string; speaking: boolean; human?: boolean }) {
  const hue = Array.from(identity).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) * 137 % 360;
  const initials = name.trim().split(/[\s_-]+/u).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join("").toLocaleUpperCase();
  return <div className={styles.avatar} data-avatar-speaking={speaking} style={{ "--avatar-hue": hue } as CSSProperties} role="img" aria-label={`${name}${speaking ? ", speaking" : ""}`}>
    <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="24" r="11" /><path d={human ? "M12 56a20 20 0 0 1 40 0" : "M14 56V45q0-8 8-8h20q8 0 8 8v11"} /><circle className={styles.eye} cx="28" cy="23" r="2" /><circle className={styles.eye} cx="36" cy="23" r="2" /></svg>
    <span className={styles.initials} aria-hidden="true">{initials || "?"}</span>
    <span className={styles.wave} aria-hidden="true"><i /><i /><i /><i /></span>
  </div>;
}
