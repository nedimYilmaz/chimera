export type Interval = { start: number; end: number }; // start <= end, same units throughout

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function hasConflict(existing: Interval[], candidate: Interval): boolean {
  return existing.some((m) => overlaps(m, candidate));
}
