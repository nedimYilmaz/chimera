import { useSyncExternalStore } from "react";

export type ShortcutSource = { chord: string; action: string; scope: string; label: string; when?: string; unbound?: boolean };
export type KeyboardPreferences = { leader: "mod+k" | "mod+shift+k"; bindings: Record<string, string | null> };
const KEY = "chimera.keyboard.v1";
const defaults: KeyboardPreferences = { leader: "mod+k", bindings: {} };
const listeners = new Set<() => void>();
export function validSuffix(value: unknown): value is string {
  return typeof value === "string" && /^(shift\+)?([a-z0-9]|space|up|down|left|right|\[|\])$/.test(value);
}
export function parseKeyboardPreferences(raw: string | null): KeyboardPreferences {
  try {
    const data = JSON.parse(raw ?? "null");
    const bindings: Record<string, string | null> = {};
    if (data?.bindings && typeof data.bindings === "object" && !Array.isArray(data.bindings)) {
      for (const [key, value] of Object.entries(data.bindings)) {
        if (/^[a-zA-Z][\w.]+$/.test(key) && (value === null || validSuffix(value))) bindings[key] = value;
      }
    }
    return { leader: data?.leader === "mod+shift+k" ? data.leader : defaults.leader, bindings };
  } catch { return { ...defaults, bindings: {} }; }
}
function read(): KeyboardPreferences { try { return parseKeyboardPreferences(localStorage.getItem(KEY)); } catch { return { ...defaults, bindings: {} }; } }
let state = read();
export const keyboardPreferences = () => state;
export function subscribeKeyboard(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function useKeyboardPreferences(): KeyboardPreferences { return useSyncExternalStore(subscribeKeyboard, keyboardPreferences); }
export function saveKeyboardPreferences(next: KeyboardPreferences): string | null {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(next)); }
  catch { return "Could not save shortcuts. Local storage is unavailable or full."; }
  state = next; for (const fn of listeners) fn(); return null;
}
export function resetKeyboardPreferences(): string | null { return saveKeyboardPreferences({ ...defaults, bindings: {} }); }

const suffixes: Record<string, string> = {
  "system.palette": "space", "system.accounts": "a", "system.mcpPalette": "m",
  "host.toggle": "h", "plugins.toggleCard": "s", "voice.conversationToggle": "v",
  "terminal.toggle": "j", "perm.deny": "shift+y", "tab.next": "]", "tab.prev": "[",
  "system.compact": "c", "system.effort": "shift+e", "system.accountSwitch": "shift+a",
  "system.remoteControl": "shift+d", "system.result": "shift+z",
};
const globals = new Set(["system.accounts", "system.mcpPalette", "host.toggle", "plugins.toggleCard"]);
export function sequenceSuffix(row: ShortcutSource, preferences = state): string | null {
  if (Object.hasOwn(preferences.bindings, row.action)) return preferences.bindings[row.action] ?? null;
  if (suffixes[row.action]) return suffixes[row.action]!;
  if (row.chord === "mod+f") return null;
  if (row.chord.startsWith("mod+")) return row.chord.slice(4) === "o" ? "n" : row.chord.slice(4);
  return null;
}
export function shortcutRows<T extends ShortcutSource>(rows: readonly T[], preferences = state): T[] {
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (row.unbound && row.action !== "terminal.toggle") return [];
    const suffix = sequenceSuffix(row, preferences);
    const scope = globals.has(row.action) ? "global" : row.scope;
    const key = `${scope}:${row.action}`;
    if (seen.has(key)) return [];
    seen.add(key);
    if (Object.hasOwn(preferences.bindings, row.action) && suffix === null) return [];
    return [{ ...row, scope, unbound: false, chord: suffix ? `${preferences.leader} ${suffix}` : row.chord }];
  });
}
export function bindingConflict(rows: readonly ShortcutSource[], action: string, value: string | null, preferences = state): string | null {
  if (value !== null && !validSuffix(value)) return "Use a letter, digit, arrow or Shift+letter after the leader; leave empty to disable.";
  const next = { ...preferences, bindings: { ...preferences.bindings, [action]: value } };
  const effective = shortcutRows(rows, next);
  for (const a of effective.filter(row => row.action === action)) {
    const hit = effective.find(b => b.action !== action && b.chord === a.chord && (a.scope === b.scope || a.scope === "global" || b.scope === "global"));
    if (hit) return `Already used by ${hit.label} (${hit.scope}).`;
  }
  return null;
}
