// MEM-6 §5.2 — pre-rendered radial-glow sprites. Per-frame `shadowBlur` is the
// classic canvas killer and is BANNED (§5.2); instead each node color gets ONE
// offscreen glow sprite rendered once and blitted per node via drawImage (cheap,
// GPU-friendly). One sprite per color is enough — drawImage scales it to each
// node's size, and the radii here (2.5–~13px) downscale cleanly from a 32px core.
//
// Color parsing is unit-testable (parseRgb); the canvas render needs a 2D
// context, so the cache takes an injected canvas factory (default: document).

/** Best-effort CSS color → {r,g,b}. Tokens resolve to hex (#rgb / #rrggbb); we
 *  also accept rgb()/rgba(). Returns null if unparseable (caller falls back). */
export function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const c = color.trim();
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    }
    return null;
  }
  const m = c.match(/rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i);
  if (m) return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) };
  return null;
}

function rgba(rgb: { r: number; g: number; b: number }, a: number): string {
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
}

// Sprite geometry: a `SPRITE_R`-radius glow on a 2·SPRITE_R canvas. The bright
// CORE occupies CORE_FRAC of the radius; the halo blooms out to the edge. A node
// of world-radius r draws with destination half-size r/CORE_FRAC, so the visible
// core ≈ r and the halo extends ~2.5·r around it.
export const SPRITE_R = 32;
export const CORE_FRAC = 0.4;

export interface CanvasLike {
  width: number;
  height: number;
  getContext(id: "2d"): CanvasRenderingContext2D | null;
}
export type CanvasFactory = (size: number) => CanvasLike;

const defaultFactory: CanvasFactory = (size) => {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
};

export class GlowSpriteCache {
  private readonly cache = new Map<string, CanvasLike>();
  constructor(private readonly createCanvas: CanvasFactory = defaultFactory) {}

  /** The glow sprite for `color`, rendered once and memoized. */
  get(color: string): CanvasLike {
    const hit = this.cache.get(color);
    if (hit) return hit;
    const sprite = this.render(color);
    this.cache.set(color, sprite);
    return sprite;
  }

  /** Draw radius factor: destination half-size for a node of world-radius r. */
  static destHalf(radius: number): number {
    return radius / CORE_FRAC;
  }

  size(): number {
    return this.cache.size;
  }

  private render(color: string): CanvasLike {
    const dim = SPRITE_R * 2;
    const canvas = this.createCanvas(dim);
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext("2d");
    if (!ctx) return canvas;
    const rgb = parseRgb(color) ?? { r: 154, g: 163, b: 242 };
    const cx = SPRITE_R;
    const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, SPRITE_R);
    // bright core → soft mid → transparent halo (all same hue, alpha ramp: no
    // muddy fade-to-black because we emit rgba of the actual color).
    grad.addColorStop(0, rgba(rgb, 1));
    grad.addColorStop(CORE_FRAC * 0.9, rgba(rgb, 0.9));
    grad.addColorStop(CORE_FRAC, rgba(rgb, 0.55));
    grad.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, dim, dim);
    return canvas;
  }
}
