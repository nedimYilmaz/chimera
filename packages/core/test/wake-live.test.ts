import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

// The ONE test that touches this machine's real power management. It is skipped unless
// CHIMERA_LIVE_WAKE is set and is never part of a normal verify.
//
// To run it, an operator must first opt in for real:
//
//     ./scripts/install.sh --enable-wake          # prints everything, asks for a typed "yes"
//     CHIMERA_LIVE_WAKE=1 npx vitest run packages/core/test/wake-live.test.ts
//     ./scripts/install.sh --disable-wake         # when you're done, if you don't want it
//
// It schedules a real RTC wake ~10 minutes out and cancels it again in the same test, so a failure
// mid-way can leave one wakeorpoweron event behind; the assertion messages say how to remove it.
// It never installs anything itself — a test that can create a NOPASSWD sudoers rule would be a
// worse hole than the one this whole feature is careful to avoid.

const WRAPPER = "/usr/local/libexec/chimera-wake";
const live = describe.skipIf(!process.env["CHIMERA_LIVE_WAKE"]);

const iso = (atMs: number): string => new Date(atMs).toISOString().replace(/\.\d{3}Z$/, "Z");

function wrapper(...args: string[]) {
  const r = spawnSync("/usr/bin/sudo", ["-n", WRAPPER, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

/** Unprivileged (verified rc=0 on macOS 26.6.1) — this is also exactly what install.sh's
 *  --disable-wake parses to find chimera's own events. */
const sched = (): string => spawnSync("/usr/bin/pmset", ["-g", "sched"], { encoding: "utf8" }).stdout ?? "";

live("live macOS RTC wake (CHIMERA_LIVE_WAKE)", () => {
  it("is installed and probes clean via the daemon's exact call", () => {
    expect(existsSync(WRAPPER), `${WRAPPER} is not installed — run ./scripts/install.sh --enable-wake first`).toBe(true);
    const r = wrapper("probe");
    expect(r.code, `sudo -n ${WRAPPER} probe failed: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("chimera-wake");
  });

  it("schedules a real wakeorpoweron event tagged chimera and cancels exactly that one", () => {
    const at = iso(Date.now() + 10 * 60_000);
    const scheduled = wrapper("schedule", at);
    expect(scheduled.code, `schedule failed: ${scheduled.stderr}`).toBe(0);
    const localTs = scheduled.stdout;

    const after = sched();
    expect(after, `expected a chimera-owned event at ${localTs} in: ${after}`).toContain("by 'chimera'");

    const cancelled = wrapper("cancel", at);
    expect(
      cancelled.code,
      `cancel failed: ${cancelled.stderr} — remove it by hand with: pmset schedule cancel wakeorpoweron "${localTs}" chimera`,
    ).toBe(0);
    expect(
      sched(),
      `the chimera event at ${localTs} survived cancel — remove it by hand with: pmset schedule cancel wakeorpoweron "${localTs}" chimera`,
    ).not.toContain("by 'chimera'");
  });
});
