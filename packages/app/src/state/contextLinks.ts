import { useSyncExternalStore } from "react";
import type { ContextLinkCreate } from "@chimera/protocol";
import { dismissAppLocalOverlays } from "./overlayLifecycle";

export type ContextShare = { consumer: string; from: ContextLinkCreate["from"]; text?: string };
let instance = 0;
let share: (ContextShare & { instance: number }) | null = null;
const listeners = new Set<() => void>();
export function closeContextShare(): void { share = null; for (const fn of listeners) fn(); }
export function openContextShare(value: ContextShare): void { dismissAppLocalOverlays({ preserveAgentDetail: true }); share = { ...value, instance: ++instance }; for (const fn of listeners) fn(); }
export function useContextShare(): (ContextShare & { instance: number }) | null { return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => share); }

let mountedShareCards = 0;
export function mountContextShareCard(): () => void {
  mountedShareCards++;
  let active = true;
  return () => { if (active) { active = false; mountedShareCards--; } };
}
export function contextShareOwnsEscape(): boolean { return mountedShareCards > 0; }
