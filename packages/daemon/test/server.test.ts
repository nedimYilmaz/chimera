import { describe, it, expect } from "vitest";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { encodeFrame, decodeFrames, type RpcFrame } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeEngineHome } from "../../core/test/helpers.js";

// RPC-FRAME-DEMUX: responses and pushed events share ONE socket, so "the next frame" is not
// "my response" — a subscribed client can have an event land between a request and its reply.
// This client matches a response by the id it sent and queues events separately, which is what
// makes a request/response pair deterministic. Reading the next frame blindly used to work only
// because nothing was pushed early enough to get in the way; it broke the moment spawn began
// emitting its registration event, and it would have broken again on any new one.
function rpcClient(socketPath: string) {
  const sock = createConnection(socketPath);
  let buf = "";
  const pending = new Map<string, (f: RpcFrame) => void>();
  const events: RpcFrame[] = []; const eventWaiters: Array<(f: RpcFrame) => void> = [];
  sock.on("data", (d) => {
    buf += d.toString();
    const { frames, rest } = decodeFrames(buf); buf = rest;
    for (const f of frames) {
      const settle = f.type === "response" ? pending.get(f.id) : undefined;
      if (settle) { pending.delete(f.id); settle(f); continue; }
      const w = eventWaiters.shift(); w ? w(f) : events.push(f);
    }
  });
  const next = () => new Promise<RpcFrame>((r) => { const f = events.shift(); f ? r(f) : eventWaiters.push(r); });
  let id = 0;
  const request = (method: string, params: unknown = {}) => new Promise<RpcFrame>((resolve) => {
    const rid = String(++id);
    pending.set(rid, resolve);
    sock.write(encodeFrame({ id: rid, type: "request", method, params }));
  });
  /** Every event frame that arrived and was not awaited, removing them from the queue — lets a
   *  test assert on what the server pushed instead of inferring it from frame ordering. */
  const drainEvents = () => events.splice(0);
  return { request, next, drainEvents, end: () => sock.end() };
}

describe("chimerad RPC server", () => {
  it("refuses to unlink a listening daemon and leaves it usable", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    try {
      await expect(startRpcServer({ socketPath, engine })).rejects.toThrow("already listening");
      const c = rpcClient(socketPath);
      expect(await c.request("daemon.hello", { protocolVersion: 1 })).toMatchObject({ ok: true });
      c.end();
    } finally { await server.close(); }
  });

  it("rejects malformed subscription parameters without crashing or changing capabilities", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    try {
      for (const params of [{ clientCaps: {} }, { clientCaps: "ui.components" }, { clientCaps: [12] }, { agentId: {} }]) {
        expect(await c.request("subscribe", params)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
      }
      expect(engine.hasClientCap("ui.components")).toBe(false);
      expect(await c.request("subscribe", { clientCaps: ["ui.components"] })).toMatchObject({ ok: true });
      expect(engine.hasClientCap("ui.components")).toBe(true);
    } finally { c.end(); await server.close(); }
  });
  it("serves hello/spawn/subscribe/wait/stop over the socket with 0600 perms", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([])]]) });
    let stopped = false;
    const server = await startRpcServer({ socketPath, engine, onStop: () => { stopped = true; } });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const c = rpcClient(socketPath);
    const hello = await c.request("daemon.hello", { protocolVersion: 1 });
    expect(hello).toMatchObject({ type: "response", ok: true });
    const badHello = await c.request("daemon.hello", { protocolVersion: 99 });
    expect(badHello).toMatchObject({ ok: false, error: { code: "protocol" } });

    const sub = await c.request("subscribe", {});
    expect(sub).toMatchObject({ ok: true });

    const spawned = await c.request("agent.spawn", { spec: { prompt: "hi", cwd: "/tmp", isolation: "none" } });
    expect(spawned).toMatchObject({ ok: true });
    const pushed = await c.next();                                  // first pushed event frame
    expect(pushed).toMatchObject({ type: "event" });

    const rec = (spawned as { result: { agentId: string } }).result;
    const waited = await c.request("agent.wait", { agentId: rec.agentId, timeoutMs: 2000 });
    expect(waited).toMatchObject({ type: "response", ok: true });

    const stop = await c.request("daemon.stop", {});
    expect(stop).toMatchObject({ ok: true });
    expect(stopped).toBe(true);
    c.end();
    await server.close();
  }, 15_000);
});

// ---------- additional coverage: every branch/edge in server.ts ----------

function makeEngine(scenarios: FakeStep[][] = []) {
  const home = makeEngineHome();
  const socketPath = join(home, "daemon.sock");
  const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend(scenarios)]]) });
  return { home, socketPath, engine };
}

// EVENT-FANOUT-ONE-ENCODE: each subscriber used to register its own engine listener and encode
// every event itself, so one event was stringified once PER CONNECTION. At the 11 live sockets
// measured on an operator's machine that is eleven identical stringifies of the same object, on
// the single thread that also answers every RPC — which is why every RPC was slow, not just one.
describe("event fan-out across many subscribers", () => {
  it("registers ONE engine listener no matter how many connections subscribe", async () => {
    const { socketPath, engine } = makeEngine();
    // Counting the engine-level subscriptions is the direct measure: the encode happens once per
    // listener invocation, so one listener for N sockets IS the fix, and any regression that
    // re-adds a per-connection closure fails here rather than silently costing throughput again.
    let engineSubscribes = 0;
    const realSubscribe = engine.events.subscribe.bind(engine.events);
    engine.events.subscribe = ((fn: Parameters<typeof realSubscribe>[0]) => { engineSubscribes++; return realSubscribe(fn); }) as typeof realSubscribe;

    const server = await startRpcServer({ socketPath, engine });
    const clients = [rpcClient(socketPath), rpcClient(socketPath), rpcClient(socketPath)];
    for (const c of clients) expect(await c.request("subscribe", {})).toMatchObject({ ok: true });
    expect(engineSubscribes).toBe(1);

    engine.events.append({ agentId: "a1", kind: "status", data: { hello: true } });
    for (const c of clients) {
      expect(await c.next()).toMatchObject({ type: "event", event: { agentId: "a1", kind: "status" } });
    }
    for (const c of clients) c.end();
    await server.close();
  });

  it("keeps each connection's own filter — one agent's stream never leaks into another's", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const all = rpcClient(socketPath);
    const onlyB = rpcClient(socketPath);
    await all.request("subscribe", {});
    await onlyB.request("subscribe", { agentId: "b" });

    engine.events.append({ agentId: "a", kind: "status", data: {} });
    engine.events.append({ agentId: "b", kind: "status", data: {} });
    // The filtered client's FIRST frame must be b's — if a's had leaked it would arrive first.
    expect(await onlyB.next()).toMatchObject({ event: { agentId: "b" } });
    expect(await all.next()).toMatchObject({ event: { agentId: "a" } });
    expect(await all.next()).toMatchObject({ event: { agentId: "b" } });
    all.end(); onlyB.end();
    await server.close();
  });

  it("REPLACES the filter on re-subscribe rather than merging", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    await c.request("subscribe", { agentId: "a" });
    await c.request("subscribe", { agentId: "b" });
    engine.events.append({ agentId: "a", kind: "status", data: {} });   // old filter — must NOT arrive
    engine.events.append({ agentId: "b", kind: "status", data: {} });
    expect(await c.next()).toMatchObject({ event: { agentId: "b" } });
    c.end();
    await server.close();
  });

  it("stops delivering to a connection that closed, leaving the others untouched", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const staying = rpcClient(socketPath);
    const leaving = rpcClient(socketPath);
    await staying.request("subscribe", {});
    await leaving.request("subscribe", {});
    leaving.end();
    await new Promise((r) => setTimeout(r, 50));   // let the close land

    engine.events.append({ agentId: "a1", kind: "status", data: {} });
    expect(await staying.next()).toMatchObject({ event: { agentId: "a1" } });
    staying.end();
    await server.close();
  });
});

// PERF-SPLIT-RTT: the app times its status ping around an await in the RENDERER, so a saturated
// renderer and a slow daemon produce the same "rtt 3007ms" and the operator cannot act on either.
// The daemon stamps what only the daemon can know, so the number splits into daemon / queue / ui.
describe("daemon.status carries where the time actually went", () => {
  it("stamps the engine's own handling time and the bytes queued ahead of the reply", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("daemon.status", {}) as { result: Record<string, unknown> };
    expect(typeof res.result["serverHandleMs"]).toBe("number");
    expect(res.result["serverHandleMs"] as number).toBeGreaterThanOrEqual(0);
    // Nothing was pushed on this connection, so the reply waited behind nothing. A non-zero value
    // here IS the head-of-line-blocking signal: events and responses share one socket, written
    // with no backpressure, so a burst puts the reply behind it.
    expect(res.result["socketQueuedBytes"]).toBe(0);
    c.end();
    await server.close();
  });

  it("stamps ONLY the status ping — no other caller's result shape changes", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("agent.list", {}) as { result: unknown };
    expect(JSON.stringify(res.result)).not.toContain("serverHandleMs");
    c.end();
    await server.close();
  });
});

describe("startRpcServer: socket lifecycle", () => {
  it("unlinks a stale socket file left behind by a dead daemon before listening", async () => {
    const { socketPath, engine } = makeEngine();

    // Node's net.Server unlinks its own unix-socket file on a graceful close(),
    // but a killed/crashed daemon (SIGKILL, hard crash) never gets that chance
    // and leaves the inode on disk. Rename before closing to retain a real
    // stale socket inode; a regular file is deliberately NOT safe to unlink.
    const oldPath = `${socketPath}.old`;
    const old = createServer();
    await new Promise<void>(resolve => old.listen(oldPath, resolve));
    renameSync(oldPath, socketPath);
    await new Promise<void>(resolve => old.close(() => resolve()));
    expect(existsSync(socketPath)).toBe(true);

    const server = await startRpcServer({ socketPath, engine });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const c = rpcClient(socketPath);
    const hello = await c.request("daemon.hello", { protocolVersion: 1 });
    expect(hello).toMatchObject({ ok: true });
    c.end();
    await server.close();
  });

  it("still reclaims a stale socket when boot work blocks the event loop past the probe timeout", async () => {
    // After an OOM crash the daemon restart-looped: boot work blocked the loop ~2s right after
    // the probe connected, the expired probe timer ran before the queued ECONNREFUSED, and every
    // restart exited on "Cannot establish whether the existing daemon endpoint is stale".
    // Runs in a plain Node child: the vitest worker happens to deliver the refusal first, so an
    // in-process version of this test passes even against the broken probe.
    const { socketPath } = makeEngine();
    const oldPath = `${socketPath}.old`;
    const old = createServer();
    await new Promise<void>(resolve => old.listen(oldPath, resolve));
    renameSync(oldPath, socketPath);
    await new Promise<void>(resolve => old.close(() => resolve()));

    const script = join(mkdtempSync(join(tmpdir(), "chimera-blocked-boot-")), "boot.mts");
    writeFileSync(script, [
      `import { startRpcServer } from ${JSON.stringify(fileURLToPath(new URL("../src/server.ts", import.meta.url)))};`,
      `const starting = startRpcServer({ socketPath: ${JSON.stringify(socketPath)}, engine: { events: { subscribe: () => () => {} } } as never });`,
      `const until = Date.now() + 1500; while (Date.now() < until) { /* synchronous boot work */ }`,
      `try { const s = await starting; console.log("started"); await s.close(); } catch (e) { console.log("failed: " + (e as Error).message); }`,
    ].join("\n"));
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdio: ["ignore", "pipe", "inherit"] });
      let text = ""; child.stdout.on("data", (d) => { text += d; });
      child.once("exit", () => resolve(text.trim()));
    });
    expect(out).toBe("started");
  }, 20_000);

  it("close() unlinks the socket file", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    expect(existsSync(socketPath)).toBe(true);
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("preserves a regular file mistakenly selected as the socket path", async () => {
    const { socketPath, engine } = makeEngine();
    writeFileSync(socketPath, "keep this data");
    await expect(startRpcServer({ socketPath, engine })).rejects.toThrow("non-socket");
    expect(readFileSync(socketPath, "utf8")).toBe("keep this data");
  });

  it("close() does not throw if the socket file was already removed externally", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    unlinkSync(socketPath); // simulate something else having cleaned it up already
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("rejects when the socket's parent directory does not exist", async () => {
    const { engine } = makeEngine();
    const badSocketPath = join(tmpdir(), `chimera-missing-dir-${Date.now()}`, "daemon.sock");
    await expect(startRpcServer({ socketPath: badSocketPath, engine })).rejects.toBeDefined();
  });
});

describe("daemon.hello", () => {
  it("rejects a missing protocolVersion as a mismatch (undefined !== PROTOCOL_VERSION)", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("daemon.hello", {});
    expect(res).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect((res as { error: { message: string } }).error.message.length).toBeGreaterThan(0);
    c.end();
    await server.close();
  });

  it("ignores unknown/extra params (engineId, features) and still succeeds on a version match", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("daemon.hello", { protocolVersion: 1, engineId: "peer-1", features: ["federation.v1"], somethingLater: 42 });
    expect(res).toMatchObject({ ok: true, result: { ok: true, protocolVersion: 1, engineId: "local", features: [] } });
    c.end();
    await server.close();
  });

  it("a failed hello does not break the connection: a later good hello still succeeds", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const bad = await c.request("daemon.hello", { protocolVersion: 2 });
    expect(bad).toMatchObject({ ok: false, error: { code: "protocol" } });
    const good = await c.request("daemon.hello", { protocolVersion: 1 });
    expect(good).toMatchObject({ ok: true });
    c.end();
    await server.close();
  });
});

describe("subscribe", () => {
  it("only pushes events for the filtered agentId, never for other agents on the same connection", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    const awaitScenario: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "done" } }];
    const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([awaitScenario, awaitScenario])]]) });
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    await c.request("daemon.hello", { protocolVersion: 1 });

    const specA = await c.request("agent.spawn", { spec: { prompt: "a", cwd: "/tmp", isolation: "none" } });
    const agentA = (specA as { result: { agentId: string } }).result.agentId;
    const specB = await c.request("agent.spawn", { spec: { prompt: "b", cwd: "/tmp", isolation: "none" } });
    const agentB = (specB as { result: { agentId: string } }).result.agentId;

    const sub = await c.request("subscribe", { agentId: agentA });
    expect(sub).toMatchObject({ ok: true });

    // complete B first: B is filtered OUT, so any event frame that shows up while
    // waiting on it (e.g. a still-pending agent_started for A) must never be B's.
    await c.request("agent.send", { agentId: agentB, text: "go-b" });
    const frameB = await c.request("agent.wait", { agentId: agentB, timeoutMs: 2000 });
    expect(frameB).toMatchObject({ ok: true });
    for (const f of c.drainEvents()) expect((f as { event: { agentId: string } }).event.agentId).not.toBe(agentB);

    // now complete A: filtered in, so we must observe at least one matching event frame
    await c.request("agent.send", { agentId: agentA, text: "go-a" });
    const frame = await c.request("agent.wait", { agentId: agentA, timeoutMs: 2000 });
    expect(frame).toMatchObject({ ok: true });
    const forA = c.drainEvents();
    expect(forA.length).toBeGreaterThan(0);
    for (const f of forA) expect((f as { event: { agentId: string } }).event.agentId).toBe(agentA);

    c.end();
    await server.close();
  }, 15_000);

  it("re-subscribing on the same connection replaces the previous subscription", async () => {
    const home = makeEngineHome();
    const socketPath = join(home, "daemon.sock");
    // Two independent awaitSend gates: nothing is emitted except in direct
    // response to an agent.send we issue ourselves. The old version of this
    // test opened with an ungated `{ emit: agent_started }` that fired off the
    // fake backend's bare `setTimeout(run, 0)` — under full-suite parallel
    // load that timer could fire in the tiny window between the two
    // "subscribe" round-trips and land an event frame where a response was
    // expected, failing intermittently. Gating every emit behind an explicit
    // send removes that race entirely: the scenario is provably parked at
    // gate 2 (emitting nothing) for the whole time we re-subscribe.
    const scenario: FakeStep[] = [
      { awaitSend: true },                 // gate 1: unblocked by the first agent.send below
      { awaitSend: true },                 // gate 2: unblocked by the second agent.send below
      { end: { resultText: "done" } },
    ];
    const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([scenario])]]) });
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    await c.request("daemon.hello", { protocolVersion: 1 });

    const spawned = await c.request("agent.spawn", { spec: { prompt: "solo", cwd: "/tmp", isolation: "none" } });
    const agentId = (spawned as { result: { agentId: string } }).result.agentId;

    const subAll = await c.request("subscribe", {}); // unfiltered: should catch everything
    expect(subAll).toMatchObject({ ok: true });

    // Prove subAll is genuinely live by AWAITING a real delivered event through
    // it, rather than assuming timing: unblock gate 1 and collect exactly the
    // ack + the events it triggers (their relative order is unspecified — only
    // that the events actually arrive matters). Phase 3: a successful send now
    // ALSO appends a status{delivered} event alongside the fake backend's own
    // message_complete, so gate 1 produces 3 frames total (ack + 2 events).
    const gate1Frames: RpcFrame[] = [
      await c.request("agent.send", { agentId, text: "gate1" }),
      await c.next(),
      await c.next(),
    ];
    const gate1Event = gate1Frames.find((f) => f.type === "event" && f.event.kind === "message_complete");
    expect(gate1Event).toMatchObject({ type: "event", event: { agentId, kind: "message_complete" } });

    // Now replace the subscription with a filter that can never match this agent.
    const subNone = await c.request("subscribe", { agentId: "bogus-id-that-never-matches" });
    expect(subNone).toMatchObject({ ok: true });

    // Unblock gate 2 and drive the agent to completion. If the old (unfiltered)
    // subscription were still active, its event frames (message_complete,
    // turn_complete, result) would show up while draining toward the response;
    // observing only the response — never an event — proves it was replaced.
    c.drainEvents();   // ignore the gate-1 phase; this assertion is about the REPLACED filter
    await c.request("agent.send", { agentId, text: "gate2" });
    const frame = await c.request("agent.wait", { agentId, timeoutMs: 2000 });
    expect(frame).toMatchObject({ type: "response", ok: true });
    expect(c.drainEvents()).toEqual([]);   // not one frame slipped through the replaced filter

    c.end();
    await server.close();
  }, 15_000);
});

describe("daemon.stop", () => {
  it("responds ok:true and does not throw when no onStop callback was provided", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine }); // onStop omitted
    const c = rpcClient(socketPath);
    await c.request("daemon.hello", { protocolVersion: 1 });
    const res = await c.request("daemon.stop", {});
    expect(res).toMatchObject({ ok: true });
    c.end();
    await server.close();
  });
});

describe("method dispatch to engine.handle", () => {
  it("propagates an engine.handle rejection as {ok:false, error:{code:'protocol'}}", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("agent.status", { agentId: "ghost" });
    expect(res).toMatchObject({ ok: false, error: { code: "protocol" } });
    c.end();
    await server.close();
  });

  it("maps a completely unknown method to a protocol error naming the method", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("no.such.method", {});
    expect(res).toMatchObject({ ok: false, error: { code: "protocol", message: expect.stringContaining("no.such.method") } });
    c.end();
    await server.close();
  });

  it("treats an entirely missing 'params' field as {} for methods that don't need any", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const sock = createConnection(socketPath);
    await new Promise<void>((resolve) => sock.on("connect", resolve));
    const raw: RpcFrame[] = [];
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); const { frames, rest } = decodeFrames(buf); buf = rest; raw.push(...frames); });
    // hand-crafted frame with no "params" key at all (not even undefined)
    sock.write(JSON.stringify({ id: "1", type: "request", method: "daemon.status" }) + "\n");
    await new Promise<void>((resolve) => { const check = () => (raw.length > 0 ? resolve() : setTimeout(check, 10)); check(); });
    expect(raw[0]).toMatchObject({ ok: true });
    sock.end();
    await server.close();
  });
});

describe("domain error messages survive the wire (AUDIT-1)", () => {
  const errorMessage = (res: RpcFrame) => (res as { error: { message: string } }).error.message;

  it("queue.push against an unknown queue names the queue in a non-empty message", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("queue.push", { queue: "does-not-exist", prompt: "hi" });
    expect(res).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(errorMessage(res)).toContain("does-not-exist");
    c.end();
    await server.close();
  });

  it("memory.edit against an unknown id names the id in a non-empty message", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const res = await c.request("memory.edit", { id: "ghost-id", text: "updated" });
    expect(res).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(errorMessage(res)).toContain("ghost-id");
    c.end();
    await server.close();
  });

  it("a duplicate team.create names the team in a non-empty message", async () => {
    const { socketPath, engine, home } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    const spec = {
      name: "dup-team",
      roles: { dev: { role: "blank", overrides: { cwd: home, isolation: "none", permissionProfile: "readOnly", model: "claude-haiku-4-5-20251001", maxTurns: 2, account: "main" } } },
    };
    expect(await c.request("team.create", { spec })).toMatchObject({ ok: true });
    const res = await c.request("team.create", { spec });
    expect(res).toMatchObject({ ok: false, error: { code: "protocol" } });
    expect(errorMessage(res)).toContain("dup-team");
    c.end();
    await server.close();
  });
});

describe("malformed / defensive frame handling", () => {
  it("silently ignores a client frame whose type is not 'request', and the connection keeps working", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const sock = createConnection(socketPath);
    await new Promise<void>((resolve) => sock.on("connect", resolve));
    const raw: RpcFrame[] = [];
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); const { frames, rest } = decodeFrames(buf); buf = rest; raw.push(...frames); });

    // a client should never send these, but the server must not crash on them
    sock.write(encodeFrame({ id: "bogus", type: "response", ok: true, result: {} }));
    sock.write(encodeFrame({ type: "event", event: { ts: 0, seq: 0, engineId: "local", agentId: "x", kind: "status", data: {} } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(raw.length).toBe(0); // neither frame produced a response

    // the connection must still be alive for a real request afterward
    sock.write(encodeFrame({ id: "real", type: "request", method: "daemon.hello", params: { protocolVersion: 1 } }));
    await new Promise<void>((resolve) => { const check = () => (raw.length > 0 ? resolve() : setTimeout(check, 10)); check(); });
    expect(raw[0]).toMatchObject({ ok: true });

    sock.end();
    await server.close();
  });
});

describe("startRpcServer: forced shutdown", () => {
  it("close() resolves promptly even while a subscribe connection is still open", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);
    // a subscribe connection stays open indefinitely; Node's server.close() waits
    // for open connections to end, so without a force-destroy it hangs forever.
    await c.request("subscribe", {});
    const outcome = await Promise.race([
      server.close().then(() => "closed" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(outcome).toBe("closed");
    expect(existsSync(socketPath)).toBe(false); // still unlinks after force-closing the socket
    c.end();
  });

  it("daemon.stop: the requester receives its ack even when onStop force-closes the server", async () => {
    const { socketPath, engine } = makeEngine();
    let srv: Awaited<ReturnType<typeof startRpcServer>> | undefined;
    // mirror main.ts's real wiring: onStop force-closes the server (destroying every
    // socket, including this requester's) with no event-loop turn. The ack must still
    // reach the requester — the daemon.stop handler flushes it before invoking onStop.
    srv = await startRpcServer({ socketPath, engine, onStop: () => void srv!.close() });
    const c = rpcClient(socketPath);
    const stop = await c.request("daemon.stop", {});
    expect(stop).toMatchObject({ type: "response", ok: true, result: { ok: true } });
    c.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(socketPath)).toBe(false); // onStop's close() ran and unlinked the socket
  });
});

describe("startRpcServer: multi-byte UTF-8 frame reassembly", () => {
  it("decodes a frame whose multi-byte UTF-8 char is split across two socket writes", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine });

    // a request frame carrying multi-byte chars in the prompt; split its raw bytes
    // *inside* the last char so the first write ends mid-UTF-8-sequence. A per-chunk
    // chunk.toString() would emit replacement chars here and corrupt the prompt.
    const prompt = "こんにちは世界";
    const frameStr = encodeFrame({ id: "u1", type: "request", method: "agent.spawn", params: { spec: { prompt, cwd: "/tmp", isolation: "none" } } });
    const bytes = Buffer.from(frameStr, "utf8");
    const cut = bytes.indexOf(Buffer.from("世", "utf8")) + 1; // splits the 3-byte "世" after its first byte

    const sock = createConnection(socketPath);
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    let buf = ""; const frames: RpcFrame[] = [];
    sock.on("data", (d) => { buf += d.toString(); const p = decodeFrames(buf); buf = p.rest; frames.push(...p.frames); });

    sock.write(bytes.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20)); // force two separate 'data' events
    sock.write(bytes.subarray(cut));

    const spawnResp = await new Promise<RpcFrame>((resolve) => {
      const check = () => { const f = frames.find((x) => x.type === "response"); f ? resolve(f) : setTimeout(check, 10); };
      check();
    });
    expect(spawnResp).toMatchObject({ ok: true });
    const agentId = (spawnResp as { result: { agentId: string } }).result.agentId;

    // the prompt survived the split intact — the fake backend echoes it as fake:<prompt>
    const c = rpcClient(socketPath);
    await c.request("agent.wait", { agentId, timeoutMs: 2000 });
    const result = await c.request("agent.result", { agentId });
    expect((result as { result: { text: string } }).result.text).toBe(`fake:${prompt}`);
    sock.end(); c.end();
    await server.close();
  }, 15_000);
});

describe("chimerad process: startup resilience", () => {
  it("starts and serves despite a torn/partial state.json from a prior crash", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-tornstate-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
      autoOrder: ["main"],
    }));
    writeFileSync(join(home, "state.json"), '{"agents":[{"agentId":"a1","stat'); // torn mid-write

    const bin = fileURLToPath(new URL("../bin/chimerad.js", import.meta.url));
    const child = spawn(process.execPath, [bin], {
      // ORPHANED-DAEMON-LEAK: this daemon must not outlive THIS test process — if it's hard-killed
      // before the `finally` below runs (worktree teardown, CI timeout), the daemon's own
      // parent-liveness watchdog (main.ts) is the only thing that still reaps it.
      env: { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake", CHIMERA_PARENT_PID: String(process.pid) },
      stdio: "ignore",
    });
    try {
      const socketPath = join(home, "daemon.sock");
      const deadline = Date.now() + 8000;
      while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(socketPath)).toBe(true); // came up instead of crash-looping on the torn file

      const c = rpcClient(socketPath); // and it actually serves
      const hello = await c.request("daemon.hello", { protocolVersion: 1 });
      expect(hello).toMatchObject({ ok: true });
      c.end();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 20_000);
});

describe("chimerad process: guard branches & shutdown side-effects", () => {
  const BIN = fileURLToPath(new URL("../bin/chimerad.js", import.meta.url));
  const CONFIG = JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
  });
  const runExitCode = (home: string, env: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [BIN], { env: { ...process.env, CHIMERA_HOME: home, ...env }, stdio: "ignore" });
      child.once("exit", (code) => resolve(code ?? -1));
    });

  it("exits non-zero when a live daemon.pid already points at a running process", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-pidguard-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    writeFileSync(join(home, "daemon.pid"), String(process.pid)); // this test process is alive → pidAlive === true
    expect(await runExitCode(home, { CHIMERA_BACKEND: "fake" })).toBe(1);
    expect(existsSync(join(home, "daemon.sock"))).toBe(false); // refused before reaching listen()
  }, 20_000);

  // ORPHANED-DAEMON-LEAK acceptance test: a second worktree-rooted spawn attempt against a home
  // ALREADY served by a live daemon must refuse to start, and — the actual bug that leaked 49
  // processes on the operator's machine — must NEVER steal the first daemon's socket out from
  // under it (server.ts unconditionally unlinks+rebinds; before claimPidFile()'s atomic `wx`
  // claim, two near-simultaneous starts could both pass the old check-then-write pid guard).
  it("a second spawn against an already-live home refuses to start and never disturbs the first daemon's socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-singleton-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    const socketPath = join(home, "daemon.sock");
    const envBase = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake", CHIMERA_PARENT_PID: String(process.pid) };
    const first = spawn(process.execPath, [BIN], { env: envBase, stdio: "ignore" });
    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(socketPath)).toBe(true);
      const firstPid = Number(readFileSync(join(home, "daemon.pid"), "utf8"));
      expect(firstPid).toBe(first.pid);

      // Second daemon, same home, first is fully up — must refuse (exit 1), not steal the socket.
      const secondExit = await runExitCode(home, { CHIMERA_BACKEND: "fake" });
      expect(secondExit).toBe(1);

      // The pidfile still names the FIRST daemon — the second never got far enough to overwrite it.
      expect(Number(readFileSync(join(home, "daemon.pid"), "utf8"))).toBe(first.pid);

      // The original socket is still live and served by the SAME daemon — a fresh connection
      // still round-trips daemon.hello (the failure mode this guards: a stolen socket would either
      // refuse new connections or be served by a daemon nobody else can reach/track).
      const c = rpcClient(socketPath);
      const hello = await c.request("daemon.hello", { protocolVersion: 1 });
      expect(hello).toMatchObject({ ok: true });
      c.end();
    } finally {
      first.kill("SIGTERM");
      await new Promise<void>((resolve) => first.once("exit", () => resolve()));
    }
  }, 20_000);

  it("boots successfully with the real ClaudeAgentBackend when CHIMERA_BACKEND is not 'fake' (Task 17 wires it into the default branch)", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-realbackend-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    // ORPHANED-DAEMON-LEAK: see the tornstate test's comment above — same parent-liveness tie.
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "real", CHIMERA_PARENT_PID: String(process.pid) },
      stdio: "ignore",
    });
    const socketPath = join(home, "daemon.sock");
    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(socketPath)).toBe(true); // the dynamic import + construction of ClaudeAgentBackend never blocks startup

      const c = rpcClient(socketPath);
      const hello = await c.request("daemon.hello", { protocolVersion: 1 });
      expect(hello).toMatchObject({ ok: true });
      c.end();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 20_000);

  // SPOTLIGHT-EXCLUDE: measured on an operator's machine while RPCs were timing out at 30s — load
  // average 103 on 12 cores, and the biggest CPU consumer was not chimera but the OS content
  // indexer at 140%, against a ~14% daemon. This home is ~2 GB across a thousand files rewritten
  // constantly (segment rotation, ledger appends, per-turn record writes), so every write feeds
  // the indexer and the daemon then competes with it for the CPU it needs to answer a request.
  it("marks its home so the OS content indexer leaves it alone", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-noindex-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake", CHIMERA_PARENT_PID: String(process.pid) },
      stdio: "ignore",
    });
    const socketPath = join(home, "daemon.sock");
    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(join(home, ".metadata_never_index"))).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 20_000);

  it("boots fine when the marker already exists, and does not rewrite it", async () => {
    // Written once, at first boot. Rewriting it on every start would be a pointless write into
    // the very directory this exists to keep quiet.
    const home = mkdtempSync(join(tmpdir(), "chimera-noindex-existing-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    const marker = join(home, ".metadata_never_index");
    writeFileSync(marker, "");
    const before = statSync(marker).mtimeMs;
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake", CHIMERA_PARENT_PID: String(process.pid) },
      stdio: "ignore",
    });
    const socketPath = join(home, "daemon.sock");
    try {
      const deadline = Date.now() + 8000;
      while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(socketPath)).toBe(true);   // boot is not disturbed by it being there
      expect(statSync(marker).mtimeMs).toBe(before);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }, 20_000);

  it("SIGTERM shutdown unlinks the pid + socket files and leaves a well-formed state.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-shutdown-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    // ORPHANED-DAEMON-LEAK: see the tornstate test's comment above — same parent-liveness tie.
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake", CHIMERA_PARENT_PID: String(process.pid) },
      stdio: "ignore",
    });
    const socketPath = join(home, "daemon.sock");
    const deadline = Date.now() + 8000;
    while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(socketPath)).toBe(true);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(existsSync(join(home, "daemon.pid"))).toBe(false);  // shutdown() unlinks the pid file
    expect(existsSync(socketPath)).toBe(false);                // server.close() unlinks the socket
    const finalState = JSON.parse(readFileSync(join(home, "state.json"), "utf8")); // final snapshot is well-formed, not torn
    expect(Array.isArray(finalState.agents)).toBe(true);
  }, 20_000);

  // [MAIN.daemon-shutdown]: a SIGTERM landing before the socket exists used to hit no handler at
  // all (registered only after `await startRpcServer(...)`) and exit with no cleanup. The real
  // window is only a few ms wide (dominated by tsx transpile time) and varies with machine load,
  // so hitting it via wall-clock timing from outside the process would be flaky; instead widen it
  // deterministically with CHIMERA_TEST_SIGNAL_DELAY_MS (a no-op unless set) and kill comfortably
  // inside it. earlyShutdown() must exit clean and leave no socket behind.
  //
  // The ENTRY into that window is waited for, never guessed: this used to sleep a flat 400ms
  // "well past handler registration", but registration is gated behind tsx transpiling main.ts's
  // whole import graph — measured 400-565ms here, load-dependent — so the sleep raced it and the
  // test failed ~2 of 3 full-file runs with exit 143 (default SIGTERM terminate, no handler yet).
  // main.ts writes signal-handlers-ready under the same test-only env gate, immediately after
  // registering the handlers; polling for it makes the precondition a fact. Raising the sleep
  // instead would have been the same guess with a longer fuse.
  it("SIGTERM during startup (before the socket exists) exits clean and leaves no socket file", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-earlyshutdown-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    const socketPath = join(home, "daemon.sock");
    // ORPHANED-DAEMON-LEAK: parent-tied so a failed assertion below (which skips the kill) cannot
    // leave a daemon running past this suite; irrelevant to the window under test.
    const child = spawn(process.execPath, [BIN], {
      env: {
        ...process.env,
        CHIMERA_HOME: home,
        CHIMERA_BACKEND: "fake",
        CHIMERA_PARENT_PID: String(process.pid),
        CHIMERA_TEST_SIGNAL_DELAY_MS: "5000",
      },
      stdio: "ignore",
    });
    const readyMarker = join(home, "signal-handlers-ready");
    const readyBy = Date.now() + 15_000; // generous: only bounds a hang, never times the window
    while (!existsSync(readyMarker) && Date.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(readyMarker)).toBe(true); // handlers ARE registered — the window is open, not assumed
    expect(existsSync(socketPath)).toBe(false); // still pre-listen — confirms the kill below lands inside the target window
    child.kill("SIGTERM");
    const code = await new Promise<number>((resolve) => child.once("exit", (c) => resolve(c ?? -1)));
    expect(code).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  }, 30_000);

  // [MAIN.daemon-shutdown]: shuttingDown must guard re-entry — a second SIGTERM while the first
  // shutdown() is still in flight (e.g. mid suspendForShutdown()) must not throw or hang the
  // process; it's simply a no-op against the in-flight shutdown, which still exits on its own.
  it("a second SIGTERM sent while shutdown is already in flight does not hang the process", async () => {
    const home = mkdtempSync(join(tmpdir(), "chimera-doublesigterm-"));
    writeFileSync(join(home, "config.json"), CONFIG);
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake", CHIMERA_PARENT_PID: String(process.pid) },
      stdio: "ignore",
    });
    const socketPath = join(home, "daemon.sock");
    const deadline = Date.now() + 8000;
    while (!existsSync(socketPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(socketPath)).toBe(true);

    child.kill("SIGTERM");
    child.kill("SIGTERM"); // second signal, fired immediately behind the first
    const code = await new Promise<number>((resolve) => child.once("exit", (c) => resolve(c ?? -1)));
    expect(code).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  }, 20_000);
});

describe("a client that stops reading cannot exhaust the daemon's memory", () => {
  // Responses and events are written with no backpressure, and Node keeps an unread string
  // write queue in the V8 heap. The desktop app measured at ~2.6 MB/s with a 56 MB unread peak in
  // normal use; a stalled app let that queue grow until the daemon died of heap exhaustion.
  const stalledClient = async (socketPath: string, first: RpcFrame & { type: "request" }) => {
    const sock = createConnection(socketPath);
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    let received = 0;
    sock.on("data", (d) => { received += d.length; });
    const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
    sock.write(encodeFrame(first));
    await new Promise((resolve) => setTimeout(resolve, 50));
    sock.pause();
    return { sock, closed, received: () => received };
  };

  it("drops a subscriber whose unread events pass the cap and keeps serving the others", async () => {
    const { socketPath, engine } = makeEngine();
    const server = await startRpcServer({ socketPath, engine, maxQueuedBytes: 1024 * 1024 });
    const healthy = rpcClient(socketPath);
    expect(await healthy.request("subscribe", {})).toMatchObject({ ok: true });
    const stalled = await stalledClient(socketPath, { id: "s", type: "request", method: "subscribe", params: {} });

    const text = "x".repeat(64 * 1024);
    // The healthy client reads each event before the next one is appended, so only the stalled
    // connection's queue can grow.
    for (let i = 0; i < 128; i++) {
      engine.events.append({ agentId: "a1", kind: "message_complete", data: { text: `${i} ${text}` } });
      expect(await healthy.next()).toMatchObject({ type: "event", event: { kind: "message_complete" } });
    }
    stalled.sock.resume();
    await stalled.closed;
    expect(stalled.received()).toBeLessThan(4 * 1024 * 1024);

    healthy.drainEvents();
    engine.events.append({ agentId: "a1", kind: "status", data: { after: true } });
    expect(await healthy.next()).toMatchObject({ type: "event", event: { kind: "status" } });
    healthy.end();
    await server.close();
  });

  it("drops a connection whose unread responses pass the cap", async () => {
    const { socketPath } = makeEngine();
    const big = "y".repeat(256 * 1024);
    const engine = { events: { subscribe: () => () => {} }, handle: async () => big, releaseClientCaps: () => {}, declareClientCaps: () => {} } as unknown as Engine;
    const server = await startRpcServer({ socketPath, engine, maxQueuedBytes: 1024 * 1024 });
    const stalled = await stalledClient(socketPath, { id: "r0", type: "request", method: "big.result", params: {} });
    for (let i = 1; i <= 32; i++) stalled.sock.write(encodeFrame({ id: `r${i}`, type: "request", method: "big.result", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    stalled.sock.resume();
    await stalled.closed;
    expect(stalled.received()).toBeLessThan(4 * 1024 * 1024);
    await server.close();
  });
});
it("context links require the trusted local operator route; omission on engine/peer routes grants no authority", async () => {
  const home = makeEngineHome(), socketPath = join(home, "daemon.sock");
  const engine = new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([])]]) });
  const agent = await engine.handle("agent.spawn", { spec: { prompt: "context fixture", cwd: "/tmp", isolation: "none" } }) as { agentId: string };
  const params = { from: { kind: "note-snapshot", ref: agent.agentId }, toAgentId: agent.agentId, text: "operator-only fixture" };
  await expect(engine.handle("contextlink.create", params)).rejects.toMatchObject({ code: "forbidden" });
  await expect(engine.handle("contextlink.create", { ...params, callerAgentId: agent.agentId })).rejects.toMatchObject({ code: "forbidden" });
  const server = await startRpcServer({ socketPath, engine }); const client = rpcClient(socketPath);
  try {
    const frame = await client.request("contextlink.create", params);
    expect(frame).toMatchObject({ ok: true, result: { createdBy: "operator", semantics: "snapshot" } });
    const id = (frame as { result: { id: string } }).result.id;
    expect(await client.request("contextlink.get", { id })).toMatchObject({ ok: true, result: { snapshot: { text: "operator-only fixture" } } });
    expect(await client.request("contextlink.get", { id, operator: true })).toMatchObject({ ok: false, error: { code: "protocol" } });
    await expect(engine.handlePeer("unknown-peer", "contextlink.get", { id })).rejects.toMatchObject({ code: "peer-auth" });
  } finally { client.end(); await server.close(); }
});
