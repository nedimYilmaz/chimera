// Event-driven refetches fire once per coordination event, and those arrive in bursts. Running a
// round per event stacks overlapping rounds of the same request; dropping calls while one is in
// flight (the plain inFlight-flag pattern) loses the last event's change. This keeps at most one
// round in flight and folds every call made meanwhile into ONE trailing round.
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let trailing: Promise<void> | null = null;
  const start = (): Promise<void> => {
    current = run().finally(() => { current = null; });
    return current;
  };
  return () => {
    if (!current) return start();
    // A failed round still owes the trailing caller a fresh attempt; its error stays its own.
    trailing ??= current.catch(() => {}).then(() => { trailing = null; return start(); });
    return trailing;
  };
}
