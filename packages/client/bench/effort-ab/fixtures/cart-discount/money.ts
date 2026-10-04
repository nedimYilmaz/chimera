// All amounts are integer cents. Percentages are integers 0-100.
export function applyPercentOff(amountCents: number, percentOff: number): number {
  // Round HALF UP (0.5 rounds away from zero) so a discount never costs the
  // merchant more than the stated percentage implies.
  const kept = amountCents * (100 - percentOff);
  return Math.floor(kept / 100);
}
