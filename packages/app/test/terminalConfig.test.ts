import { describe, it, expect, afterEach } from "vitest";

// Same plain-node + hand-shimmed-globals convention the other app tests use (see
// AgentList.showDonePersist.test.tsx) — there is no jsdom here. A minimal document is enough:
// terminalTheme only ever reads custom properties off the root element.
const props = new Map<string, string>();
if (typeof document === "undefined") {
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => { props.set(k, v); },
        removeProperty: (k: string) => { props.delete(k); },
        set cssText(_v: string) { props.clear(); },
        get cssText() { return ""; },
      },
    },
  };
  (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: (k: string) => props.get(k) ?? "",
  });
}

import { findOptionsFor, terminalTheme } from "../src/components/terminalConfig";

// TERMINAL-USABILITY — the two decisions in TerminalView that are pure, and that would rot
// silently: the palette's tie to the app's design tokens, and the find bar's case rule. The
// component itself owns real xterm/PTY wiring and stays mocked in TerminalDock.render.test.tsx.

describe("findOptionsFor (smart case)", () => {
  it("is case-INsensitive for an all-lowercase needle", () => {
    expect(findOptionsFor("error").caseSensitive).toBe(false);
    expect(findOptionsFor("npm run build").caseSensitive).toBe(false);
  });

  it("turns case-sensitive the moment the needle carries an uppercase letter", () => {
    expect(findOptionsFor("ERROR").caseSensitive).toBe(true);
    expect(findOptionsFor("useEffect").caseSensitive).toBe(true);
  });

  it("judges case by LETTERS, not by any non-lowercase character", () => {
    // A needle of digits and punctuation has no case to be sensitive about; treating it as
    // uppercase would silently narrow a search for something like "127.0.0.1:8080".
    expect(findOptionsFor("127.0.0.1:8080").caseSensitive).toBe(false);
    expect(findOptionsFor("--output-format").caseSensitive).toBe(false);
    // and it must see case in non-ASCII alphabets too, not just A-Z
    expect(findOptionsFor("ölçüm").caseSensitive).toBe(false);
    expect(findOptionsFor("Ölçüm").caseSensitive).toBe(true);
  });

  it("says nothing about an empty needle rather than throwing", () => {
    expect(findOptionsFor("")).toEqual({ caseSensitive: false });
  });
});

describe("terminalTheme", () => {
  afterEach(() => { props.clear(); });

  const seedAll = (): void => {
    for (const t of ["--panel", "--fg", "--accent", "--sel-bg", "--bg", "--danger", "--success",
      "--warn", "--info", "--accent-bright", "--fg-soft", "--faint", "--danger-soft"]) {
      props.set(t, "#101010");
    }
  };

  it("fills every ANSI slot when the tokens are there", () => {
    seedAll();
    const t = terminalTheme()!;
    for (const slot of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta",
      "brightCyan", "brightWhite", "background", "foreground", "cursor", "selectionBackground"]) {
      expect(t[slot], slot).toBe("#101010");
    }
  });

  it("reads the app's LIVE tokens, so a theme change lands here without a second edit", () => {
    seedAll();
    props.set("--panel", "#010203");
    props.set("--accent", "#040506");
    const t = terminalTheme()!;
    expect(t["background"]).toBe("#010203");
    expect(t["cursor"]).toBe("#040506");
  });

  it("returns undefined when no token resolves — xterm's own defaults beat a half-palette", () => {
    // An empty string is NOT "use your default" to xterm; it is an invalid colour and the slot
    // renders transparent. Handing it no theme at all is the only safe degradation.
    expect(terminalTheme()).toBeUndefined();
  });

  it("omits a slot whose token is missing rather than emitting an empty value", () => {
    props.set("--panel", "#010203");
    const t = terminalTheme()!;
    expect(t["background"]).toBe("#010203");
    expect("red" in t).toBe(false);
    expect(Object.values(t).every((v) => v.length > 0)).toBe(true);
  });

  it("carries NO colour of its own — the palette is token-only, like the rest of the app", () => {
    // The guard in copy-guard.test.ts enforces this for src/; stated here too because the reason
    // is behavioural, not stylistic: a second palette written in TypeScript drifts from
    // tokens.css the first time the theme is touched, and nothing would catch it.
    seedAll();
    expect(Object.values(terminalTheme()!).every((v) => v === "#101010")).toBe(true);
  });
});
