import { applyPercentOff } from "./money.js";

export type LineItem = { name: string; priceCents: number; qty: number };

export function discountedLineTotal(item: LineItem, percentOff: number): number {
  const lineTotal = item.priceCents * item.qty;
  return applyPercentOff(lineTotal, percentOff);
}
