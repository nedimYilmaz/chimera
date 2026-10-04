import { type ComponentType, useSyncExternalStore } from "react";

// The shared mount point for SYSTEM overlay cards (accounts/result/model/
// palettes — W6; plugins — W7; host tools — W8) inside each screen's RIGHT
// column host (§0.5: top bar + left rail stay interactive). Card modules
// self-register at module-eval time from src/overlays/index.ts, so three
// parallel workstreams add cards without ever editing a screen file or each
// other's modules: each appends ONE import line to overlays/index.ts and
// registers here. A registered component decides its own visibility (reads
// ui-state or its own local store and returns null when closed) and receives
// the hosting screen id so a card can restrict itself to specific screens.
// W9: "settings" joins the host union so the SettingsScreen mounts the SAME
// outlet — its tools section reuses the mod+d HostToolsCard (registered
// "host-tools") verbatim rather than forking a second host-tools UI, and the
// global cards (accounts/palettes/perf-hud) stay reachable there like every
// other screen.
export type OverlayHost = "agents" | "projects" | "teams" | "queues" | "events" | "memory" | "settings";
export type OverlayProps = { host: OverlayHost; bottomInset: number };

type Entry = { id: string; Component: ComponentType<OverlayProps>; dismiss?: () => void };

let entries: readonly Entry[] = [];
let version = 0;
const listeners = new Set<() => void>();

export function registerOverlay(id: string, Component: ComponentType<OverlayProps>, dismiss?: () => void): () => void {
  entries = [...entries.filter((e) => e.id !== id), { id, Component, dismiss }];
  version++;
  for (const fn of listeners) fn();
  return () => {
    entries = entries.filter((e) => e.id !== id);
    version++;
    for (const fn of listeners) fn();
  };
}

/** Close registered app-local cards without resetting their fetched data,
 * selection, or other persistent view state. Reducer-owned cards are closed
 * by @chimera/ui-state's closeTransientOverlays helper instead. */
export function dismissRegisteredOverlays(): void {
  for (const entry of entries) entry.dismiss?.();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Render once inside every screen's right-column host (position: relative).
 * bottomInset: the composer-band height on the agents screen (decision cards
 * float above it); 0 elsewhere. */
export function OverlayOutlet({ host, bottomInset = 0 }: { host: OverlayHost; bottomInset?: number }) {
  useSyncExternalStore(subscribe, () => version);
  return (
    <>
      {entries.map(({ id, Component }) => (
        <Component key={id} host={host} bottomInset={bottomInset} />
      ))}
    </>
  );
}
