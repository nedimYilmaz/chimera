import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";
import { Panel } from "./Panel";
import { isEditableTarget } from "../keymap";
import styles from "./ErrorBoundary.module.css";

// DEFENSE-IN-DEPTH: a render crash inside a subtree (React itself flagged the
// missing boundary in the console during the TranscriptPanel churn repro) used
// to throw all the way to the root and UNMOUNT the whole tree — the window went
// blank ([data-transcript-body] gone, bodyTextLen 0). A boundary catches the
// throw during React's commit phase and swaps the crashed subtree for a compact
// token-styled fallback, so the rest of the app (top bar, left rail, composer)
// keeps rendering. Generic + reusable: wrap ANY pane, pass a label/message.
//
// Recovery: mount the boundary with a `key` that changes when the underlying
// subject changes (AgentsScreen keys it by agentKey) — React fully remounts a
// keyed element when its key flips, which discards the error state and retries
// the render. `press r` (or the retry button) resets IN PLACE for the same key.

/** Pure derived-state reducer — the only branch worth unit-testing (the class
 * render itself is not, per repo convention). Normalizes whatever was thrown
 * (React can throw a non-Error) into a real Error so the fallback always has a
 * `.message`. Mirrors what `getDerivedStateFromError` commits. */
export function nextBoundaryStateFromError(error: unknown): { error: Error } {
  return { error: error instanceof Error ? error : new Error(String(error)) };
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Panel label for the fallback frame (defaults to a generic "error"). */
  label?: ReactNode;
  /** Fallback body copy (English). */
  message?: string;
  /** Side-channel notice hook — the caller wires the app's notice/error line
   * (console logging is unconditional and lives in the boundary). */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Recreate a failed asynchronous child before retrying (for example React.lazy). */
  onRetry?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return nextBoundaryStateFromError(error);
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console channel is always-on (React's own suggestion); the notice channel
    // is the caller's to route so the boundary stays store-agnostic.
    console.error("[ErrorBoundary] render crash contained", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private reset = (): void => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorFallback label={this.props.label} message={this.props.message} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}

// Functional fallback so it can own an `r`-to-retry key listener via a hook.
// Capture-phase + stop so the retry key wins over any global `r` binding while
// the fallback is the visible surface for this pane.
function ErrorFallback({
  label,
  message,
  onRetry,
}: {
  label?: ReactNode;
  message?: string;
  onRetry: () => void;
}) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isEditableTarget(ev.target)) return;
      if (ev.key === "r") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        onRetry();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onRetry]);

  return (
    <Panel label={label ?? "error"} className={styles.panel}>
      <div className={styles.body}>
        <span className={styles.message}>{message ?? "this pane failed to render"}</span>
        <button type="button" className={styles.retry} onClick={onRetry}>
          press <kbd className={styles.kbd}>r</kbd> to retry
        </button>
      </div>
    </Panel>
  );
}
