import { describe, expect, it } from "vitest";
import { terminalKeySequence } from "@chimera/core/terminal-keys";

// TERMINAL-KEYS — naming a keystroke instead of encoding one.
//
// terminal_write took only literal text at first, which works for commands and fails for
// everything an interactive program listens to. Observed live: an agent tried to send Ctrl-C, the
// tool rejected it with "expected string to have >=1 characters", and the agent concluded its text
// "contained no printable characters". It had the symptom right; the cause was the interface. A
// model cannot reliably put a raw C0 byte inside tool-call JSON, and what arrives is empty.
//
// Expected values are written as char codes here for the same reason the source builds them that
// way: a test file carrying raw control bytes is one a diff or a review renders as nothing.
const ch = (n: number): string => String.fromCharCode(n);
const ESC = ch(27);

describe("terminalKeySequence", () => {
  it("maps the keys an interactive program actually waits on", () => {
    expect(terminalKeySequence("enter")).toBe(ch(13));
    expect(terminalKeySequence("tab")).toBe(ch(9));
    expect(terminalKeySequence("escape")).toBe(ESC);
    expect(terminalKeySequence("backspace")).toBe(ch(127));
  });

  it("sends CR for enter, not LF", () => {
    // A Return key sends carriage return; a PTY in canonical mode is what turns that into a
    // submitted line. LF looks equivalent and is not, in exactly the programs this exists for.
    expect(terminalKeySequence("enter")).toBe(ch(13));
    expect(terminalKeySequence("enter")).not.toBe(ch(10));
  });

  it("derives every ctrl-<letter> rather than listing them", () => {
    // The derivation IS the definition. A hand-kept table of 26 is 26 chances to get one wrong.
    expect(terminalKeySequence("ctrl-c")).toBe(ch(3));
    expect(terminalKeySequence("ctrl-a")).toBe(ch(1));
    expect(terminalKeySequence("ctrl-z")).toBe(ch(26));
    expect(terminalKeySequence("ctrl-d")).toBe(ch(4));
  });

  it("accepts the spellings a model actually writes", () => {
    for (const k of ["Ctrl-C", "ctrl+c", "control-c", "^c", " ctrl-c "]) {
      expect(terminalKeySequence(k), k).toBe(ch(3));
    }
    expect(terminalKeySequence("ESC")).toBe(ESC);
  });

  it("maps arrows and navigation to the escape sequences terminals expect", () => {
    expect(terminalKeySequence("up")).toBe(`${ESC}[A`);
    expect(terminalKeySequence("down")).toBe(`${ESC}[B`);
    expect(terminalKeySequence("right")).toBe(`${ESC}[C`);
    expect(terminalKeySequence("left")).toBe(`${ESC}[D`);
    expect(terminalKeySequence("page-down")).toBe(`${ESC}[6~`);
  });

  it("REFUSES a name it does not know instead of typing it", () => {
    // The failure that matters. Falling back to the literal name would put "ctrl-x" into a shell
    // prompt — a plausible-looking command the caller never meant to run.
    expect(terminalKeySequence("ctrl-shift-p")).toBeNull();
    expect(terminalKeySequence("f5")).toBeNull();
    expect(terminalKeySequence("meta-x")).toBeNull();
    expect(terminalKeySequence("")).toBeNull();
    expect(terminalKeySequence("   ")).toBeNull();
  });

  it("never returns an empty string for a key it accepted", () => {
    // An accepted key that sends nothing would report delivered and do nothing — the exact silent
    // failure this whole feature was reported for.
    for (const k of ["enter", "tab", "escape", "space", "up", "home", "ctrl-c", "ctrl-z", "delete"]) {
      expect(terminalKeySequence(k)?.length, k).toBeGreaterThan(0);
    }
  });
});
