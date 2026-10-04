import { describe, it, expect } from "vitest";
import { DynamicCapConfigSchema, type DynamicCapConfig } from "@chimera/protocol";
import {
  DynamicCapTracker, deriveEffectiveCap, parseVmStat, parseMemAvailable, readAvailableMemGb,
  type ResourceSample,
} from "@chimera/core/dynamic-cap";

const CEILING = 40;

function cfg(over: Partial<DynamicCapConfig> = {}): DynamicCapConfig {
  return DynamicCapConfigSchema.parse({ enabled: true, ...over });
}

const IDLE: ResourceSample = { load1: 1, cores: 12, freeMemGb: 30 };
const HIGH_LOAD: ResourceSample = { load1: 20, cores: 12, freeMemGb: 30 };       // ratio ~1.67, past default cpuCriticalRatio 1.5
const CATASTROPHIC: ResourceSample = { load1: 1000, cores: 12, freeMemGb: 0 };

describe("DynamicCapTracker (DYNAMIC-CONCURRENCY-CAP)", () => {
  it("stays at the ceiling under idle load", () => {
    const tracker = new DynamicCapTracker(() => IDLE);
    const c = cfg();
    tracker.sample(c);
    const snap = tracker.effectiveCap(CEILING, c);
    expect(snap.cap).toBe(CEILING);
    expect(snap.cpuPressure).toBe(false);
  });

  it("drops below the ceiling under sustained high load and explains the live inputs", () => {
    const tracker = new DynamicCapTracker(() => HIGH_LOAD);
    const c = cfg();
    for (let i = 0; i < 5; i++) tracker.sample(c);   // let EWMA converge toward the raw sample
    const snap = tracker.effectiveCap(CEILING, c);
    expect(snap.cap).toBeLessThan(CEILING);
    expect(snap.cpuPressure).toBe(true);
    expect(snap.explain).toMatch(/load \d+(\.\d+)?\/12 cores, \d+(\.\d+)? GB free/);
  });

  it("returns to the ceiling once load recovers below the low watermark", () => {
    let sample: ResourceSample = HIGH_LOAD;
    const tracker = new DynamicCapTracker(() => sample);
    const c = cfg();
    for (let i = 0; i < 5; i++) tracker.sample(c);
    expect(tracker.effectiveCap(CEILING, c).cap).toBeLessThan(CEILING);

    sample = IDLE;
    for (let i = 0; i < 20; i++) tracker.sample(c);  // EWMA needs several ticks to decay below cpuLowWatermark
    const snap = tracker.effectiveCap(CEILING, c);
    expect(snap.cap).toBe(CEILING);
    expect(snap.cpuPressure).toBe(false);
  });

  it("never drops below the configured floor, even under catastrophic pressure", () => {
    const tracker = new DynamicCapTracker(() => CATASTROPHIC);
    const c = cfg({ floor: 3 });
    for (let i = 0; i < 5; i++) tracker.sample(c);
    const snap = tracker.effectiveCap(CEILING, c);
    expect(snap.cap).toBe(3);
  });

  it("fails open to the static ceiling when the sampler throws", () => {
    const tracker = new DynamicCapTracker(() => { throw new Error("os.loadavg unsupported on this platform"); });
    const c = cfg();
    tracker.sample(c);
    const snap = tracker.effectiveCap(CEILING, c);
    expect(snap.cap).toBe(CEILING);
    expect(snap.healthy).toBe(false);
  });

  it("recovers once the sampler stops throwing", () => {
    let shouldThrow = true;
    const tracker = new DynamicCapTracker(() => { if (shouldThrow) throw new Error("boom"); return IDLE; });
    const c = cfg();
    tracker.sample(c);
    expect(tracker.effectiveCap(CEILING, c).healthy).toBe(false);
    shouldThrow = false;
    tracker.sample(c);
    expect(tracker.effectiveCap(CEILING, c).healthy).toBe(true);
  });

  it("disabled config always reports the static ceiling regardless of sampled pressure", () => {
    const tracker = new DynamicCapTracker(() => CATASTROPHIC);
    const c = cfg({ enabled: false });
    tracker.sample(c);
    const snap = tracker.effectiveCap(CEILING, c);
    expect(snap.cap).toBe(CEILING);
  });

  it("an absent/undefined config (the pre-feature default) reports the static ceiling", () => {
    const tracker = new DynamicCapTracker(() => CATASTROPHIC);
    tracker.sample(undefined);
    const snap = tracker.effectiveCap(CEILING, undefined);
    expect(snap.cap).toBe(CEILING);
    expect(snap.healthy).toBe(true);
  });

  it("hysteresis: an input oscillating around the high watermark does not flip the cap every tick", () => {
    const c = cfg({ cpuHighWatermark: 0.9, cpuLowWatermark: 0.7 });
    // ratio just above/below 0.9 (10.9/12 ≈ 0.908, 10.5/12 = 0.875) — both readings sit
    // ABOVE cpuLowWatermark (0.7), so once pressure engages, oscillating between them must
    // never let the latch clear back to "no pressure" — that's the whole point of a
    // two-threshold Schmitt trigger over a single raw comparison.
    const readings: ResourceSample[] = [
      { load1: 10.9, cores: 12, freeMemGb: 30 },
      { load1: 10.5, cores: 12, freeMemGb: 30 },
    ];
    let i = 0;
    const tracker = new DynamicCapTracker(() => readings[i % readings.length]!);
    const caps: number[] = [];
    for (i = 0; i < 20; i++) {
      tracker.sample(c);
      caps.push(tracker.effectiveCap(CEILING, c).cap);
    }
    // Pressure engages at some point (at least one reading sits above 0.9) and, once
    // engaged, must never fall back to the full ceiling again while every subsequent
    // reading stays above the low watermark.
    const firstPressureIdx = caps.findIndex((v) => v < CEILING);
    expect(firstPressureIdx).toBeGreaterThanOrEqual(0);
    for (let j = firstPressureIdx; j < caps.length; j++) expect(caps[j]).toBeLessThan(CEILING);
  });

  it("memory pressure alone also narrows the cap, independent of CPU", () => {
    const tracker = new DynamicCapTracker(() => ({ load1: 1, cores: 12, freeMemGb: 0.3 }));
    const c = cfg();   // default memLowWatermarkGb=2, memCriticalGb=0.5
    for (let i = 0; i < 5; i++) tracker.sample(c);
    const snap = tracker.effectiveCap(CEILING, c);
    expect(snap.memPressure).toBe(true);
    expect(snap.cpuPressure).toBe(false);
    expect(snap.cap).toBeLessThan(CEILING);
  });
});

describe("deriveEffectiveCap (pure)", () => {
  it("returns the ceiling when neither resource is under pressure", () => {
    expect(deriveEffectiveCap({ cpuPressure: false, memPressure: false, loadRatio: 0.3, freeMemGb: 20 }, cfg(), CEILING)).toBe(CEILING);
  });

  it("clamps to the floor when both resources are past their critical thresholds", () => {
    expect(deriveEffectiveCap({ cpuPressure: true, memPressure: true, loadRatio: 5, freeMemGb: 0 }, cfg({ floor: 4 }), CEILING)).toBe(4);
  });

  it("takes the more constrained of the two resources", () => {
    // CPU mildly over its low watermark (small reduction); memory deep past critical (near floor).
    const c = cfg({ floor: 2 });
    const cap = deriveEffectiveCap({ cpuPressure: true, memPressure: true, loadRatio: 0.75, freeMemGb: 0.1 }, c, CEILING);
    const cpuOnly = deriveEffectiveCap({ cpuPressure: true, memPressure: false, loadRatio: 0.75, freeMemGb: 30 }, c, CEILING);
    expect(cap).toBeLessThanOrEqual(cpuOnly);
  });
});

// DYNAMIC-CAP-MACOS-FREEMEM: os.freemem() only counts wholly-free pages; macOS keeps almost
// none of those wholly free (spare RAM goes to reclaimable file cache instead), so reading it
// permanently collapsed the memory-derived cap to `floor` on every Mac. These cover the
// corrected "available memory" reading (vm_stat on Darwin, /proc/meminfo MemAvailable on
// Linux) and its fail-open behavior on parse failure / unsupported platforms.
describe("parseVmStat (macOS available-memory parsing)", () => {
  // Real vm_stat output shape, page size 16384 — numbers chosen to land near the 8.8 GB
  // free+inactive+speculative+purgeable this repo measured on a live 48 GB dev machine
  // (os.freemem() read 0.15 GB on the SAME machine at the SAME instant).
  const HEALTHY_VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4008.
Pages active:                             573766.
Pages inactive:                           568469.
Pages speculative:                          4411.
Pages throttled:                               0.
Pages wired down:                         313992.
Pages purgeable:                               0.
"Translation faults":                 30392427317.
Pages copy-on-write:                    3587631801.
Pages purged:                            754635321.
`;

  it("sums free+inactive+speculative+purgeable at the reported page size, in GB", () => {
    const gb = parseVmStat(HEALTHY_VM_STAT);
    // (4008 + 568469 + 4411 + 0) * 16384 bytes / 1024^3 ≈ 8.80 GB
    expect(gb).toBeCloseTo(8.8, 1);
  });

  it("counts purgeable pages toward availability", () => {
    const withPurgeable = HEALTHY_VM_STAT.replace("Pages purgeable:                               0.", "Pages purgeable:                            2000.");
    expect(parseVmStat(withPurgeable)).toBeGreaterThan(parseVmStat(HEALTHY_VM_STAT));
  });

  it("throws on output missing the page size header", () => {
    expect(() => parseVmStat("Pages free: 100.\n")).toThrow(/page size/);
  });

  it("throws on output missing an expected field", () => {
    const noInactive = HEALTHY_VM_STAT.split("\n").filter((l) => !l.startsWith("Pages inactive")).join("\n");
    expect(() => parseVmStat(noInactive)).toThrow(/Pages inactive/);
  });
});

describe("parseMemAvailable (Linux /proc/meminfo parsing)", () => {
  const PROC_MEMINFO = `MemTotal:       49356800 kB
MemFree:         1234567 kB
MemAvailable:   38356800 kB
Buffers:          234567 kB
Cached:          9876543 kB
`;

  it("reads MemAvailable (not MemFree), converted kB -> GB", () => {
    expect(parseMemAvailable(PROC_MEMINFO)).toBeCloseTo(38356800 / 1024 ** 2, 5);
  });

  it("throws when MemAvailable is absent (old kernel with no MemAvailable field)", () => {
    const noAvailable = PROC_MEMINFO.split("\n").filter((l) => !l.startsWith("MemAvailable")).join("\n");
    expect(() => parseMemAvailable(noAvailable)).toThrow(/MemAvailable/);
  });
});

describe("readAvailableMemGb (platform dispatch + fail-open)", () => {
  it("dispatches to vm_stat on darwin", () => {
    const exec = (cmd: string, args: string[]) => {
      expect(cmd).toBe("vm_stat");
      expect(args).toEqual([]);
      return "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 100.\nPages speculative: 0.\nPages purgeable: 0.\n";
    };
    const gb = readAvailableMemGb("darwin", exec, () => { throw new Error("should not read a file on darwin"); });
    expect(gb).toBeCloseTo((200 * 16384) / 1024 ** 3, 6);
  });

  it("dispatches to /proc/meminfo on linux", () => {
    const readFile = (path: string) => {
      expect(path).toBe("/proc/meminfo");
      return "MemAvailable: 1048576 kB\n";
    };
    const gb = readAvailableMemGb("linux", () => { throw new Error("should not exec on linux"); }, readFile);
    expect(gb).toBeCloseTo(1, 5);
  });

  it("throws (fails open, via DynamicCapTracker) on an unsupported platform like win32", () => {
    expect(() => readAvailableMemGb("win32", () => "", () => "")).toThrow(/win32/);
  });

  it("throws when the sampler command produces unparseable output (command exists but output is garbage)", () => {
    expect(() => readAvailableMemGb("darwin", () => "not vm_stat output", () => "")).toThrow();
  });
});

describe("DynamicCapTracker with a corrected available-memory reading (regression)", () => {
  it("REGRESSION: a loaded-but-healthy 48GB macOS box (moderate load, ~9GB available) does NOT collapse to floor under default watermarks", () => {
    // This is the exact incident shape from 15b1bfbb: os.freemem() read ~0.1 GB on a healthy
    // machine and collapsed the cap. With the corrected "available" reading (~9 GB, as measured
    // via vm_stat on this repo's own dev machine) and unmodified default watermarks
    // (memLowWatermarkGb=2), memory pressure must never engage here.
    const REALISTIC_HEALTHY: ResourceSample = { load1: 6.7, cores: 12, freeMemGb: 9.1 };
    const tracker = new DynamicCapTracker(() => REALISTIC_HEALTHY);
    const c = cfg();   // default watermarks, floor=2
    for (let i = 0; i < 5; i++) tracker.sample(c);
    const snap = tracker.effectiveCap(40, c);
    expect(snap.memPressure).toBe(false);
    expect(snap.cap).toBe(40);
    expect(snap.healthy).toBe(true);
  });

  it("a genuine memory-exhaustion sample (available memory near zero) still throttles toward the floor", () => {
    const EXHAUSTED: ResourceSample = { load1: 2, cores: 12, freeMemGb: 0.1 };
    const tracker = new DynamicCapTracker(() => EXHAUSTED);
    const c = cfg({ floor: 2 });
    for (let i = 0; i < 5; i++) tracker.sample(c);
    const snap = tracker.effectiveCap(40, c);
    expect(snap.memPressure).toBe(true);
    expect(snap.cap).toBe(2);
  });
});
