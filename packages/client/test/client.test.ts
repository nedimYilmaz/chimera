import { describe, it, expect, afterAll } from "vitest";
import { createServer } from "node:net";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";
import { encodeFrame, decodeFrames, type NormalizedEvent, type RpcRequest } from "@chimera/protocol";
import { makeEngineHome } from "../../core/test/helpers.js";

const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };

describe("ChimeraClient", () => {
  afterAll(async () => {
    const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
    await c?.request("daemon.stop").catch(() => {});
    c?.close();
  });

  it("autostarts the daemon, round-trips a spawn, and streams events", async () => {
    const client = await ChimeraClient.connect({ home, env });
    const events: string[] = [];
    const unsub = await client.subscribe({}, (e) => { events.push(e.kind); });

    const rec = await client.request<{ agentId: string }>("agent.spawn", { spec: { prompt: "ping", cwd: "/tmp", isolation: "none" } });
    const final = await client.request<{ state: string; resultText: string }>("agent.wait", { agentId: rec.agentId, timeoutMs: 5000 });
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("fake:ping");
    expect(events).toContain("result");

    unsub();
    const second = await ChimeraClient.connect({ home, env, autostart: false });   // daemon reused, no autostart needed
    expect((await second.request<{ protocolVersion: number }>("daemon.status")).protocolVersion).toBe(1);
    second.close();
    client.close();
  }, 20_000);

  it("rejects typed errors", async () => {
    const client = await ChimeraClient.connect({ home, env });
    await expect(client.request("agent.status", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    client.close();
  }, 20_000);

  // ---------- additional coverage beyond the brief's two example tests ----------

  it("round-trips a multi-byte UTF-8 prompt through spawn+wait (StringDecoder reassembly)", async () => {
    // the daemon is already up (started by the first test, reused via autostart:false
    // elsewhere) — this proves a non-ASCII agent result survives the client's own
    // frame-buffer reassembly, not just the daemon's.
    const client = await ChimeraClient.connect({ home, env, autostart: false });
    const prompt = "こんにちは世界";
    const rec = await client.request<{ agentId: string }>("agent.spawn", { spec: { prompt, cwd: "/tmp", isolation: "none" } });
    const final = await client.request<{ state: string; resultText: string }>("agent.wait", { agentId: rec.agentId, timeoutMs: 5000 });
    expect(final.state).toBe("done");
    expect(final.resultText).toBe(`fake:${prompt}`);
    client.close();
  }, 20_000);

  it("connect({autostart:false}) rejects when no daemon is running at home", async () => {
    expect.assertions(1);
    const freshHome = makeEngineHome();
    const freshEnv = { ...process.env, CHIMERA_HOME: freshHome, CHIMERA_BACKEND: "fake" };
    await expect(ChimeraClient.connect({ home: freshHome, env: freshEnv, autostart: false })).rejects.toThrow();
  });

  it("reassembles an event frame whose multi-byte UTF-8 char is split across two socket writes", async () => {
    // A minimal fake daemon that completes the handshake, then pushes an event frame
    // whose 3-byte '世' is split across two writes. Only the per-connection StringDecoder
    // (not per-chunk toString) can reassemble it — this is the real client-side guard for
    // the chunk-boundary fix; the spawn+wait round-trip above rarely forces a split.
    const fakeHome = makeEngineHome();
    const socketPath = join(fakeHome, "daemon.sock");
    const server = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const { frames, rest } = decodeFrames(buf); buf = rest;
        for (const f of frames) {
          const req = f as RpcRequest;
          if (req.type !== "request") continue;
          if (req.method === "daemon.hello") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
          } else if (req.method === "subscribe") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true } }));
            const event: NormalizedEvent = { ts: 1, seq: 1, engineId: "local", agentId: "a1", kind: "result", data: { text: "こんにちは世界" } };
            const bytes = Buffer.from(encodeFrame({ type: "event", event }), "utf8");
            const cut = bytes.indexOf(Buffer.from("世", "utf8")) + 1; // split the 3-byte '世' after its first byte
            sock.write(bytes.subarray(0, cut));
            setTimeout(() => sock.write(bytes.subarray(cut)), 20);    // second write completes the char + the frame
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const client = await ChimeraClient.connect({ home: fakeHome, env, autostart: false });
      const received: NormalizedEvent[] = [];
      await client.subscribe({}, (e) => { received.push(e); });
      const deadline = Date.now() + 2000;
      while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(received[0]?.data.text).toBe("こんにちは世界"); // intact despite the mid-character split
      client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("flags .closed once the socket dies, so a long-lived caller can detect staleness before issuing a new request", async () => {
    // Regression guard for the MCP server's reconnect-on-demand fix: a caller that
    // holds a ChimeraClient across many requests needs to know the connection is
    // dead BEFORE writing to it (a write to an already-closed socket never
    // resolves), not just react to a rejected in-flight request.
    const fakeHome = makeEngineHome();
    const socketPath = join(fakeHome, "daemon.sock");
    let accepted: import("node:net").Socket | undefined;
    const server = createServer((sock) => {
      accepted = sock;
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const { frames, rest } = decodeFrames(buf); buf = rest;
        for (const f of frames) {
          const req = f as RpcRequest;
          if (req.type === "request" && req.method === "daemon.hello") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const client = await ChimeraClient.connect({ home: fakeHome, env, autostart: false });
      expect(client.closed).toBe(false);
      accepted?.destroy(); // drop the connection from the daemon side
      await new Promise((r) => setTimeout(r, 50)); // let the client's own 'close' handler run
      expect(client.closed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("request() issued AFTER the socket is already closed rejects promptly instead of hanging forever", async () => {
    // A caller that forgets to check `.closed` (like every cli.ts call site) writes
    // straight to a dead socket. Node's write-after-destroy doesn't reliably re-fire
    // the 'error'/'close' listeners that drive fail(), so without an explicit guard
    // in request() itself, the returned promise never settles -- this is the gap the
    // `.closed` getter's comment warns about but does not close on its own.
    const fakeHome = makeEngineHome();
    const socketPath = join(fakeHome, "daemon.sock");
    let accepted: import("node:net").Socket | undefined;
    const server = createServer((sock) => {
      accepted = sock;
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const { frames, rest } = decodeFrames(buf); buf = rest;
        for (const f of frames) {
          const req = f as RpcRequest;
          if (req.type === "request" && req.method === "daemon.hello") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const client = await ChimeraClient.connect({ home: fakeHome, env, autostart: false });
      accepted?.destroy();
      await new Promise((r) => setTimeout(r, 50)); // let the client's own 'close' handler run
      expect(client.closed).toBe(true);
      const timedOut = Symbol("timeout");
      const result = await Promise.race([
        client.request("agent.status", { agentId: "x" }).catch((e) => e),
        new Promise((resolve) => setTimeout(() => resolve(timedOut), 500)),
      ]);
      expect(result).not.toBe(timedOut);
      expect(result).toMatchObject({ code: "disconnected" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("rejects in-flight requests with {code:'disconnected'} when the daemon drops the connection mid-call", async () => {
    // Handshake succeeds, then the daemon vanishes while a request is pending.
    // Only the sock 'error'/'close' -> fail() cleanup can settle it; without it the
    // caller's await hangs forever. (Regression guard for the pending-reject handler.)
    expect.assertions(1);
    const fakeHome = makeEngineHome();
    const socketPath = join(fakeHome, "daemon.sock");
    const server = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const { frames, rest } = decodeFrames(buf); buf = rest;
        for (const f of frames) {
          const req = f as RpcRequest;
          if (req.type !== "request") continue;
          if (req.method === "daemon.hello") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
          } else {
            sock.destroy(); // drop the connection instead of answering the pending request
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const client = await ChimeraClient.connect({ home: fakeHome, env, autostart: false });
      await expect(client.request("agent.status", { agentId: "x" })).rejects.toMatchObject({ code: "disconnected" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  // ---------- TYPED-CLIENT-SDK ----------

  it("deterministic full-boot blackbox: client.queue.* family-group sugar round-trips a real task through the fake daemon", async () => {
    // Real daemon (CHIMERA_BACKEND=fake), real socket, no RPC-layer mocking — proves the
    // generated family groups produce byte-identical wire behavior to request()/call(), not
    // just that the types compile.
    const client = await ChimeraClient.connect({ home, env });
    const queueName = `typed-sdk-${Date.now()}`;
    const spec = await client.queue.create({ spec: { name: queueName } });
    expect(spec.name).toBe(queueName);
    const task = await client.queue.push({ queue: queueName, prompt: "typed sdk round trip" });
    expect(task.queue).toBe(queueName);
    const status = await client.queue.status({ queue: queueName });
    expect(status.tasks.map((t) => t.taskId)).toContain(task.taskId);
    client.close();
  }, 20_000);

  it("call(...,{validateResponse:true}) is genuinely opt-in: off by default, catches a malformed response when enabled", async () => {
    // Raw fake daemon (same pattern as the reassembly/disconnect tests above) that answers
    // queue.status with a response missing required fields (counts/tasks).
    const fakeHome = makeEngineHome();
    const socketPath = join(fakeHome, "daemon.sock");
    const server = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const { frames, rest } = decodeFrames(buf); buf = rest;
        for (const f of frames) {
          console.error("DEBUG server got", JSON.stringify(f));
          const req = f as RpcRequest;
          if (req.type !== "request") continue;
          if (req.method === "daemon.hello") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
          } else if (req.method === "queue.status") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { spec: { name: "q" } } }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const client = await ChimeraClient.connect({ home: fakeHome, env, autostart: false });
      // No opts: resolves fine — validation never runs, zero behavior change from before this
      // feature existed.
      await expect(client.call("queue.status", { queue: "q" })).resolves.toMatchObject({ spec: { name: "q" } });
      // Opted in: the same malformed response is now caught.
      await expect(client.call("queue.status", { queue: "q" }, { validateResponse: true }))
        .rejects.toMatchObject({ code: "protocol" });
      client.close();   // release the socket so server.close()'s callback below can actually fire
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
