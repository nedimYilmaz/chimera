import { describe, expect, it, vi } from "vitest";
import { CORE_FRAC, GlowSpriteCache, parseRgb, type CanvasLike } from "../src/memory-graph/sprites";

// a fake 2D context / canvas so the cache renders without a DOM
function fakeCanvas(): CanvasLike {
  const ctx = {
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    fillRect: vi.fn(),
    set fillStyle(_v: unknown) {},
  } as unknown as CanvasRenderingContext2D;
  return { width: 0, height: 0, getContext: () => ctx };
}

describe("memory-graph sprites", () => {
  it("parseRgb handles #rgb, #rrggbb, rgb(), rgba(), and rejects junk", () => {
    expect(parseRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseRgb("#9aa3f2")).toEqual({ r: 154, g: 163, b: 242 });
    expect(parseRgb("  #79C58C ")).toEqual({ r: 121, g: 197, b: 140 });
    expect(parseRgb("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseRgb("rgba(1 2 3 / 0.5)")).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseRgb("not-a-color")).toBeNull();
    expect(parseRgb("#12")).toBeNull();
  });

  it("destHalf scales the node radius past the sprite core fraction", () => {
    expect(GlowSpriteCache.destHalf(4)).toBeCloseTo(4 / CORE_FRAC, 6);
  });

  it("memoizes one sprite per color", () => {
    const factory = vi.fn(() => fakeCanvas());
    const cache = new GlowSpriteCache(factory);
    cache.get("#9aa3f2");
    cache.get("#9aa3f2"); // cached → no new canvas
    cache.get("#79c58c");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(2);
  });
});
