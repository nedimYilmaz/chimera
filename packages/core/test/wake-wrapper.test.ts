import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// F01(a): the REAL scripts/chimera-wake.sh, exercised with a stub `pmset` first on PATH. This is
// the whole privileged surface chimera has, so every rejection is asserted twice: the exit code
// AND an empty pmset log — an argument that is refused must never have reached pmset at all.
//
// The stub is reachable because the script honours CHIMERA_WAKE_TEST_PATH, but ONLY for a
// non-root invocation (see the comment in the script). Tests run unprivileged, so the seam works
// here and is inert in the installed root-run copy.

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WRAPPER = path.join(REPO_ROOT, "scripts", "chimera-wake.sh");

const STUB_PMSET = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> "$PMSET_LOG"; done
printf -- '--\\n' >> "$PMSET_LOG"
exit 0
`;

type Run = { code: number; stdout: string; stderr: string; pmsetArgv: string[] };

function runWrapper(args: string[]): Run {
  const dir = mkdtempSync(path.join(tmpdir(), "chimera-wake-"));
  const stubDir = path.join(dir, "bin");
  mkdirSync(stubDir);
  writeFileSync(path.join(stubDir, "pmset"), STUB_PMSET, { mode: 0o755 });
  const log = path.join(dir, "pmset.log");
  const r = spawnSync("/bin/sh", [WRAPPER, ...args], {
    encoding: "utf8",
    env: { ...process.env, CHIMERA_WAKE_TEST_PATH: stubDir, PMSET_LOG: log },
  });
  const raw = existsSync(log) ? readFileSync(log, "utf8") : "";
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    pmsetArgv: raw.split("\n").filter((l) => l !== "" && l !== "--"),
  };
}

/** Second-resolution UTC ISO — exactly the grammar the wrapper whitelists. */
const iso = (atMs: number): string => new Date(atMs).toISOString().replace(/\.\d{3}Z$/, "Z");
const IN_ONE_HOUR = iso(Date.now() + 3_600_000);

// The wrapper drives macOS pmset and parses with BSD `date -j`; RTC wake is macOS-only, so the
// accepted path can only run there. The rejections below exit before any date call and run anywhere.
describe.runIf(process.platform === "darwin")("chimera-wake wrapper — accepted", () => {
  it("probe touches nothing and reports its version", () => {
    const r = runWrapper(["probe"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("chimera-wake 1");
    expect(r.pmsetArgv).toEqual([]);
  });

  it("schedule <ISO> passes the owner tag chimera, the type wakeorpoweron and a local MM/dd/yy time", () => {
    const r = runWrapper(["schedule", IN_ONE_HOUR]);
    expect(r.code).toBe(0);
    expect(r.pmsetArgv[0]).toBe("schedule");
    expect(r.pmsetArgv[1]).toBe("wakeorpoweron");
    expect(r.pmsetArgv[2]).toMatch(/^\d\d\/\d\d\/\d\d \d\d:\d\d:\d\d$/);
    expect(r.pmsetArgv[3]).toBe("chimera");
    expect(r.pmsetArgv).toHaveLength(4);
    // The exact local string is echoed back so cancel can be matched against it later.
    expect(r.stdout.trim()).toBe(r.pmsetArgv[2]);
  });

  it("cancel <ISO> cancels ONE owner-tagged event by exact timestamp, never every event", () => {
    const r = runWrapper(["cancel", IN_ONE_HOUR]);
    expect(r.code).toBe(0);
    expect(r.pmsetArgv.slice(0, 2)).toEqual(["schedule", "cancel"]);
    expect(r.pmsetArgv[2]).toBe("wakeorpoweron");
    expect(r.pmsetArgv[4]).toBe("chimera");
    expect(r.pmsetArgv.some((a) => a.includes("cancelall"))).toBe(false);
    expect(r.pmsetArgv.some((a) => a === "-a")).toBe(false);
  });

  it("schedule and cancel agree on the local timestamp, so a scheduled event is cancellable", () => {
    const at = iso(Date.now() + 7_200_000);
    expect(runWrapper(["cancel", at]).pmsetArgv[3]).toBe(runWrapper(["schedule", at]).pmsetArgv[2]);
  });

  // F01-QA-follow-up: the horizon guard is a strict `-lt`, matching the plan's "less than 365
  // days" — a few seconds under 365 days must still be accepted.
  it("accepts a timestamp just under 365 days out", () => {
    const r = runWrapper(["schedule", iso(Date.now() + 365 * 86_400_000 - 60_000)]);
    expect(r.code).toBe(0);
    expect(r.pmsetArgv[0]).toBe("schedule");
  });
});

describe("chimera-wake wrapper — rejected before pmset is ever reached", () => {
  const rejected: [string, string[]][] = [
    ["no arguments at all", []],
    ["a shell metacharacter payload", ["schedule", "; rm -rf /"]],
    ["a path-traversal payload", ["schedule", "../../x"]],
    ["a relative time", ["schedule", "+10min"]],
    ["a flag where a timestamp belongs", ["schedule", "--help"]],
    ["millisecond resolution", ["schedule", "2099-01-01T00:00:00.000Z"]],
    ["a local (non-Z) timestamp", ["schedule", "2099-01-01T00:00:00"]],
    ["a past timestamp", ["schedule", "2020-01-01T00:00:00Z"]],
    ["a timestamp more than 365 days out", ["schedule", iso(Date.now() + 400 * 86_400_000)]],
    // F01-QA-follow-up: exactly 365 days out was wrongly accepted under the old `-le` guard
    // (the plan says "less than 365 days"); `-lt` now rejects the boundary. The +5s pad clears
    // the JS-Date.now()-to-shell-`date`-call gap so this can't flake into the accepted branch.
    // Computed when the file is collected, not when the case runs: under a loaded full-suite run
    // a 5s margin elapsed before the case ran and the timestamp fell back inside the horizon.
    ["a timestamp just over 365 days out (the old boundary)", ["schedule", iso(Date.now() + 365 * 86_400_000 + 3_600_000)]],
    ["schedule with no timestamp", ["schedule"]],
    ["schedule with two words", ["schedule", "a", "b"]],
    ["schedule with a valid timestamp plus a stowaway word", ["schedule", IN_ONE_HOUR, "extra"]],
    ["probe with an extra word", ["probe", "x"]],
    ["an unknown verb", ["cancelall"]],
    ["pmset itself as a verb", ["pmset", "-a", "sleep", "0"]],
    ["an impossible date the whitelist shape allows", ["schedule", "2099-02-30T00:00:00Z"]],
  ];

  for (const [name, args] of rejected) {
    it(`rejects ${name} with exit 2 and no pmset call`, () => {
      const r = runWrapper(args);
      expect(r.code).toBe(2);
      expect(r.pmsetArgv).toEqual([]);
      expect(r.stderr).not.toBe("");
    });
  }
});

describe("chimera-wake wrapper — source guarantees", () => {
  const src = readFileSync(WRAPPER, "utf8");

  it("never contains a cancel-everything verb or a global pmset write, not even in a comment", () => {
    // The daemon's authority is bounded by this file's text; a QA grep over it is the cheapest
    // possible regression test for "someone widened the wrapper".
    expect(src).not.toContain("cancelall");
    expect(src).not.toContain("pmset -a");
  });

  it("pins PATH, IFS and umask because it runs as root", () => {
    expect(src).toMatch(/^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/m);
    expect(src).toMatch(/^IFS='\t\n'$/m);
    expect(src).toMatch(/^umask 022$/m);
  });

  it("gates the test-only PATH seam on a non-root uid", () => {
    expect(src).toMatch(/CHIMERA_WAKE_TEST_PATH[\s\S]{0,120}id -u.*-ne 0/);
  });

  it("takes the owner tag from a literal, never from argv", () => {
    expect(src).toMatch(/^OWNER=chimera\b/m);
  });
});
