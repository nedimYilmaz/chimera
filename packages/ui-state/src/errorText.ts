// Shared rpc-error → human-readable-string helper. The Tauri bridge (and the
// TUI's UDS client) reject with plain {code,message} objects, not Error
// instances, so `err instanceof Error ? err.message : String(err)` degrades
// to the literal string "[object Object]" for every rpc failure. Both UIs
// should route rpc catch blocks through this instead.
export function errorToText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    try {
      return JSON.stringify(err);
    } catch {
      // fall through to String(err) below
    }
  }
  return String(err);
}

// Phase 1's engine throws exactly rpcError("protocol", `unknown method "<m>"`) — locked text.
// Requiring the message too keeps genuine protocol errors from a Phase 2 daemon from being
// misread as "method not available" (PM decision D6). Moved here from createStore.ts so
// review-room's degraded-daemon check (evidence.get OK, review.get unknown-method) reuses the
// exact same classifier instead of pattern-matching error text again.
export function isUnknownMethod(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === "protocol" && typeof message === "string" && /unknown method/.test(message);
}
