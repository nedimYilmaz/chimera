// Team icon pack (shared app + tui): a team is shown in AgentList as a compact
// COLORED GLYPH badge instead of its full name repeated on every row (user
// request: "takımın adını uzun uzun yazmayalım, ikonları olsun — mavi kare,
// yeşil yıldız..."). teamIcon maps a team name to a STABLE {glyph, color} pair
// by hashing the name, so the same team always wears the same badge and
// distinct teams get visually distinct badges. `color` is a SEMANTIC id — each
// renderer maps it to its own palette (app → a CSS class / accent var; tui →
// an Ink color name), so the two surfaces stay in visual sync from one source.

export const TEAM_GLYPHS = ["■", "●", "★", "◆", "▲", "✦", "⬢", "❖", "◗", "⬟", "✚", "▰"] as const;

// Semantic color ids — renderer-agnostic. Kept to a set both the app's CSS
// palette and Ink's named colors can represent 1:1.
export const TEAM_COLORS = ["blue", "green", "amber", "purple", "cyan", "magenta", "red", "teal"] as const;
export type TeamColorId = (typeof TEAM_COLORS)[number];

export interface TeamIcon {
  glyph: string;
  color: TeamColorId;
}

// FNV-1a-ish stable string hash (deterministic across sessions/surfaces — no
// Math.random, no Date). >>> 0 keeps it an unsigned 32-bit int. Exported so
// AGENT-GROUPS Phase 1 (agentGroups.ts's groupColor) can reuse the SAME hash for its own
// default-color pick, instead of inventing a second one — a group and a team should feel
// like the same visual language, just keyed on a different name.
export function hashTeam(team: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < team.length; i++) {
    h ^= team.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable {glyph, color} badge for a team name. Glyph and color are picked from
 * independent slices of the hash so two teams that happen to share a glyph
 * still differ by color (and vice-versa). Empty/whitespace team → null (no
 * badge; a teamless agent renders none). */
export function teamIcon(team: string | undefined | null): TeamIcon | null {
  if (!team || team.trim() === "") return null;
  const h = hashTeam(team);
  const glyph = TEAM_GLYPHS[h % TEAM_GLYPHS.length]!;
  const color = TEAM_COLORS[Math.floor(h / TEAM_GLYPHS.length) % TEAM_COLORS.length]!;
  return { glyph, color };
}
