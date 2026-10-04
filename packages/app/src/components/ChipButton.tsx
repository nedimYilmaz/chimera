import { forwardRef, type ButtonHTMLAttributes } from "react";
import styles from "./ChipButton.module.css";

/**
 * The compact action shape used by the overlay-card footers.  This is
 * deliberately not a general button system: callers keep their own tone and
 * wording while this one boundary supplies native button behavior.
 */
export const ChipButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ChipButton({ className, type: _type, ...props }, ref) {
    return <button ref={ref} type="button" className={[styles.button, className].filter(Boolean).join(" ")} {...props} />;
  },
);
