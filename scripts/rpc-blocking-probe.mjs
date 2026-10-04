#!/usr/bin/env node
// Does ONE expensive request block every other request?
//
// "Is everything flowing through a single pipe?" has a precise answer and this measures it. The
// daemon has no lock and dispatches each frame without awaiting the last, so requests are
// concurrent in the sense that they interleave — but Node runs all JS on ONE thread, so the
// SYNCHRONOUS part of any handler (JSON.stringify of a large reply, a big parse, GC triggered by
// either) cannot be interleaved with anything. While it runs, every other connection waits.
//
// The test: take a baseline of a trivial request on an idle daemon, then fire a known-expensive
// request on a DIFFERENT connection and keep pinging the trivial one throughout. If the trivial
// request's latency jumps by roughly the expensive one's duration, the pipe is shared — and the
// number it jumps by is the blockage, in milliseconds.
//
//   node scripts/rpc-blocking-probe.mjs [--heavy agent.list] [--socket <path>]

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const socketPath = arg("socket", join(homedir(), ".chimera", "daemon.sock"));
const heavyMethod = arg("heavy", "agent.list");

function connect() {
  const sock = createConnection(socketPath);
  const pending = new Map();
  let buf = "", id = 0;
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let f; try { f = JSON.parse(line); } catch { continue; }
      if (f.type === "response" && pending.has(f.id)) { const s = pending.get(f.id); pending.delete(f.id); s({ frame: f, bytes: line.length }); }
    }
  });
  sock.on("error", (e) => { console.error(e.message); process.exit(1); });
  const request = (method, params = {}) => new Promise((resolve) => {
    const rid = String(++id); pending.set(rid, resolve);
    sock.write(JSON.stringify({ id: rid, type: "request", method, params }) + "\n");
  });
  return { request, end: () => sock.end() };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length * .5)] ?? 0, p90: s[Math.floor(s.length * .9)] ?? 0, max: s[s.length - 1] ?? 0 };
};

async function pingFor(conn, ms) {
  const out = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = Date.now();
    await conn.request("daemon.status", {});
    out.push(Date.now() - t);
    await new Promise((r) => setTimeout(r, 20));
  }
  return out;
}

async function main() {
  const pinger = connect();
  const heavy = connect();
  await Promise.all([pinger.request("daemon.hello", { protocolVersion: 1 }), heavy.request("daemon.hello", { protocolVersion: 1 })]);

  console.log(`socket ${socketPath}\nheavy request: ${heavyMethod}\n`);

  const base = await pingFor(pinger, 3000);
  const b = stats(base);
  console.log(`BASELINE  daemon.status alone         p50 ${b.p50}ms  p90 ${b.p90}ms  max ${b.max}ms   (${base.length} samples)`);

  // Now the same ping, while ONE expensive request runs on the other connection.
  const during = [];
  const heavyTimes = [];
  let stop = false;
  const pingLoop = (async () => {
    while (!stop) {
      const t = Date.now();
      await pinger.request("daemon.status", {});
      during.push(Date.now() - t);
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    const r = await heavy.request(heavyMethod, {});
    heavyTimes.push(Date.now() - t);
    if (i === 0) console.log(`          ${heavyMethod} replied ${(r.bytes / 1024).toFixed(0)} KB`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
  stop = true; await pingLoop;

  const d = stats(during);
  const h = stats(heavyTimes);
  console.log(`HEAVY     ${heavyMethod.padEnd(26)} p50 ${h.p50}ms  p90 ${h.p90}ms  max ${h.max}ms   (5 runs)`);
  console.log(`DURING    daemon.status alongside it  p50 ${d.p50}ms  p90 ${d.p90}ms  max ${d.max}ms   (${during.length} samples)`);
  console.log(`\nblocking cost: a trivial request's p90 went ${b.p90}ms -> ${d.p90}ms (${d.p90 - b.p90 >= 0 ? "+" : ""}${d.p90 - b.p90}ms), max ${b.max} -> ${d.max}ms.`);
  console.log("A jump on the order of the heavy request's own duration means one thread is serving");
  console.log("both: the handler's synchronous part cannot yield, so every other connection waits");
  console.log("behind it. That is the pipe — not the socket, and not a lock.");
  pinger.end(); heavy.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
