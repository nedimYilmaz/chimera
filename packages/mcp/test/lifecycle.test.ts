import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpLifecycle, STARTUP_INPUT_HIGH_WATER_MARK, type DaemonConnection } from "../src/lifecycle.js";
import { createDispatch } from "../src/daemon-skew.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(connect = vi.fn(async () => connection())) {
  const stdin = new PassThrough(), signals = new EventEmitter();
  const onSignal = vi.fn(), onError = vi.fn(), closeInput = vi.fn(() => stdin.destroy());
  const lifecycle = createMcpLifecycle({ connect, stdin, signals, onSignal, onError, closeInput });
  return { lifecycle, stdin, signals, connect, onSignal, onError, closeInput };
}

function connection(): DaemonConnection & { close: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> } {
  return { closed: false, close: vi.fn(), request: vi.fn(async () => "ok") };
}

describe("MCP lifetime ownership", () => {
  it("bounds startup flow with backpressure and drains buffered bytes intact", async () => {
    const input = new PassThrough({ highWaterMark: STARTUP_INPUT_HIGH_WATER_MARK });
    const chunk = Buffer.alloc(STARTUP_INPUT_HIGH_WATER_MARK, 0x61);
    expect(input.write(chunk)).toBe(false);
    expect(input.readableLength).toBe(chunk.length);
    expect(input.writableLength).toBe(chunk.length);
    const drain = new Promise<void>(resolve => input.once("drain", resolve));
    expect(input.read()).toEqual(chunk);
    await drain;
    expect(input.readableLength).toBe(0);
    expect(input.writableLength).toBe(0);
    input.destroy();
  });
  it.each(["end", "close", "error", "SIGINT", "SIGTERM"])("%s shuts down once and rejects dispatch without redialing", async (event) => {
    const client = connection(), f = setup(vi.fn(async () => client));
    await f.lifecycle.reconnect();
    const dispatch = createDispatch({ ...f.lifecycle, isDisconnected: e => (e as { code: string }).code === "disconnected", warn: vi.fn() });
    (event.startsWith("SIG") ? f.signals : f.stdin).emit(event);
    expect(f.lifecycle.closing).toBe(true);
    await expect(dispatch("daemon.status", {})).rejects.toMatchObject({ code: "closing" });
    await f.lifecycle.shutdown();
    await f.lifecycle.shutdown();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.request).not.toHaveBeenCalled();
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.closeInput).toHaveBeenCalledTimes(1);
    expect(f.stdin.listenerCount("end")).toBe(0);
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("keeps an open peer usable and shares simultaneous reconnects", async () => {
    const pending = deferred<DaemonConnection>(), client = connection();
    const f = setup(vi.fn(() => pending.promise));
    const a = f.lifecycle.reconnect(), b = f.lifecycle.reconnect();
    expect(a).toBe(b);
    pending.resolve(client);
    await a;
    expect(await f.lifecycle.request("daemon.status", {})).toBe("ok");
    expect(client.close).not.toHaveBeenCalled();
    await f.lifecycle.shutdown();
  });

  it.each(["startup", "reconnect"])("closes a late %s result and never installs or requests it", async (phase) => {
    const old = connection(), late = connection(), pending = deferred<DaemonConnection>();
    const connect = vi.fn(async () => old);
    const f = setup(connect);
    if (phase === "reconnect") await f.lifecycle.reconnect();
    connect.mockImplementationOnce(() => pending.promise);
    const dial = f.lifecycle.reconnect();
    const rejected = expect(dial).rejects.toMatchObject({ code: "closing" });
    f.stdin.emit("end");
    await f.lifecycle.shutdown();
    pending.resolve(late);
    await rejected;
    await expect(f.lifecycle.request("daemon.status", {})).rejects.toMatchObject({ code: "closing" });
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(late.request).not.toHaveBeenCalled();
    expect(old.close).toHaveBeenCalledTimes(phase === "reconnect" ? 1 : 0);
  });

  it("does not dial when input was already destroyed", async () => {
    const stdin = new PassThrough(); stdin.destroy();
    const connect = vi.fn(async () => connection());
    const lifecycle = createMcpLifecycle({ connect, stdin, signals: new EventEmitter(), closeInput: vi.fn(), onSignal: vi.fn(), onError: vi.fn() });
    await expect(lifecycle.reconnect()).rejects.toMatchObject({ code: "closing" });
    await lifecycle.shutdown();
    expect(connect).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous EOF, signals, transport close and explicit shutdown", async () => {
    const client = connection(), f = setup(vi.fn(async () => client));
    const transport = { onclose: undefined as (() => void) | undefined, close: vi.fn(async () => transport.onclose?.()) };
    f.lifecycle.bindTransport(transport);
    await f.lifecycle.reconnect();
    f.stdin.emit("end");
    f.signals.emit("SIGINT");
    f.signals.emit("SIGTERM");
    const a = f.lifecycle.shutdown(), b = f.lifecycle.shutdown();
    expect(a).toBe(b);
    await a;
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(f.onSignal).not.toHaveBeenCalled();
  });

  it.each(["owner", "transport"])("preserves SDK protocol close notification during %s close", async (origin) => {
    const f = setup(), transport = new StdioServerTransport(f.stdin, new PassThrough());
    const earlier = vi.fn(); transport.onclose = earlier;
    f.lifecycle.bindTransport(transport);
    const server = new Server({ name: "lifecycle-test", version: "1" });
    const protocolClose = vi.fn(); server.onclose = protocolClose;
    await server.connect(transport);
    await f.lifecycle.reconnect();
    if (origin === "owner") await f.lifecycle.shutdown();
    else { await server.close(); await f.lifecycle.shutdown(); }
    expect(earlier).toHaveBeenCalledTimes(1);
    expect(protocolClose).toHaveBeenCalledTimes(1);
    expect(server.transport).toBeUndefined();
  });
});
