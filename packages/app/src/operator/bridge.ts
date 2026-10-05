export type OperatorSession = { csrf: string; project: string; scope: "read" | "control"; expiresAt: number };
export class SessionExpired extends Error { constructor(message = "Session expired or revoked. Pair again from the desktop.") { super(message); } }
export interface OperatorTransport {
  restore(): Promise<OperatorSession>;
  pair(code: string, deviceLabel: string, scope: "read" | "control"): Promise<OperatorSession>;
  snapshot<T>(): Promise<T>;
  rpc<T>(method: string, params: unknown): Promise<T>;
  logout(): Promise<void>;
  events(changed: () => void, interrupted: () => void): () => void;
}
// The browser never sees its session cookie. CSRF is not an authentication
// credential, remains memory-only and is reacquired from /session on reload.
export function createOperatorTransport(fetcher: typeof fetch = fetch, eventSource: typeof EventSource = EventSource): OperatorTransport {
  let session: OperatorSession | null = null;
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetcher(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: body === undefined ? {} : { "Content-Type": "application/json", ...(session ? { "X-Chimera-CSRF": session.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status === 401) { session = null; throw new SessionExpired(); }
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Panel request failed");
      return result as T;
    } finally { clearTimeout(timer); }
  };
  return {
    restore: async () => session = await call<OperatorSession>("/session"),
    pair: async (code, deviceLabel, scope) => session = await call<OperatorSession>("/pair", { code, deviceLabel, scope }),
    snapshot: () => call("/snapshot"),
    rpc: async (method, params) => { const result = await call<{ result: unknown }>("/rpc", { id: crypto.randomUUID(), method, params }); return result.result as never; },
    logout: async () => { await call("/logout", {}); session = null; },
    events: (changed, interrupted) => { const source = new eventSource("/events"); source.addEventListener("changed", changed); source.onerror = () => { source.close(); interrupted(); }; return () => source.close(); },
  };
}
