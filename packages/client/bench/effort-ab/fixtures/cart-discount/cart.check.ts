import { describe, it, expect } from "vitest";
import { cartTotal } from "./cart.js";

describe("cartTotal", () => {
  it("charges a flat shipping fee below the free-shipping threshold", () => {
    expect(cartTotal([{ name: "widget", priceCents: 1000, qty: 2 }], 20)).toBe(2100);
  });

  it("waives shipping at or above the free-shipping threshold", () => {
    expect(cartTotal([{ name: "gadget", priceCents: 6000, qty: 1 }], 0)).toBe(6000);
  });

  it("rounds a discounted line total half up, not down", () => {
    // 105 cents at 1% off = 103.95 -> should round to 104, not truncate to 103.
    expect(cartTotal([{ name: "widget", priceCents: 105, qty: 1 }], 1)).toBe(604);
  });

  it("rounds every line independently before summing, half up", () => {
    // 133c at 1% off = 131.67 -> 132; 107c at 1% off = 105.93 -> 106.
    const items = [
      { name: "a", priceCents: 133, qty: 1 },
      { name: "b", priceCents: 107, qty: 1 },
    ];
    expect(cartTotal(items, 1)).toBe(738);
  });
});
