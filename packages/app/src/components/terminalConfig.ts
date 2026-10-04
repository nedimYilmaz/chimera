// TERMINAL-USABILITY: the pure, xterm-free half of the terminal's configuration.
//
// Split out so it can be tested at all: importing TerminalView drags in @xterm/xterm, which
// touches `self` at module scope and cannot be loaded in a node test env. These two decisions are
// exactly the ones that rot quietly — a palette slot that drifts from the design tokens, and a
// find rule nobody re-reads — so they need to be reachable without a DOM.

/** Read a CSS custom property off the document root. Empty string when it does not resolve —
 *  callers decide what that means; this never invents a value. */
export function readToken(name: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm slot -> the design token it takes its colour from. TOKEN-ONLY, like the rest of the app
 *  (packages/app/test/copy-guard.test.ts): no literal hex lives here, because a second palette
 *  written in TypeScript drifts from tokens.css the first time the theme is touched and nothing
 *  catches it — the terminal would just quietly stop matching. */
const SLOT_TOKENS: ReadonlyArray<readonly [slot: string, token: string]> = [
  ["background", "--panel"], ["foreground", "--fg"],
  ["cursor", "--accent"], ["cursorAccent", "--panel"], ["selectionBackground", "--sel-bg"],
  ["black", "--bg"], ["red", "--danger"], ["green", "--success"], ["yellow", "--warn"],
  ["blue", "--info"], ["magenta", "--accent"], ["cyan", "--accent-bright"], ["white", "--fg-soft"],
  ["brightBlack", "--faint"], ["brightRed", "--danger-soft"], ["brightGreen", "--success"],
  ["brightYellow", "--warn"], ["brightBlue", "--info"], ["brightMagenta", "--accent-bright"],
  ["brightCyan", "--accent-bright"], ["brightWhite", "--fg"],
];

/** The terminal's palette, resolved from the app's live tokens.
 *
 *  Returns UNDEFINED when the tokens are not readable (no DOM, stylesheet not yet applied) rather
 *  than a half-filled theme: an empty string is not "use your default" to xterm, it is an invalid
 *  colour and the slot renders transparent. No theme at all means xterm's own defaults, which is
 *  a worse match but never a broken one. A slot whose token is missing is omitted for the same
 *  reason. */
export function terminalTheme(): Record<string, string> | undefined {
  const theme: Record<string, string> = {};
  for (const [slot, token] of SLOT_TOKENS) {
    const value = readToken(token);
    if (value.length > 0) theme[slot] = value;
  }
  return Object.keys(theme).length > 0 ? theme : undefined;
}

/** Smart case: case-insensitive until the needle itself carries an uppercase LETTER. The
 *  convention every editor's find already uses, so nobody has to discover a toggle to search for
 *  "error" and still be able to find "ERROR" specifically. Judged on letters, not on any
 *  non-lowercase character — otherwise "127.0.0.1:8080" would silently search case-sensitively. */
export function findOptionsFor(needle: string): { caseSensitive: boolean } {
  return { caseSensitive: /\p{Lu}/u.test(needle) };
}
