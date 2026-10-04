import { describe, it, expect } from "vitest";
import { teamIcon, TEAM_GLYPHS, TEAM_COLORS } from "@chimera/ui-state";

// The team icon pack replaces the full team name (repeated on every AgentList
// row) with a compact colored glyph. These lock the contract both renderers
// (app CSS classes, tui Ink tokens) lean on: stable per team, distinct across
// teams, always drawn from the declared palette, and absent for teamless rows.
describe("teamIcon", () => {
  it("returns a glyph + color drawn from the declared palettes", () => {
    const icon = teamIcon("team-chimera");
    expect(icon).not.toBeNull();
    expect(TEAM_GLYPHS).toContain(icon!.glyph);
    expect(TEAM_COLORS).toContain(icon!.color);
  });

  it("is STABLE — the same team always maps to the same badge", () => {
    expect(teamIcon("team-chimera")).toEqual(teamIcon("team-chimera"));
    expect(teamIcon("team-tui")).toEqual(teamIcon("team-tui"));
  });

  it("gives teamless / blank input no badge (null)", () => {
    expect(teamIcon(undefined)).toBeNull();
    expect(teamIcon(null)).toBeNull();
    expect(teamIcon("")).toBeNull();
    expect(teamIcon("   ")).toBeNull();
  });

  it("spreads distinct teams across the palette (not all identical)", () => {
    const names = Array.from({ length: 24 }, (_, i) => `team-${i}`);
    const glyphs = new Set(names.map((n) => teamIcon(n)!.glyph));
    const colors = new Set(names.map((n) => teamIcon(n)!.color));
    // A trivial/constant hash would collapse these to 1 each; the FNV mix must
    // fan them out across most of both palettes.
    expect(glyphs.size).toBeGreaterThan(TEAM_GLYPHS.length / 2);
    expect(colors.size).toBeGreaterThan(TEAM_COLORS.length / 2);
  });
});
