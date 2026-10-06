import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";

// A flow-control threshold, not a truncation limit: pipes pause their source when
// the buffer fills. One incoming chunk can overshoot it without losing bytes.
export const STARTUP_INPUT_HIGH_WATER_MARK = 64 * 1024;

export type DaemonConnection = {
  readonly closed: boolean;
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
};

type Transport = { onclose?: () => void; close(): Promise<void> };

// Client.close sends FIN, not destroy. Natural exit depends on the daemon returning FIN;
// this owner never unrefs the socket or forces process.exit to hide a retained connection.
export function createMcpLifecycle(options: {
  connect(): Promise<DaemonConnection>;
  stdin: Readable;
  signals: EventEmitter;
  closeInput(): void;
  onSignal(signal: "SIGINT" | "SIGTERM"): void;
  onError(error: unknown): void;
}) {
  let closing = false;
  let client: DaemonConnection | undefined;
  let connecting: Promise<void> | undefined;
  let transport: Transport | undefined;
  let transportClosed = false;
  let shutdownPromise: Promise<void> | undefined;
  const closedError = () => ({ code: "closing", message: "chimera-mcp is shutting down" });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    // Set the guard before closing the transport: its onclose can synchronously reenter.
    closing = true;
    shutdownPromise = Promise.resolve().then(async () => {
      options.stdin.off("end", onEnd);
      options.stdin.off("close", onEnd);
      options.stdin.off("error", onEnd);
      options.signals.off("SIGINT", onInt);
      options.signals.off("SIGTERM", onTerm);
      const owned = client;
      client = undefined;
      try { owned?.close(); } catch (error) { options.onError(error); }
      options.closeInput();
      try { if (!transportClosed) await transport?.close(); } catch (error) { options.onError(error); }
    });
    return shutdownPromise;
  };
  const onEnd = () => { void shutdown(); };
  const onInt = () => { if (!closing) options.onSignal("SIGINT"); void shutdown(); };
  const onTerm = () => { if (!closing) options.onSignal("SIGTERM"); void shutdown(); };
  options.stdin.on("end", onEnd);
  options.stdin.on("close", onEnd);
  options.stdin.on("error", onEnd);
  options.signals.on("SIGINT", onInt);
  options.signals.on("SIGTERM", onTerm);
  if (options.stdin.readableEnded || options.stdin.destroyed) void shutdown();

  const reconnect = (): Promise<void> => {
    if (closing) return Promise.reject(closedError());
    if (!connecting) {
      connecting = options.connect().then((connected) => {
        if (closing) {
          connected.close();
          throw closedError();
        }
        const previous = client;
        client = connected;
        previous?.close();
      }).finally(() => { connecting = undefined; });
    }
    return connecting;
  };

  return {
    get closing() { return closing; },
    isClosed: () => closing || !client || client.closed,
    reconnect,
    request: (method: string, params: unknown): Promise<unknown> => {
      if (closing) return Promise.reject(closedError());
      if (!client) return Promise.reject({ code: "disconnected", message: "chimerad not connected" });
      return client.request(method, params);
    },
    bindTransport: (next: Transport) => {
      transport = next;
      const previous = next.onclose;
      // Install before Protocol.connect, which chains this hook with its own cleanup.
      next.onclose = () => {
        transportClosed = true;
        try { previous?.(); } finally { void shutdown(); }
      };
      if (closing) void next.close().catch(options.onError);
    },
    shutdown,
  };
}
