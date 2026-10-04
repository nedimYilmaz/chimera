import { LineItem, discountedLineTotal } from "./discount.js";

const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
const SHIPPING_FEE_CENTS = 500;

export function cartTotal(items: LineItem[], percentOff: number): number {
  const subtotal = items.reduce((sum, item) => sum + discountedLineTotal(item, percentOff), 0);
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_FEE_CENTS;
  return subtotal + shipping;
}
