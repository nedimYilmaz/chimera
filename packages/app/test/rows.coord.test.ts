import { describe, expect, it } from "vitest";
import { KEYMAP, resolveChord } from "../src/keymap";
import { APP_TABS, TAB_ROWS } from "../src/keymap/rows.tabs";
import { COORD_ROWS } from "../src/keymap/rows.coord";

// W5 — the tab strip contract (mock lines 23-36: the tab slots) and the
// coordination-screen chord declarations. W7 activated the projects slot
// (TabId gained "projects"), so the W5-era "inert slot" assertions here were
// re-baselined to the live contract: every slot carries a real tab and every
// number chord is bound. W9 added the SEVENTH slot (settings, mock line 36),
// wired the same registry-handled way (TabId gained "settings", NOT TAB_ORDER).
// FEATURE-9 added the EIGHTH slot (inbox — no mock exists for it yet), same
// registry-handled pattern (TabId gained "inbox", NOT TAB_ORDER).

describe("APP_TABS (eleven slots — F13.2 run history added)", () => {
  it("renders the existing tabs followed by inbox, SLO, roles and runs", () => {
    expect(APP_TABS.map((t) => `${t.num ?? "-"} ${t.label}`)).toEqual([
      "1 agents", "2 projects", "3 teams", "4 queues", "5 events", "6 memory", "7 settings", "8 inbox", "9 slo", "0 roles", "- runs",
    ]);
  });
  it("every slot dispatches a real ui-state tab", () => {
    for (const t of APP_TABS) expect(t.tab).toBe(t.label);
  });
});

describe("TAB_ROWS numbering", () => {
  it("binds all nine number chords including tab.slo", () => {
    const byChord = new Map(TAB_ROWS.map((r) => [r.chord, r]));
    expect(byChord.get("1")?.action).toBe("tab.agents");
    expect(byChord.get("2")?.action).toBe("tab.projects");
    expect(byChord.get("2")?.unbound).toBeUndefined();
    expect(byChord.get("3")?.action).toBe("tab.teams");
    expect(byChord.get("4")?.action).toBe("tab.queues");
    expect(byChord.get("5")?.action).toBe("tab.events");
    expect(byChord.get("6")?.action).toBe("tab.memory");
    expect(byChord.get("7")?.action).toBe("tab.settings");
    expect(byChord.get("7")?.unbound).toBeUndefined();
    expect(byChord.get("8")?.action).toBe("tab.inbox");
    expect(byChord.get("8")?.unbound).toBeUndefined();
    expect(byChord.get("9")?.action).toBe("tab.slo");
    expect(resolveChord("2", "agents")?.action).toBe("tab.projects");
    expect(resolveChord("6", "agents")?.action).toBe("tab.memory");
    expect(resolveChord("7", "agents")?.action).toBe("tab.settings");
    expect(resolveChord("8", "agents")?.action).toBe("tab.inbox");
    expect(resolveChord("9", "agents")?.action).toBe("tab.slo");
  });
  // Restored (regression): the tab/shift+tab cycle chords lost their assertion
  // when the original "renumbering" describe was re-baselined to the nine-slot
  // number contract. TopBar's registration walks the strip via these two.
  it("binds the tab/shift+tab cycle chords to tab.next/tab.prev", () => {
    const byChord = new Map(TAB_ROWS.map((r) => [r.chord, r]));
    expect(byChord.get("tab")?.action).toBe("tab.next");
    expect(byChord.get("shift+tab")?.action).toBe("tab.prev");
  });
});

describe("COORD_ROWS (screen chords, handlers register from the screens)", () => {
  // KEYMAP-REDESIGN: mod+o = the universal "create" chord (was ctrl+n, "n" is
  // OS-reserved), mod+e = the universal "edit" chord (was bare "e" on teams/
  // queues, ctrl+e on memory — now the SAME chord everywhere, rule 6), and
  // mod+shift+x/mod+shift+c are the destroy tier (was ctrl+d — "d" isn't
  // reserved, but the destroy family reads better on shift now that the
  // MUTATE letters are scarce). See keymap.ts's KEYBINDING STANDARD comment.
  it("declares the full mock footer vocabulary per scope", () => {
    const have = new Set(COORD_ROWS.map((r) => `${r.scope}:${r.chord}`));
    for (const expected of [
      "teams:up", "teams:down", "teams:enter", "teams:mod+o", "teams:mod+e", "teams:mod+shift+x",
      "queues:up", "queues:down", "queues:enter", "queues:mod+o", "queues:mod+e", "queues:mod+shift+c",
      "events:f",
      "memory:up", "memory:down", "memory:enter", "memory:mod+o", "memory:mod+e", "memory:mod+shift+x",
      // MEM-6: the neural graph toggle joins the memory scope's chord vocabulary.
      "memory:mod+r",
    ]) expect(have.has(expected), expected).toBe(true);
    // the old ctrl+t secondary drill chord is retired — enter alone drills.
    expect(have.has("teams:ctrl+t")).toBe(false);
  });
  // MEM-6 — mod+r toggles the list ⇄ graph view within the Memory tab (was
  // ctrl+g — that collided in MEANING with system.model's chord elsewhere,
  // rule 7's own named example); the BEHAVIOR (setGraphMode) registers from
  // MemoryScreen, this row just declares the chord + footer label, same
  // registry-handled pattern as the rest of memory:*.
  it("declares the memory graph-toggle chord (mod+r → memory.graph)", () => {
    const row = COORD_ROWS.find((r) => r.scope === "memory" && r.chord === "mod+r");
    expect(row?.action).toBe("memory.graph");
    expect(row?.label).toBe("graph");
  });
  // W16 (F15/D11 CRUD completion) — the universal mod+e edit chord, now
  // identical across every scope it appears in (rule 6 consistency).
  it("declares the edit chord for teams/queues (mouse chip + keyboard parity)", () => {
    expect(COORD_ROWS.find((r) => r.scope === "teams" && r.chord === "mod+e")?.action).toBe("teams.edit");
    expect(COORD_ROWS.find((r) => r.scope === "queues" && r.chord === "mod+e")?.action).toBe("queues.edit");
    expect(COORD_ROWS.find((r) => r.scope === "memory" && r.chord === "mod+e")?.action).toBe("memory.edit");
    expect(COORD_ROWS.find((r) => r.scope === "memory" && r.chord === "mod+shift+x")?.action).toBe("memory.delete");
  });
  // KEYMAP-REDESIGN: the old ctrl+t secondary drill chord is retired — "t" is
  // OS-reserved, and it was redundant with enter (rule 2's own "enter-to-drill"
  // nav example) — so teams.drill now has exactly one bound chord.
  it("enter is the ONLY drill chord for teams now (ctrl+t was retired)", () => {
    const teamRows = COORD_ROWS.filter((r) => r.scope === "teams" && r.action === "teams.drill");
    expect(teamRows.map((r) => r.chord)).toEqual(["enter"]);
  });
  // Restored (regression): the queues scope grew workflow/pin/schedule chords
  // (W15/W18/F01/F14) whose action ids the mock-footer vocabulary set above
  // never asserts. KEYMAP-REDESIGN: pin/pause/run are rule-3 mutate examples
  // so they're mod-qualified now (were bare p/r); delete-schedule joins the
  // universal mod+shift+x destroy chord (was bare 'd'); workflow/schedule-
  // toggle stay bare (pure view toggles, rule 2).
  it("declares the queues workflow/pin/schedule chords", () => {
    const byChord = new Map(COORD_ROWS.filter((r) => r.scope === "queues").map((r) => [r.chord, r]));
    expect(byChord.get("w")?.action).toBe("queues.workflow");
    expect(byChord.get("mod+p")?.action).toBe("queues.pin");
    expect(byChord.get("space")?.action).toBe("queues.scheduleToggle");
    expect(byChord.get("mod+r")?.action).toBe("queues.scheduleRun");
    expect(byChord.get("mod+shift+x")?.action).toBe("queues.scheduleDelete");
  });
  // Restored (regression): the events scope carries a row cursor (up/down) so
  // the F01 pin chord has a selected row — only events:f was asserted above.
  // KEYMAP-REDESIGN: pin promoted to mod+p (rule 3), same chord as queues.pin
  // (rule 6 — one meaning, one combo, across every scope it appears in).
  it("declares the events cursor + pin chords (F01 PinnedBar)", () => {
    const byChord = new Map(COORD_ROWS.filter((r) => r.scope === "events").map((r) => [r.chord, r]));
    expect(byChord.get("up")?.action).toBe("events.up");
    expect(byChord.get("down")?.action).toBe("events.down");
    expect(byChord.get("mod+p")?.action).toBe("events.pin");
  });
  // Restored (regression): the memory master/detail chords declare real action
  // ids the vocabulary set only checks for presence, not mapping.
  it("declares the memory expand/new action ids", () => {
    const byChord = new Map(COORD_ROWS.filter((r) => r.scope === "memory").map((r) => [r.chord, r]));
    expect(byChord.get("enter")?.action).toBe("memory.expand");
    expect(byChord.get("mod+o")?.action).toBe("memory.new");
  });
  // Restored (regression): every coord row must carry a non-empty footer label
  // — the Footer/PanelFooter render straight from this ONE table.
  it("gives every row a non-empty footer label", () => {
    for (const r of COORD_ROWS) expect(r.label.length, `${r.scope}:${r.chord}`).toBeGreaterThan(0);
  });
  it("never collides with a global chord in its scope pair", () => {
    for (const scope of ["teams", "queues", "events", "memory", "projects"] as const) {
      // Mirror resolveChord's own guard: unbound rows never resolve, so an
      // overlay-owned unbound global chord (e.g. host-tools `p`, dispatched
      // only via the card's capture-phase listener) does not collide with a
      // bound screen chord of the same key.
      // VOICE-STOP: same for a `when`-gated row (esc → voice.stopSpeaking) — it shadows its
      // ungated twin only while the gate is active, which resolveChord handles by preference.
      const applicable = KEYMAP
        .filter((r) => !r.unbound && r.when === undefined && (r.scope === "global" || r.scope === scope))
        .map((r) => r.chord);
      expect(new Set(applicable).size).toBe(applicable.length);
    }
  });
});
