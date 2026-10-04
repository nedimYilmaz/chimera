// DYNAMIC-CONCURRENCY-CAP: a resource-aware admission cap that narrows the OPERATING POINT
// below caps.maxAgentsTotal (the ceiling — the operator's declared max, unchanged) when the
// machine is genuinely under CPU/memory pressure. Two pieces:
//   - DynamicCapTracker.sample(): the periodic probe, called once per HealthMonitor tick (see
//     health.ts's tick() — this deliberately reuses that already-running timer rather than
//     standing up a second one). Cheap: os.loadavg() plus one platform-appropriate AVAILABLE-
//     memory read (readAvailableMemGb below — a `vm_stat`/`/proc/meminfo` read on Darwin/Linux,
//     NOT os.freemem(); see that function's own comment for why). Runs at most once per tick,
//     never on the hot admission-check path. EWMA-smooths the raw samples, and updates a pair
//     of Schmitt-trigger pressure latches.
//   - DynamicCapTracker.effectiveCap(): a cheap synchronous read, called by the supervisor on
//     every spawn ADMISSION check (supervisor.ts) — it never itself samples.
//
// NEVER RETROACTIVE: effectiveCap() only ever feeds an admission comparison
// (`running.length >= effectiveCap`). Lowering it can only refuse NEW spawns from this point
// on — it can never kill, pause, or otherwise disturb an agent already counted as "running".
// This module holds no reference to the supervisor's agent map and has no way to touch a
// running agent even by accident; guard this invariant at the CALL SITE (supervisor.ts) if
// this file is ever refactored to take more context.
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { DynamicCapConfig } from "@chimera/protocol";

export type ResourceSample = {
  load1: number;      // 1-minute load average, raw (not normalized by core count)
  cores: number;       // logical core count at sample time
  freeMemGb: number;   // AVAILABLE memory, GB (reclaimable cache counted as available — see below)
};

export type ResourceSampler = () => ResourceSample;

// MACOS-FREEMEM-BUG (15b1bfbb postmortem): os.freemem() reports only wholly-free pages.
// macOS deliberately keeps almost none of those — it uses spare RAM for file cache
// (inactive/speculative/purgeable pages), which the kernel reclaims on demand just like Linux's
// page cache. Reading os.freemem() on macOS therefore sits near zero on an otherwise-healthy
// box, which permanently collapsed the memory-derived cap to `floor` the moment this shipped.
// The correct "available" signal is free + inactive + speculative + purgeable pages, which is
// exactly what `vm_stat` reports and what Activity Monitor's own "Memory Used" is derived from.
export function parseVmStat(output: string): number {
  const pageSizeMatch = output.match(/page size of (\d+) bytes/);
  if (!pageSizeMatch) throw new Error("vm_stat: could not parse page size from output");
  const pageSizeBytes = Number(pageSizeMatch[1]);
  const field = (name: string): number => {
    const m = output.match(new RegExp(`Pages ${name}:\\s+(\\d+)\\.`));
    if (!m) throw new Error(`vm_stat: could not parse "Pages ${name}" from output`);
    return Number(m[1]);
  };
  const availablePages = field("free") + field("inactive") + field("speculative") + field("purgeable");
  return (availablePages * pageSizeBytes) / 1024 ** 3;
}

// Linux has the same class of bug: MemFree excludes reclaimable page cache. MemAvailable
// (kernel-computed since 3.14) is the correct "how much could a new process actually get"
// signal — it already accounts for reclaimable caches and slab, so no reimplementing that math
// here.
export function parseMemAvailable(output: string): number {
  const m = output.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  if (!m) throw new Error("/proc/meminfo: could not parse MemAvailable");
  return Number(m[1]) / 1024 ** 2;
}

// Injectable seams (exec/readFile) so parse-failure and unsupported-platform paths are
// unit-testable without actually shelling out. Real callers use the defaults.
export function readAvailableMemGb(
  platform: NodeJS.Platform = os.platform(),
  exec: (cmd: string, args: string[]) => string = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): number {
  if (platform === "darwin") return parseVmStat(exec("vm_stat", []));
  if (platform === "linux") return parseMemAvailable(readFile("/proc/meminfo"));
  // UNKNOWN platform (win32, freebsd, ...): throw. sample()'s try/catch below turns this into
  // healthy=false, which effectiveCap() reads FIRST and answers with the plain static ceiling —
  // the fail-open path this feature has always had for sampler failure. A monitoring gap must
  // never become an availability outage (SCOPE), so this deliberately does not guess.
  throw new Error(`dynamic cap: no available-memory sampler for platform "${platform}"`);
}

export function realResourceSampler(): ResourceSample {
  const cores = os.cpus().length || 1;
  const platform = os.platform();
  // os.loadavg() is hardcoded to [0, 0, 0] on Windows (Node docs: "always [0, 0, 0]"). Reading
  // that as "load ratio 0" would report permanent zero CPU pressure rather than an honest
  // monitoring gap — the exact silent-disable failure mode this module must avoid (see
  // readAvailableMemGb above). Throwing routes it through the same fail-open path instead.
  if (platform === "win32") throw new Error("dynamic cap: os.loadavg() is not meaningful on win32");
  return { load1: os.loadavg()[0], cores, freeMemGb: readAvailableMemGb(platform) };
}

export type DynamicCapSnapshot = {
  cap: number;
  ceiling: number;
  // False only right after sample() caught a sampler failure — the FAIL-OPEN marker. True
  // whenever the feature is disabled outright (nothing to be unhealthy about) or the last
  // sample succeeded.
  healthy: boolean;
  cpuPressure: boolean;
  memPressure: boolean;
  // EWMA-smoothed values from the last successful sample; null before the first one.
  load1: number | null;
  cores: number | null;
  freeMemGb: number | null;
  // Human-readable live inputs for GuardrailError messages / daemon.status — e.g.
  // "load 11.4/12 cores, 3.2 GB free". The operator's complaint that a static cap is opaque
  // is exactly what this exists to fix; never collapse this to a bare number.
  explain: string;
};

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Pure — given the current smoothed ratio/pressure state, derive the effective cap. Exported
// standalone (not just reachable through the class) so the hysteresis/interpolation/floor math
// is unit-testable without going through sampling. While a resource is NOT under pressure its
// derived cap is the ceiling outright; while it IS, the cap interpolates linearly from the
// ceiling (at the resource's own LOW/recovery watermark) down to `floor` (at its CRITICAL
// watermark) — so the cap moves smoothly inside the pressure band, but whether the band is
// entered/exited at all is governed by the caller's Schmitt-trigger latch, not by this
// function re-deriving pressure from the raw ratio itself (that's what prevents flapping).
export function deriveEffectiveCap(
  state: { cpuPressure: boolean; memPressure: boolean; loadRatio: number; freeMemGb: number },
  cfg: DynamicCapConfig,
  ceiling: number,
): number {
  const cpuCap = !state.cpuPressure ? ceiling
    : ceiling - (ceiling - cfg.floor) * clamp01(
        (state.loadRatio - cfg.cpuLowWatermark) / Math.max(cfg.cpuCriticalRatio - cfg.cpuLowWatermark, 1e-9),
      );
  const memCap = !state.memPressure ? ceiling
    : ceiling - (ceiling - cfg.floor) * clamp01(
        (cfg.memHighWatermarkGb - state.freeMemGb) / Math.max(cfg.memHighWatermarkGb - cfg.memCriticalGb, 1e-9),
      );
  // Hard floor (ACCEPTANCE #5): clamp regardless of how the interpolation above landed —
  // catastrophic input (e.g. loadRatio far past cpuCriticalRatio) must never compute below it.
  return Math.max(cfg.floor, Math.round(Math.min(cpuCap, memCap)));
}

export class DynamicCapTracker {
  private ewmaLoad1: number | null = null;
  private ewmaFreeMemGb: number | null = null;
  private lastCores: number | null = null;
  private cpuPressure = false;
  private memPressure = false;
  // Starts true: "nothing has failed yet" is the correct fail-open default before the first
  // tick, same as HealthMonitor's own lastActivity-seeded-at-start convention.
  private healthy = true;

  constructor(private readonly sampler: ResourceSampler = realResourceSampler) {}

  // Called once per HealthMonitor tick. Never throws: a sampler failure (unsupported
  // platform, os.* throwing, anything at all) marks `healthy=false` and leaves the
  // previously smoothed EWMA/latch state untouched — effectiveCap() below checks `healthy`
  // FIRST and, when false, returns the plain static ceiling with no reduction regardless of
  // what the state was before the failure. FAIL-OPEN (SCOPE #2 bullet 4): a monitoring
  // failure must never become an availability failure.
  sample(cfg: DynamicCapConfig | undefined): void {
    if (!cfg || !cfg.enabled) { this.healthy = true; return; }
    try {
      const s = this.sampler();
      this.ewmaLoad1 = this.ewmaLoad1 === null ? s.load1 : cfg.emaAlpha * s.load1 + (1 - cfg.emaAlpha) * this.ewmaLoad1;
      this.ewmaFreeMemGb = this.ewmaFreeMemGb === null ? s.freeMemGb : cfg.emaAlpha * s.freeMemGb + (1 - cfg.emaAlpha) * this.ewmaFreeMemGb;
      this.lastCores = s.cores;
      this.healthy = true;

      const loadRatio = this.ewmaLoad1 / Math.max(this.lastCores, 1);
      // Schmitt-trigger latches (ACCEPTANCE #4): cross INTO pressure only above the high
      // watermark, cross OUT only below the low watermark. An input anywhere inside the
      // band — including one oscillating back and forth across a single point in that band —
      // leaves the latch untouched, so the effective cap can never flip tick-to-tick from
      // that alone.
      if (!this.cpuPressure && loadRatio > cfg.cpuHighWatermark) this.cpuPressure = true;
      else if (this.cpuPressure && loadRatio < cfg.cpuLowWatermark) this.cpuPressure = false;
      if (!this.memPressure && this.ewmaFreeMemGb < cfg.memLowWatermarkGb) this.memPressure = true;
      else if (this.memPressure && this.ewmaFreeMemGb > cfg.memHighWatermarkGb) this.memPressure = false;
    } catch {
      this.healthy = false;
    }
  }

  // Cheap synchronous read — the supervisor calls this on every spawn admission check, so it
  // must never itself sample (sampling only ever happens from HealthMonitor's tick, above).
  effectiveCap(ceiling: number, cfg: DynamicCapConfig | undefined): DynamicCapSnapshot {
    const base = { ceiling, cpuPressure: this.cpuPressure, memPressure: this.memPressure,
      load1: this.ewmaLoad1, cores: this.lastCores, freeMemGb: this.ewmaFreeMemGb };
    if (!cfg || !cfg.enabled) return { ...base, cap: ceiling, healthy: true, explain: "dynamic cap disabled — static ceiling" };
    if (!this.healthy) return { ...base, cap: ceiling, healthy: false, explain: "dynamic cap probe failed — falling back to static ceiling" };
    if (this.ewmaLoad1 === null || this.ewmaFreeMemGb === null || this.lastCores === null) {
      return { ...base, cap: ceiling, healthy: true, explain: "dynamic cap warming up (no sample yet) — static ceiling" };
    }
    const loadRatio = this.ewmaLoad1 / Math.max(this.lastCores, 1);
    const cap = deriveEffectiveCap(
      { cpuPressure: this.cpuPressure, memPressure: this.memPressure, loadRatio, freeMemGb: this.ewmaFreeMemGb },
      cfg, ceiling,
    );
    return { ...base, cap, healthy: true, explain: `load ${this.ewmaLoad1.toFixed(1)}/${this.lastCores} cores, ${this.ewmaFreeMemGb.toFixed(1)} GB free` };
  }
}
