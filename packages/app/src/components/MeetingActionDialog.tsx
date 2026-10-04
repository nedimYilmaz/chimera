import { useEffect, useRef } from "react";
import styles from "./MeetingRooms.module.css";

export function MeetingActionDialog({ title, body, names, label, onConfirm, onClose }: {
  title: string; body: string; names: string[]; label: string; onConfirm(): void; onClose(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    const key = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key === "Tab") {
        const buttons = cancel.current?.parentElement?.querySelectorAll<HTMLButtonElement>("button");
        if (buttons?.length) { event.preventDefault(); const next = document.activeElement === buttons[0] ? buttons[1] : buttons[0]; next?.focus(); }
      }
    };
    window.addEventListener("keydown", key, { capture: true });
    return () => { window.removeEventListener("keydown", key, { capture: true }); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className={styles.confirmLayer}>
    <section role="alertdialog" aria-modal="true" aria-labelledby="meeting-confirm-title" aria-describedby="meeting-confirm-body" className={styles.confirmCard}>
      <h3 id="meeting-confirm-title">{title}</h3><p id="meeting-confirm-body">{body}</p>
      <ul>{names.map((name, i) => <li key={i}>{name}</li>)}</ul>
      <div className={styles.controls}><button ref={cancel} type="button" onClick={onClose}>Cancel</button><button className={styles.danger} type="button" onClick={onConfirm}>{label}</button></div>
    </section>
  </div>;
}
