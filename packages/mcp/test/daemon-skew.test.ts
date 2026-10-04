import { describe, it, expect, vi } from "vitest";
import { createDispatch } from "../src/daemon-skew.js";

// Simulates the wire-level shape thrown by ChimeraClient.request() when the daemon's
// z.ZodError -> rpcError("protocol", ...) path (packages/core/src/engine.ts) rejects a
// `.strict()` object's unrecognized top-level key(s).
const protocolError = (message: string) => ({ code: "protocol", message });

describe("createDispatch (daemon version-skew shim)", () => {
  it("strips a rejected top-level key and retries once, warning exactly once", async () => {
    let calls = 0;
    const request = vi.fn(async (_method: string, params: unknown) => {
      calls++;
      if (calls === 1) throw protocolError('Unrecognized key: "agentId"');
      return { ok: true, params };
    });
    const warn = vi.fn();
    const dispatch = createDispatch({
      request,
      isClosed: () => false,
      reconnect: async () => {},
      isDisconnected: () => false,
      warn,
    });

    const result = await dispatch("memory.search", { query: "x", agentId: "a1" });

    expect(result).toEqual({ ok: true, params: { query: "x" } });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "memory.search", { query: "x", agentId: "a1" });
    expect(request).toHaveBeenNthCalledWith(2, "memory.search", { query: "x" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'chimera-mcp: daemon rejected "agentId" for memory.search — older daemon, retrying without it ' +
      "(restart the daemon to get the new behaviour)",
    );

    // A second call for the same (method, key) must not warn again.
    await dispatch("memory.search", { query: "y", agentId: "a1" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a protocol error that doesn't match the unrecognized-key format", async () => {
    const err = protocolError("some other validation failure");
    const request = vi.fn(async () => { throw err; });
    const dispatch = createDispatch({
      request,
      isClosed: () => false,
      reconnect: async () => {},
      isDisconnected: () => false,
      warn: vi.fn(),
    });

    await expect(dispatch("memory.search", { query: "x" })).rejects.toBe(err);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the round bound when params keep being rejected", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => {
      const keys = Object.keys(params as Record<string, unknown>);
      // Always reject whatever the first remaining key is, so it never converges.
      throw protocolError(`Unrecognized key: "${keys[0]}"`);
    });
    const dispatch = createDispatch({
      request,
      isClosed: () => false,
      reconnect: async () => {},
      isDisconnected: () => false,
      warn: vi.fn(),
    });

    await expect(dispatch("memory.search", { a: 1, b: 2, c: 3, d: 4 })).rejects.toMatchObject({
      code: "protocol",
    });
    // MAX_STRIP_ROUNDS = 3: rounds 0,1,2 each strip-and-retry, round 3 no longer qualifies
    // (round < 3 fails) so the 4th call's error propagates -- 4 calls total.
    expect(request).toHaveBeenCalledTimes(4);
  });
});
