import type { KeyboardEvent } from "react";

// Native activation belongs to a focused disclosure/action, not the fleet's
// bare-key shortcuts. Keep the browser default while stopping root bubbling.
export function ownContextActivation(event: KeyboardEvent<HTMLElement>): void {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || (event.key !== "Enter" && event.key !== " ")) return;
  const target = event.target as HTMLElement;
  if (target.closest?.("button,summary,a[href]")) event.stopPropagation();
}
