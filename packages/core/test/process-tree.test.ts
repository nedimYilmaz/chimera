import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { durationSec, parseProcesses, ProcessTreeSampler } from "../src/process-tree.js";
const row = (pid: number, ppid: number, cpu = "00:01.00", start = "Mon Oct 5 12:00:00 2026", name = "/usr/bin/node", rss = 10) => `${pid} ${ppid} ${rss} 01:02 ${cpu} ${start} ${name}`;
describe("bounded process resource attribution", () => {
  it("parses Darwin/Linux durations and basenames without argv or environment", () => {
    expect(durationSec("2-01:02:03")).toBe(176523);
    expect(durationSec("00:01.25")).toBe(1.25);
    expect(parseProcesses(row(1, 0)).rows[0]).toMatchObject({ name: "node", rssBytes: 10240, elapsedSec: 62 });
    expect(parseProcesses(row(1, 0).replace("01:02 00:01.00", "00:01:02 00:00:01")).rows).toEqual(parseProcesses(row(1, 0)).rows);
    expect(parseProcesses("bad row").rows).toEqual([]);
  });
  it("measures CPU deltas, removes vanished children and never includes shared siblings or another agent root", async () => {
    let at = 1000;
    let raw = [row(10, 1), row(11, 10), row(12, 1), row(13, 10), row(14, 13)].join("\n");
    const s = new ProcessTreeSampler(async () => raw, () => at, "darwin");
    const first = await s.sample("a", 10, new Set([13]));
    expect(first.procs.map(p => p.pid)).toEqual([10, 11]);
    expect(first.totals).toEqual({ cpuPct: null, rssBytes: 20480, procCount: 2 });
    at = 3000; raw = row(10, 1, "00:02.00");
    expect((await s.sample("a", 10)).totals).toEqual({ cpuPct: 50, rssBytes: 10240, procCount: 1 });
  });
  it("rejects reused root identity and resets CPU for reused child PIDs", async () => {
    let at = 1000; let raw = row(10, 1) + "\n" + row(11, 10);
    const s = new ProcessTreeSampler(async () => raw, () => at, "linux");
    await s.sample("a", 10); at += 2000;
    raw = row(10, 1) + "\n" + row(11, 10, "00:00", "Mon Oct 5 12:01:00 2026");
    expect((await s.sample("a", 10)).procs[1]?.cpuPct).toBeNull();
    raw = row(10, 1, "00:00", "Mon Oct 5 12:02:00 2026");
    expect(await s.sample("a", 10)).toMatchObject({ state: "unavailable", reason: "identity", totals: { rssBytes: null } });
    expect(await s.sample("a", 10)).toMatchObject({ reason: "identity" });
  });
  it("retains ownership across A → absent → reused B until an authoritative run reset", async () => {
    let raw = row(10, 1);
    const s = new ProcessTreeSampler(async () => raw, Date.now, "darwin");
    expect(await s.sample("a", 10)).toMatchObject({ state: "ok" });
    raw = "";
    expect(await s.sample("a", 10)).toMatchObject({ reason: "no_process" });
    raw = row(10, 1, "00:00", "Mon Oct 5 12:02:00 2026");
    expect(await s.sample("a", 10)).toMatchObject({ state: "unavailable", reason: "identity" });
    expect(await s.sample("a", 10)).toMatchObject({ state: "unavailable", reason: "identity" });
    expect(await s.sample("a", 10, new Set(), false, "authoritative-next-run")).toMatchObject({ state: "ok", totals: { cpuPct: null } });
  });
  it("CPU-cache eviction cannot discard a live ownership pin", async () => {
    let raw = row(10, 1);
    const s = new ProcessTreeSampler(async () => raw, Date.now, "darwin");
    await s.sample("a", 10);
    for (let i = 0; i < 257; i++) await s.sample(`other-${i}`, 10);
    raw = row(10, 1, "00:00", "Mon Oct 5 12:02:00 2026");
    expect(await s.sample("a", 10)).toMatchObject({ reason: "identity" });
  });
  it("bounds count and depth and handles missing roots/platform/permissions honestly", async () => {
    const s = new ProcessTreeSampler(async () => Array.from({ length: 2100 }, (_, i) => row(i + 1, i ? 1 : 0)).join("\n"), Date.now, "darwin");
    expect(await s.sample("a", 1)).toMatchObject({ truncated: true, totals: { procCount: 2000, rssBytes: 20480000 } });
    const deep = new ProcessTreeSampler(async () => Array.from({ length: 12 }, (_, i) => row(i + 1, i)).join("\n"), Date.now, "linux");
    expect(await deep.sample("a", 1)).toMatchObject({ truncated: true, totals: { procCount: 9 } });
    expect(await deep.sample("a", 99)).toMatchObject({ state: "unavailable", reason: "no_process" });
    const exec = vi.fn();
    expect(await new ProcessTreeSampler(exec, Date.now, "win32").sample("a", 1)).toMatchObject({ reason: "platform" });
    expect(exec).not.toHaveBeenCalled();
    expect(await new ProcessTreeSampler(async () => { throw Object.assign(new Error(), { code: "EPERM" }); }, Date.now, "linux").sample("a", 1)).toMatchObject({ reason: "permission" });
  });
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")("measures a real local parent with three sleep children without reading secrets", async () => {
    const child = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process');const children=Array.from({length:3},()=>spawn('sleep',['30'])); process.send('ready');process.on('message',()=>{for(const c of children)c.kill();setTimeout(()=>process.exit(),100)});`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      await once(child, "message");
      const sample = await new ProcessTreeSampler().sample("local-test", child.pid!);
      expect(sample.state).toBe("ok");
      expect(sample.procs.filter(p => p.name === "sleep")).toHaveLength(3);
      expect(sample.totals.procCount).toBeGreaterThanOrEqual(4);
      expect(sample.totals.rssBytes).toBeGreaterThan(0);
      expect(sample.totals.cpuPct).toBeNull();
    } finally { const ended = once(child, "exit"); child.send("cleanup"); await ended; }
  });
});
