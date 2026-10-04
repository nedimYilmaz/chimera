import { useState } from "react";
import { createPortal } from "react-dom";
import type { Image } from "@chimera/ui-state";
import styles from "./ImageChip.module.css";

// W4 + thumbnail (user request): a pasted/sent image renders as a small INLINE
// THUMBNAIL of the image itself (not a "▣ name · click to view" text chip), and
// clicking it shows the full-size version IN PLACE (the in-column lightbox) —
// "büyük halini burada göster". The image data rides base64 on the Image block
// (the CSP allows data: URLs), so both the thumbnail and the lightbox are
// self-contained — no fs/opener round-trip. `name` becomes the hover tooltip.
export function ImageChip({ image, name, onRemove }: {
  image: Image;
  name: string;
  /** Composer-only: ✕ affordance to drop a pending image before send. */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const src = `data:${image.mediaType};base64,${image.data}`;
  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.chip}
        onClick={() => setOpen((o) => !o)}
        title={open ? `${name} — click to hide` : `${name} — click to view`}
        data-image-chip
      >
        <img className={styles.thumb} src={src} alt={name} />
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
            <span className={styles.lightbox} onClick={() => setOpen(false)} data-image-lightbox>
              <img className={styles.img} src={src} alt={name} />
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
