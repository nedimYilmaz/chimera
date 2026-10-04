#!/usr/bin/env node
// Where does chimera's latency actually live?
//
// The app shows one number — "rtt 3007ms" — measured with performance.now() around an await in the
// RENDERER. A saturated renderer and a slow daemon produce that same number, so on its own it
// cannot say which, and "the app is slow with 9 agents running" is unactionable.
//
// This probe answers it by running TWO connections to the same daemon at once:
//
//   SUB   subscribes to every event, exactly like the app does
//   BARE  subscribes to nothing and only ever asks
//
// Both ping daemon.status on the same schedule. The comparison is the whole point:
//
//   SUB slow, BARE fast   -> HEAD-OF-LINE BLOCKING. Events and responses share one socket, written
//                            with no backpressure, so the reply waits behind the event burst.
//                            `queued` (bytes already on the wire ahead of the reply) confirms it.
//   both slow, daemon ms high -> the engine itself. Not the transport.
//   both fast             -> the daemon is fine and the app's rtt is its own renderer. Look there.
//
// Node's own latency is excluded: the sockets are opened once and reused, so no process startup
// lands in a sample.
//
//   node scripts/rtt-probe.mjs [--interval 500] [--seconds 60] [--socket <path>]

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const intervalMs = Number(arg("interval", 500));
const seconds = Number(arg("seconds", 60));
const socketPath = arg("socket", join(homedir(), ".chimera", "daemon.sock"));

/** One connection, with responses matched BY ID rather than by arrival order — events and
 *  responses interleave on this socket, so "the next frame" is not "my reply". */
function connect(label) {
  const sock = createConnection(socketPath);
  const pending = new Map();
  let buf = "";
  let events = 0;
  let id = 0;
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === "response" && pending.has(frame.id)) {
        const settle = pending.get(frame.id);
        pending.delete(frame.id);
        settle(frame);
      } else if (frame.type === "event") events++;
    }
  });
  sock.on("error", (err) => { console.error(`[${label}] socket error: ${err.message}`); process.exit(1); });
  const request = (method, params = {}) => new Promise((resolve) => {
    const rid = String(++id);
    pending.set(rid, resolve);
    sock.write(JSON.stringify({ id: rid, type: "request", method, params }) + "\n");
  });
  return {
    label, request, end: () => sock.end(),
    takeEvents: () => { const n = events; events = 0; return n; },
  };
}

const ready = (sock) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no connection to ${socketPath} — is chimerad running?`)), 5000);
  sock.request("daemon.hello", { protocolVersion: 1 }).then((r) => { clearTimeout(timer); resolve(r); });
});

const pct = (values, p) => (values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]);
const fmt = (n) => n.toFixed(0).padStart(5);

async function main() {
  const sub = connect("SUB");
  const bare = connect("BARE");
  await Promise.all([ready(sub), ready(bare)]);
  await sub.request("subscribe", {});   // every event, no agentId filter — what the app does

  console.log(`probing ${socketPath} every ${intervalMs}ms for ${seconds}s`);
  console.log("Run this while the agents that make it slow are actually running, then open the");
  console.log("settings card and hit apply — the sample where it hurts is the one that matters.\n");
  // CONTROL. Both sockets live in THIS process, so if this process is descheduled — 30+ model
  // subprocesses competing for the same CPU will do it — both round trips inflate together and
  // look exactly like a blocked daemon. `self` is how late a 100ms timer fires here, measuring
  // only this process's own event loop. High rtt with a flat `self` means the daemon really is
  // blocked; high rtt with high `self` means the measurement is the thing that stalled, not
  // necessarily the daemon.
  let selfLagMs = 0;
  const lagTimer = setInterval(() => {
    const due = Date.now();
    setTimeout(() => { selfLagMs = Math.max(selfLagMs, Date.now() - due - 100); }, 100);
  }, 200);
  lagTimer.unref?.();

  console.log("    t     SUB rtt  BARE rtt   daemon   queued     self    ev/s");

  const subRtts = [], bareRtts = [], handles = [], queues = [], selfLags = [];
  const started = Date.now();
  let stop = false;
  process.on("SIGINT", () => { stop = true; });

  while (!stop && Date.now() - started < seconds * 1000) {
    const t0 = Date.now();
    // Both pings in flight together, so the two numbers describe the SAME moment.
    const [a, b] = await Promise.all([
      (async () => { const s = Date.now(); const r = await sub.request("daemon.status", {}); return { ms: Date.now() - s, r }; })(),
      (async () => { const s = Date.now(); const r = await bare.request("daemon.status", {}); return { ms: Date.now() - s, r }; })(),
    ]);
    const result = a.r.result ?? {};
    const handleMs = typeof result.serverHandleMs === "number" ? result.serverHandleMs : -1;
    const queued = typeof result.socketQueuedBytes === "number" ? result.socketQueuedBytes : -1;
    const evs = sub.takeEvents();
    const self = selfLagMs; selfLagMs = 0;
    selfLags.push(self);
    subRtts.push(a.ms); bareRtts.push(b.ms);
    if (handleMs >= 0) handles.push(handleMs);
    if (queued >= 0) queues.push(queued);
    const elapsed = ((Date.now() - started) / 1000).toFixed(0).padStart(5);
    console.log(`${elapsed}s ${fmt(a.ms)}ms ${fmt(b.ms)}ms ${fmt(handleMs)}ms ${fmt(queued)}B ${fmt(self)}ms ${fmt(evs / (intervalMs / 1000))}`);
    const rest = intervalMs - (Date.now() - t0);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  }

  console.log("\n--- summary (p50 / p90 / max) ---");
  console.log(`SUB  rtt   ${fmt(pct(subRtts, .5))} ${fmt(pct(subRtts, .9))} ${fmt(Math.max(0, ...subRtts))} ms   (subscribed, like the app)`);
  console.log(`BARE rtt   ${fmt(pct(bareRtts, .5))} ${fmt(pct(bareRtts, .9))} ${fmt(Math.max(0, ...bareRtts))} ms   (request-only)`);
  console.log(`daemon     ${fmt(pct(handles, .5))} ${fmt(pct(handles, .9))} ${fmt(Math.max(0, ...handles))} ms   (engine handling, renderer-independent)`);
  console.log(`queued     ${fmt(pct(queues, .5))} ${fmt(pct(queues, .9))} ${fmt(Math.max(0, ...queues))} B    (bytes ahead of the reply)`);
  console.log(`self lag   ${fmt(pct(selfLags, .5))} ${fmt(pct(selfLags, .9))} ${fmt(Math.max(0, ...selfLags))} ms   (THIS process — if high, the probe stalled too)`);
  console.log("\nRead it as: SUB >> BARE means the shared socket is the problem; both high with a high");
  console.log("daemon column means the engine is; both low means the daemon is fine and the app's own");
  console.log("rtt is renderer time — the PerfHud's `ui` number (ctrl+shift+d) is that same split.");
  sub.end(); bare.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
