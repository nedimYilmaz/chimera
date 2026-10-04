// RPC-ERROR-TEXT — rpcCall/invoke rejections carry the daemon's own
// `{code,message}` shape (see rpc/bridge.ts's rpcCall doc comment), never a
// JS Error instance. `err instanceof Error ? err.message : String(err)`
// degrades to the literal string "[object Object]" for every one of those —
// the single most common failure a user actually hits (a dead queue, a
// permission error, a transient daemon fault). Extract `.message` off any
// object shape before falling back to String().
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
