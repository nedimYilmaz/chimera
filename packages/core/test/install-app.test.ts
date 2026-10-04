import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../../../scripts/install-app.sh", import.meta.url));
function run(running: boolean, graceful: boolean, dry = false, os = "Darwin") {
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
    set -euo pipefail
    source "$1"
    OS="$2"; DRY_RUN="$3"; APP_NAME=chimera; running="$4"; graceful="$5"
    info() { :; }; warn() { :; }; dry() { printf 'DRY\\n'; }
    pgrep() { [ "$*" = '-x chimera-app' ] || exit 91; [ "$running" = 1 ]; }
    pkill() { [ "$*" = '-x chimera-app' ] || exit 92; printf 'KILL\\n'; running=0; }
    osascript() { printf 'QUIT\\n' >&3; if [ "$graceful" = 1 ]; then running=0; fi; }
    sleep() { :; }
    quit_app_if_running
    printf 'WAS:%s RUNNING:%s\\n' "$APP_WAS_RUNNING" "$running"
  `, "test", helper, os, dry ? "1" : "0", running ? "1" : "0", graceful ? "1" : "0"], {
    encoding: "utf8", env: { PATH: "/nonexistent" }, stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 5000,
  });
}
describe.skipIf(process.platform === "win32")("desktop upgrade process lifecycle", () => {
  it("recognizes the Cargo executable and remembers to relaunch after graceful quit", () => {
    const r = run(true, true);
    expect(r.status).toBe(0); expect(r.output[3]).toBe("QUIT\n");
    expect(r.stdout).toBe("WAS:1 RUNNING:0\n");
  });
  it("force-stops only the desktop executable if graceful quit times out", () => {
    const r = run(true, false);
    expect(r.status).toBe(0); expect(r.stdout).toBe("KILL\nWAS:1 RUNNING:0\n");
  });
  it("does not launch an app that was closed before installing", () => {
    const r = run(false, true);
    expect(r.status).toBe(0); expect(r.output[3]).toBe(""); expect(r.stdout).toBe("WAS:0 RUNNING:0\n");
  });
  it("dry-run detects the app without quitting it", () => {
    const r = run(true, true, true);
    expect(r.status).toBe(0); expect(r.output[3]).toBe(""); expect(r.stdout).toBe("DRY\nWAS:1 RUNNING:1\n");
  });
  it("does not touch a same-named process on Linux", () => {
    const r = run(true, true, false, "Linux");
    expect(r.status).toBe(0); expect(r.output[3]).toBe(""); expect(r.stdout).toBe("WAS:0 RUNNING:1\n");
  });
});
