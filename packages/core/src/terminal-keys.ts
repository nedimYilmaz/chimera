// TERMINAL-KEYS — naming a keystroke instead of encoding one.
//
// terminal_write started out taking only literal text, which works for commands and fails for
// everything an interactive program actually listens to. Observed live: an agent tried to send
// Ctrl-C, the tool rejected it with "expected string to have >=1 characters", and the agent
// concluded its text "contained no printable characters". It was right about the symptom and the
// cause was the interface: a model cannot reliably put a raw C0 byte inside tool-call JSON, and
// when it tries, what arrives is empty.
//
// So keys are NAMED. "ctrl-c" is something a model can write correctly every time, and it reads
// the same way in a transcript as it does in a keyboard shortcut. The mapping lives here, once,
// because a sequence written at a call site is a sequence nobody can check.

const ESC = String.fromCharCode(27);
const named: Record<string, string> = {
  enter: String.fromCharCode(13),      // CR, not LF: a PTY in canonical mode is what a Return key sends
  tab: String.fromCharCode(9),
  escape: ESC,
  esc: ESC,
  backspace: String.fromCharCode(127),
  delete: ESC + "[3~",
  space: " ",
  // Cursor + navigation, in the form every terminal program expects them.
  up: ESC + "[A",
  down: ESC + "[B",
  right: ESC + "[C",
  left: ESC + "[D",
  home: ESC + "[H",
  end: ESC + "[F",
  "page-up": ESC + "[5~",
  "page-down": ESC + "[6~",
};

/** The bytes `key` sends, or null if it names nothing.
 *
 *  Accepts the named keys above plus any `ctrl-<letter>` — derived rather than listed, because a
 *  hand-kept table of 26 entries is 26 chances to get one wrong, and the derivation IS the
 *  definition (Ctrl-A is 1, Ctrl-C is 3, and so on up to Ctrl-Z at 26).
 *
 *  Returns null rather than throwing or falling back to typing the literal name: a misspelled key
 *  must not become the word "ctrl-x" appearing in a shell prompt. */
export function terminalKeySequence(key: string): string | null {
  const k = key.trim().toLowerCase();
  if (!k) return null;
  const direct = named[k];
  if (direct !== undefined) return direct;
  const ctrl = /^(?:ctrl|control|\^)[-+]?([a-z])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96);
  return null;
}

/** Every key name this accepts, for an error message that tells the caller what to say instead. */
export function terminalKeyNames(): string[] {
  return [...Object.keys(named), "ctrl-a … ctrl-z"];
}
