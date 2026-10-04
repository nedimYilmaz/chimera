import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../../../scripts/install-launchd.sh", import.meta.url));

// Shell functions replace launchctl and sleep: the real user service is never touched.
function install(stubs: string) {
  const state = mkdtempSync(join(tmpdir(), "chimera-launchd-test-"));
  try {
    return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
      set -euo pipefail
      fail() { printf '%s\\n' "$1" >&2; exit 1; }
      sleep() { :; }
      ${stubs}
      source "$1"
      unload_install_launchd gui/502/com.chimera.test
      bootstrap_install_launchd gui/502 com.chimera.test '/tmp/test service.plist'
      printf 'READY\\n'
    `, "test", helper], {
      encoding: "utf8",
      env: { PATH: "/nonexistent", TEST_STATE: state },
      timeout: 5_000,
    });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("installer launchd lifecycle", () => {
  it("waits until the old job disappears before enabling and bootstrapping", () => {
    const r = install(`
      polls=0
      enabled=0
      launchctl() {
        case "$1" in
          bootout) return 0 ;;
          print) polls=$((polls + 1)); [ "$polls" -lt 4 ] ;;
          enable) [ "$polls" -eq 4 ] || return 91; enabled=1 ;;
          bootstrap)
            [ "$enabled" -eq 1 ] && [ "$polls" -eq 4 ] &&
              [ "$2" = gui/502 ] && [ "$3" = '/tmp/test service.plist' ] ;;
          *) return 99 ;;
        esac
      }
    `);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("READY");
    expect(r.stderr).toBe("");
  });

  it("retries a transient bootstrap failure after an already unloaded job", () => {
    const r = install(`
      launchctl() {
        case "$1" in
          bootout|print) return 3 ;;
          enable) return 0 ;;
          bootstrap)
            if [ ! -f "$TEST_STATE/retried" ]; then
              printf 'Bootstrap failed: 5: Input/output error\\n' >&2
              : > "$TEST_STATE/retried"
              return 5
            fi ;;
          *) return 99 ;;
        esac
      }
    `);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("READY");
    expect(r.stderr).toBe("");
  });

  it("stops on an unload timeout without trying to load another job", () => {
    const r = install(`
      launchctl() {
        case "$1" in
          bootout|print) return 0 ;;
          *) printf 'UNEXPECTED' >&2; return 99 ;;
        esac
      }
    `);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Timed out waiting");
    expect(r.stderr).not.toContain("UNEXPECTED");
    expect(r.stdout).not.toContain("READY");
  });

  it("bounds bootstrap retries and reports the original error", () => {
    const r = install(`
      launchctl() {
        case "$1" in
          bootout|print) return 3 ;;
          enable) return 0 ;;
          bootstrap) printf 'Invalid service definition\\n' >&2; return 5 ;;
          *) return 99 ;;
        esac
      }
      sleeps=0
      sleep() { sleeps=$((sleeps + 1)); [ "$sleeps" -le 4 ] || exit 99; }
    `);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Invalid service definition");
    expect(r.stderr).toContain("chimera start");
    expect(r.stdout).not.toContain("READY");
  });

  it("does not attempt bootstrap when enabling fails", () => {
    const r = install(`
      launchctl() {
        case "$1" in
          bootout|print|enable) return 3 ;;
          *) printf 'UNEXPECTED' >&2; return 99 ;;
        esac
      }
    `);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Could not enable");
    expect(r.stderr).not.toContain("UNEXPECTED");
  });

  it("uses the wait at both the pre-build stop and final service swap", () => {
    const source = readFileSync(new URL("../../../scripts/install.sh", import.meta.url), "utf8");
    expect(source).toContain('source "$REPO_ROOT/scripts/install-launchd.sh"');
    expect(source.match(/unload_install_launchd "gui\/\$\{UID_NUM\}\/\$\{LAUNCHD_LABEL\}"/g)).toHaveLength(2);
    expect(source).toContain('bootstrap_install_launchd "gui/${UID_NUM}" "$LAUNCHD_LABEL" "$PLIST_PATH"');
  });
});
