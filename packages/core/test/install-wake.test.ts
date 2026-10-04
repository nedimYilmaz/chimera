import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// F01(a), operator half: scripts/install.sh --enable-wake / --disable-wake. These write a NOPASSWD
// sudoers rule on a real machine, so the tests never leave the dry-run and refusal paths — and
// "nothing was written" is PROVEN, not assumed: a stub sudo/visudo/install goes first on PATH and
// every one of these cases asserts its argv log is still empty.

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");
const WRAPPER_SRC = path.join(REPO_ROOT, "scripts", "chimera-wake.sh");

const STUB = `#!/bin/sh
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$PRIV_LOG"
exit 1
`;

type Run = { code: number; stdout: string; stderr: string; privileged: string[] };

function runInstall(args: string[], env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(path.join(tmpdir(), "chimera-install-wake-"));
  const stubDir = path.join(dir, "bin");
  mkdirSync(stubDir);
  for (const bin of ["sudo", "visudo", "install"]) {
    writeFileSync(path.join(stubDir, bin), STUB, { mode: 0o755 });
  }
  const log = path.join(dir, "priv.log");
  const r = spawnSync("bash", [INSTALL_SH, ...args], {
    encoding: "utf8",
    // spawnSync's stdin is a pipe, so `[ ! -t 0 ]` is true — this is the non-interactive case by
    // construction, which is exactly what the refusal guards are for.
    env: { ...process.env, PATH: `${stubDir}:${process.env["PATH"] ?? ""}`, PRIV_LOG: log, ...env },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    privileged: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
}

/** The §2.11 ancestor rule, evaluated from the test so the A9 assertion is correct on BOTH an
 *  Apple-Silicon Mac (/usr/local is root:wheel 0755 → prints) and an Intel/Homebrew one
 *  (/usr/local is <user>:admin → refuses). Either outcome is a pass; a third would be a bug. */
function usrLocalIsSafe(): boolean {
  try {
    const st = statSync("/usr/local");
    return st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

const darwin = describe.skipIf(process.platform !== "darwin");

darwin("install.sh --enable-wake (dry run)", () => {
  it("prints the wrapper source, the sudoers line and the undo, and invokes nothing privileged", () => {
    const r = runInstall(["--enable-wake"], { CHIMERA_INSTALL_DRY_RUN: "1" });
    expect(r.privileged).toEqual([]);
    if (!usrLocalIsSafe()) {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("privilege-escalation hole — refusing to install");
      return;
    }
    expect(r.code).toBe(0);
    // The printed wrapper is the checked-in file itself, not a heredoc that can drift from it.
    expect(r.stdout).toContain(readFileSync(WRAPPER_SRC, "utf8").trimEnd());
    expect(r.stdout).toContain("NOPASSWD: /usr/local/libexec/chimera-wake");
    expect(r.stdout).toContain("/etc/sudoers.d/chimera-wake");
    expect(r.stdout).toContain("./scripts/install.sh --disable-wake");
    expect(r.stdout).toContain("would install /usr/local/libexec/chimera-wake (root:wheel 0755)");
    // The unattended-agent consequence is part of the informed consent, not an afterthought.
    expect(r.stdout).toMatch(/maxBudgetUsd and overlapPolicy/);
  });

  it("prints before it would write: the sudoers text appears above the dry-run marker", () => {
    const r = runInstall(["--enable-wake"], { CHIMERA_INSTALL_DRY_RUN: "1" });
    if (!usrLocalIsSafe()) return;
    expect(r.stdout.indexOf("NOPASSWD:")).toBeLessThan(r.stdout.indexOf("[dry-run]"));
  });
});

describe("install.sh --enable-wake refusals", () => {
  it("refuses non-interactively without dry-run, before touching sudo", () => {
    const r = runInstall(["--enable-wake"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("requires an interactive terminal to confirm a sudoers change");
    expect(r.privileged).toEqual([]);
  });

  it("refuses --enable-wake combined with --uninstall", () => {
    const r = runInstall(["--enable-wake", "--uninstall"], { CHIMERA_INSTALL_DRY_RUN: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("standalone commands");
    expect(r.privileged).toEqual([]);
  });

  it("refuses --enable-wake combined with --disable-wake", () => {
    const r = runInstall(["--enable-wake", "--disable-wake"], { CHIMERA_INSTALL_DRY_RUN: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("opposites");
    expect(r.privileged).toEqual([]);
  });

  it("refuses --enable-wake combined with a build flag", () => {
    const r = runInstall(["--enable-wake", "--no-app"], { CHIMERA_INSTALL_DRY_RUN: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--no-app");
    expect(r.privileged).toEqual([]);
  });

  it("prints the macOS-only failure on a simulated non-Darwin OS", () => {
    const r = runInstall(["--enable-wake"], { CHIMERA_INSTALL_DRY_RUN: "1", CHIMERA_INSTALL_OS: "Linux" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("wake scheduling is macOS-only (pmset)");
    expect(r.stderr).toContain("late-and-coalesces");
    expect(r.privileged).toEqual([]);
  });
});

describe("install.sh --disable-wake", () => {
  it("dry-runs to a plan that cancels events one by one and removes both files", () => {
    const r = runInstall(["--disable-wake"], { CHIMERA_INSTALL_DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/usr/local/libexec/chimera-wake");
    expect(r.stdout).toContain("/etc/sudoers.d/chimera-wake");
    expect(r.stdout).toContain("one by one");
    expect(r.privileged).toEqual([]);
  });

  it("is reached by --uninstall, so a NOPASSWD rule is never left behind", () => {
    const r = runInstall(["--uninstall"], { CHIMERA_INSTALL_DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/etc/sudoers.d/chimera-wake");
    expect(r.privileged).toEqual([]);
  });
});

describe("install.sh wake source guarantees", () => {
  const src = readFileSync(INSTALL_SH, "utf8");

  it("resolves visudo with an absolute fallback instead of trusting PATH", () => {
    // /usr/sbin is not on every login PATH; a bare `visudo` here would roll a half-done install
    // back with a message blaming the sudoers text for a missing binary.
    expect(src).toContain("visudo_bin=/usr/sbin/visudo");
    expect(src).toContain('"$visudo_bin" -cf');
    expect(src).not.toMatch(/^\s*if ! visudo -cf/m);
  });

  it("never names a cancel-everything pmset verb, so --disable-wake can't wipe the operator's own events", () => {
    expect(src).not.toContain("cancelall");
  });
});

describe("install.sh --help", () => {
  it("documents both wake flags as standalone", () => {
    const r = runInstall(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--enable-wake");
    expect(r.stdout).toContain("--disable-wake");
    expect(r.privileged).toEqual([]);
  });
});
