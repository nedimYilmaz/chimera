// AUDIT-4: minimal structured logging so best-effort .catch(() => {}) sites stop
// discarding errors silently. Writes one JSON line per call to stderr (daemon's
// existing console.error channel) so it shows up in daemon stdout/stderr without
// a new log file or dependency.
export type LogLevel = "error" | "warn" | "info";

export function log(level: LogLevel, component: string, message: string, context?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, component, message };
  if (context) entry.context = context;
  console.error(JSON.stringify(entry));
}

export function logError(component: string, message: string, err: unknown, context?: Record<string, unknown>): void {
  log("error", component, message, { ...context, error: describeError(err) });
}

/** What to write for a thrown value, whatever shape it has.
 *
 *  The `instanceof Error` arm alone MISSES the most common error this daemon logs: Engine.handle()
 *  normalizes everything it throws into a plain `{code, message}` object (server.ts extracts it
 *  the same way one line below its own logError call), and a plain object hits String() and
 *  renders "[object Object]". Every RPC handler failure therefore reached the log with its reason
 *  erased — a rejected schema logged the fact that something threw and nothing about what. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.message === "string") return typeof e.code === "string" ? `${e.code}: ${e.message}` : e.message;
    try { return JSON.stringify(err); } catch { return String(err); }   // cyclic/unserializable
  }
  return String(err);
}
