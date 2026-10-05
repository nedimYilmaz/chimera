import { expect, it, vi } from "vitest";
import { createOperatorTransport, SessionExpired } from "../src/operator/bridge";
const meta = { csrf: "csrf-only", project: "one", scope: "read", expiresAt: 9999999999999 };
it("uses cookie credentials with CSRF for actions, never auth in URLs or browser storage", async () => {
  const fetcher = vi.fn(async (_path, options) => new Response(JSON.stringify(options?.method === "POST" ? { result: { ok: true } } : meta), { status: 200 })) as unknown as typeof fetch;
  const bridge = createOperatorTransport(fetcher, class {} as unknown as typeof EventSource);
  await bridge.restore(); await bridge.rpc("agent.send", { agentId: "a", text: "hello" });
  const calls = vi.mocked(fetcher).mock.calls; expect(calls[0]?.[0]).toBe("/session");
  expect(calls[1]?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store", method: "POST", headers: { "X-Chimera-CSRF": "csrf-only" } });
  expect(calls[1]?.[0]).toBe("/rpc"); expect(JSON.stringify(calls)).not.toContain("Bearer");
});
it("distinguishes revocation/expiry and clears CSRF rather than silently retrying actions", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(meta))).mockResolvedValue(new Response('{"error":"expired"}', { status: 401 })) as unknown as typeof fetch;
  const bridge = createOperatorTransport(fetcher, class {} as unknown as typeof EventSource); await bridge.restore();
  await expect(bridge.rpc("queue.pause", { queue: "q" })).rejects.toBeInstanceOf(SessionExpired);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("closes interrupted SSE and returns a disposer", () => {
  let source: { close: ReturnType<typeof vi.fn>; onerror: (() => void) | null };
  class Source { close = vi.fn(); onerror = null; addEventListener = vi.fn(); constructor(path: string) { expect(path).toBe("/events"); source = this; } }
  const bridge = createOperatorTransport(vi.fn() as unknown as typeof fetch, Source as unknown as typeof EventSource);
  const interrupted = vi.fn(); const off = bridge.events(vi.fn(), interrupted); source!.onerror!(); expect(interrupted).toHaveBeenCalledOnce(); off(); expect(source!.close).toHaveBeenCalledTimes(2);
});
