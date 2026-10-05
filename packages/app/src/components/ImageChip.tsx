import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Image } from "@chimera/ui-state";
import styles from "./ImageChip.module.css";
import { OverlayCard, OverlayCardHeader } from "./OverlayCard";
import { registerOverlay } from "./OverlayOutlet";
import { appStore } from "../state/store";
import { dismissAppLocalOverlays, reducerOverlayId } from "../state/overlayLifecycle";
const RegistrationOnly = () => null;

// The same self-contained raster viewer serves user attachments and tool output. Its
// body portal escapes transcript containment; OverlayCard owns Escape/focus lifecycle.
export function ImageChip({ image, name, onRemove, outputPreview }: {
  image: Image;
  name: string;
  /** Composer-only: ✕ affordance to drop a pending image before send. */
  onRemove?: () => void;
  outputPreview?: boolean;
}) {
  const viewerId = useId();
  const openerAgent = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const src = `data:${image.mediaType};base64,${image.data}`;
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const unregister = registerOverlay(`image-viewer:${viewerId}`, RegistrationOnly, close);
    const check = () => {
      const state = appStore.getState();
      if (state.selectedAgentId !== openerAgent.current || reducerOverlayId(state) !== null) close();
    };
    const unsubscribe = appStore.subscribe(check);
    check(); // An overlay/selection may have changed before this effect mounted.
    return () => { unsubscribe(); unregister(); };
  }, [open, viewerId]);
  return (
    <span className={`${styles.wrap} ${outputPreview ? styles.output : ""}`}>
      <button
        type="button"
        className={styles.chip}
        onClick={() => {
          if (open) { setOpen(false); return; }
          dismissAppLocalOverlays();
          openerAgent.current = appStore.getState().selectedAgentId;
          setOpen(true);
        }}
        title={open ? `${name} — click to hide` : `${name} — click to view`}
        data-image-chip
        data-output-image-chip={outputPreview || undefined}
        aria-label={`View ${name}`}
        disabled={failed}
      >
        {failed ? <span className={styles.failure}>Image unavailable</span> : <img className={styles.thumb} src={src} alt={name} onError={() => setFailed(true)} />}
      </button>
      {onRemove ? (
        <button type="button" className={styles.remove} title="remove" onClick={onRemove}>✕</button>
      ) : null}
      {/* Rendered through a PORTAL into <body> so the fixed overlay escapes any
          transformed/contained ancestor (a transcript/message container with a
          transform or `contain` traps position:fixed to itself — that's why the
          "full size" view showed up as a mid-page band, not the whole window).
          At body level, position:fixed truly fills the viewport. */}
      {open
        ? createPortal(
            <div className={styles.lightbox} data-image-lightbox>
              <OverlayCard width={960} dismissOnReplacement onClose={() => setOpen(false)} ariaLabel={name}>
                <OverlayCardHeader title={name} hint={<button type="button" onClick={() => setOpen(false)} aria-label="Close image">close · esc</button>} />
                <div className={styles.fullImage}>
                  <img className={styles.img} src={src} alt={name} onError={() => { setFailed(true); setOpen(false); }} />
                </div>
              </OverlayCard>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
