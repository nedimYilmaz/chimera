import { lazy, Suspense, useMemo, useState, type ComponentType } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

/** Each route owns recovery; a rejected chunk must never take down app chrome. */
export function lazyScreen(load: () => Promise<{ default: ComponentType }>): ComponentType {
  return function RecoverableScreen() {
    const [attempt, setAttempt] = useState(0);
    // React.lazy caches rejection. Resetting only the boundary would throw it again
    // forever; an explicit retry must create a fresh wrapper and invoke the loader.
    const Screen = useMemo(() => lazy(load), [attempt]);
    return <ErrorBoundary key={attempt} label="screen unavailable"
      message="This screen could not load. Retry, or choose another tab. Your drafts are kept."
      onRetry={() => setAttempt(value => value + 1)}>
      <Suspense fallback={<div role="status">Loading screen…</div>}><Screen /></Suspense>
    </ErrorBoundary>;
  };
}
