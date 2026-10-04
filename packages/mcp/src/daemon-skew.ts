// MCP-DAEMON-SKEW: this MCP binary is spawned fresh from the MAIN checkout for every agent
// (claude.ts/codex.ts resolve it from current main), so it always runs CURRENT protocol code --
// but the long-running chimerad it talks to may be an OLDER build whose `.strict()` params
// schemas (packages/protocol/src/index.ts) don't know about a field this binary's newer
// MCP_TOOL_TABLE now stamps in (e.g. memory_search's agentId, added by F34.1). The daemon
// can't be restarted out from under other teams' live agents, so instead of every such landing
// permanently breaking older daemons, strip the field the daemon doesn't recognize and retry --
// the daemon's schema is the contract of record; this is a client-side compatibility shim only.

const UNRECOGNIZED_KEY_RE = /^Unrecognized keys?: (.+)$/;

export const isProtocolError = (e: unknown): e is { code: "protocol"; message: string } =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "protocol" &&
  typeof (e as { message?: unknown }).message === "string";

// Parses zod 4's `.strict()` violation message -- singular "Unrecognized key: \"a\"" or plural
// "Unrecognized keys: \"a\", \"b\"" -- and returns which of those keys are actually present in
// `params` (top-level only; a nested object's own rejected key would misreport as this call's
// own param and get silently dropped from the wrong place, so this never recurses).
export const parseUnrecognizedKeys = (message: string, params: unknown): string[] | null => {
  const m = UNRECOGNIZED_KEY_RE.exec(message);
  if (!m || typeof params !== "object" || params === null) return null;
  const keys = [...m[1].matchAll(/"([^"]+)"/g)].map((mm) => mm[1]);
  const present = keys.filter((k) => k in (params as Record<string, unknown>));
  return present.length > 0 ? present : null;
};

export type DispatchDeps = {
  request: (method: string, params: unknown) => Promise<unknown>;
  isClosed: () => boolean;
  reconnect: () => Promise<void>;
  isDisconnected: (e: unknown) => boolean;
  warn: (message: string) => void;
};

// Bounded to 3 strip-rounds in case an older daemon rejects several stamped fields one at a
// time (zod reports all unrecognized keys per object in one issue, but a future daemon build
// could still reject a second, unrelated field after the first strip). After the bound, the
// last protocol error propagates as-is rather than retrying forever.
const MAX_STRIP_ROUNDS = 3;

export function createDispatch(deps: DispatchDeps) {
  const warnedSkew = new Set<string>();
  return async function dispatch(method: string, params: unknown): Promise<unknown> {
    let effectiveParams = params;
    for (let round = 0; ; round++) {
      try {
        if (deps.isClosed()) await deps.reconnect();  // lazily catch a drop that happened between calls
        return await deps.request(method, effectiveParams);
      } catch (e) {
        if (deps.isDisconnected(e)) {
          await deps.reconnect();
          return await deps.request(method, effectiveParams); // retry exactly once
        }
        const stripped = round < MAX_STRIP_ROUNDS && isProtocolError(e)
          ? parseUnrecognizedKeys(e.message, effectiveParams)
          : null;
        if (!stripped) throw e;                        // any other error, or bound exhausted -- no retry
        for (const k of stripped) {
          const flag = `${method} ${k}`;
          if (!warnedSkew.has(flag)) {
            warnedSkew.add(flag);
            deps.warn(
              `chimera-mcp: daemon rejected "${k}" for ${method} — older daemon, retrying without it ` +
              `(restart the daemon to get the new behaviour)`,
            );
          }
        }
        effectiveParams = Object.fromEntries(
          Object.entries(effectiveParams as Record<string, unknown>).filter(([k]) => !stripped.includes(k)),
        );
      }
    }
  };
}
