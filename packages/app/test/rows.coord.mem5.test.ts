import { describe, expect, it } from "vitest";
import { resolveChord } from "../src/keymap";
import { COORD_ROWS } from "../src/keymap/rows.coord";

// MEM-5 (§8) — the three memory-scope chords the mem5 screen test exercises only
// for mod+k (mode cycle, was ctrl+m — "m" is OS-reserved): mod+r (MEM-6 graph
// stub, was ctrl+g — that collided in MEANING with system.model elsewhere,
// KEYMAP-REDESIGN rule 7) and alt+left (link-nav back step) are otherwise
// unasserted at the row-declaration level. These rows carry the footer labels
// AND own the chord in the memory scope so it never falls through to typing.
// Pure table assertions (handlers register from the screen).
const memRow = (chord: string) => COORD_ROWS.find((r) => r.scope === "memory" && r.chord === chord);

describe("COORD_ROWS — MEM-5 memory chords", () => {
  it("declares mod+k → memory.mode (search-mode cycle) with a footer label", () => {
    const row = memRow("mod+k");
    expect(row?.action).toBe("memory.mode");
    expect(row?.label).toBe("search mode");
  });

  it("declares alt+left → memory.back (the link-nav back step)", () => {
    const row = memRow("alt+left");
    expect(row?.action).toBe("memory.back");
    expect(row?.label).toBe("back");
  });

  it("declares mod+r → memory.graph (reserved MEM-6 stub, owned so it never types)", () => {
    const row = memRow("mod+r");
    expect(row?.action).toBe("memory.graph");
    expect(row?.label).toBe("graph");
  });

  it("resolves each MEM-5 chord within the memory scope", () => {
    expect(resolveChord("mod+k", "memory")?.action).toBe("memory.mode");
    expect(resolveChord("mod+r", "memory")?.action).toBe("memory.graph");
    expect(resolveChord("alt+left", "memory")?.action).toBe("memory.back");
  });

  it("keeps the MEM-5 chords scoped to memory (not leaking to another coord scope)", () => {
    for (const chord of ["mod+k", "mod+r", "alt+left"]) {
      expect(resolveChord(chord, "teams")?.action ?? "").not.toMatch(/^memory\./);
      expect(resolveChord(chord, "queues")?.action ?? "").not.toMatch(/^memory\./);
    }
  });
});
