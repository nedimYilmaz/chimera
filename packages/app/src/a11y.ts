import type { KeyboardEvent } from "react";

/** onKeyDown for a clickable row: Enter/Space activates it like a click. */
export function onRowKeyDown(onActivate: () => void) {
  return (ev: KeyboardEvent<HTMLDivElement>): void => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onActivate();
    }
  };
}
