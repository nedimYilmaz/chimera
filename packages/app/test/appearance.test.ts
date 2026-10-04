import { describe, expect, it, beforeEach, vi } from "vitest";

// HUMAN-TURN-COLOR — the operator's choice of colour for their own transcript turns.
// What matters here is not the palette but the CONTRACT: only a shipped preset id is ever
// honoured, and what reaches the document is always a var() naming a token — never a stored
// string. That is what keeps a corrupted (or hand-edited) localStorage entry from putting an
// arbitrary value into a CSS property.

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const load = async () => {
  vi.resetModules();
  return import("../src/state/appearance");
};

beforeEach(() => store.clear());

describe("the user-turn colour preference", () => {
  it("defaults to green, and green is what the transcript gets", async () => {
    const a = await load();
    expect(a.userTurnColor()).toBe("green");
    expect(a.userTurnCssValue(a.userTurnColor())).toBe("var(--user-turn-green)");
  });

  it("resolves every preset to a token var — never to a raw colour", async () => {
    const a = await load();
    for (const p of a.USER_TURN_PRESETS) {
      expect(a.userTurnCssValue(p.id)).toBe(`var(${p.cssVar})`);
      expect(a.userTurnCssValue(p.id)).not.toMatch(/#[0-9a-f]/i);
    }
  });

  it("remembers a choice across a reload", async () => {
    const a = await load();
    a.setUserTurnColor("amber");
    expect((await load()).userTurnColor()).toBe("amber");
  });

  it("drops the entry entirely when you go back to the default", async () => {
    // Writing the default as a value would pin it — a later change to the shipped default would
    // then miss everyone who had merely never chosen anything else.
    const a = await load();
    a.setUserTurnColor("teal");
    expect(store.size).toBe(1);
    a.setUserTurnColor("green");
    expect(store.size).toBe(0);
  });

  it("ignores an id it does not ship, however it got into storage", async () => {
    store.set("chimera.appearance.v1", JSON.stringify({ userTurn: "red; background: url(x)" }));
    expect((await load()).userTurnColor()).toBe("green");
    const a = await load();
    a.setUserTurnColor("not-a-preset");
    expect(a.userTurnColor()).toBe("green");
  });

  it("survives unreadable storage rather than failing to start", async () => {
    store.set("chimera.appearance.v1", "{ not json");
    expect((await load()).userTurnColor()).toBe("green");
  });

  it("notifies subscribers only on a real change", async () => {
    const a = await load();
    let fired = 0;
    const off = a.subscribeAppearance(() => { fired++; });
    a.setUserTurnColor("pink");
    expect(fired).toBe(1);
    a.setUserTurnColor("pink");
    expect(fired).toBe(1);
    a.setUserTurnColor("nope");
    expect(fired).toBe(1);
    off();
  });
});
