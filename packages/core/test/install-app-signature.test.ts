import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const helper = fileURLToPath(new URL("../../../scripts/install-app.sh", import.meta.url));
function run(mode: string, identity = "dev.chimera.desktop", configured = "") {
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
    set -euo pipefail
    source "$1"
    mode="$2"; identity="$3"; APPLE_SIGNING_IDENTITY="$4"; repaired=0
    plutil() { printf '%s\\n' "$identity"; }
    codesign() {
      case "$1" in
        --verify) [ "$mode" = valid ] || { [ "$repaired" = 1 ] && [ "$mode" != verifyfails ]; } ;;
        -dv)
          [ "$mode" != unreadable ] || return 1
          if [ "$mode" = developer ]; then printf 'Authority=Developer ID Application: Example\\nTeamIdentifier=1234567890\\n';
          elif [ "$mode" = damaged ]; then printf 'Signature=adhoc\\n';
          else printf 'flags=0x20002(adhoc,linker-signed)\\nSignature=adhoc\\nTeamIdentifier=not set\\nSealed Resources=none\\nInternal requirements=none\\n'; fi ;;
        --force) printf 'SIGN'; printf ' <%s>' "$@"; printf '\\n'; repaired=1 ;;
        *) return 90 ;;
      esac
    }
    prepare_macos_app_signature '/tmp/app with spaces.app' '/tmp/entitlements.plist' dev.chimera.desktop
  `, "test", helper, mode, identity, configured], { encoding: "utf8", env: { PATH: "/nonexistent" }, timeout: 5000 });
}
describe.skipIf(process.platform === "win32")("local macOS app bundle signing", () => {
  it("preserves an already valid signature", () => {
    const r = run("valid"); expect(r.status).toBe(0); expect(r.stdout).toBe("");
  });
  it("seals the linker-signed bundle with the declared identity and existing entitlements", () => {
    const r = run("linker"); expect(r.status).toBe(0);
    expect(r.stdout).toContain("<--identifier> <dev.chimera.desktop>");
    expect(r.stdout).toContain("<--entitlements> </tmp/entitlements.plist> </tmp/app with spaces.app>");
  });
  it.each(["developer", "damaged", "unreadable"])("refuses to replace a %s signature", mode => {
    const r = run(mode); expect(r.status).not.toBe(0); expect(r.stdout).toBe("");
  });
  it("fails when the repaired bundle still fails verification", () => {
    expect(run("verifyfails").status).not.toBe(0);
  });
  it("refuses a different bundle identity", () => {
    const r = run("linker", "other.app"); expect(r.status).not.toBe(0); expect(r.stdout).toBe("");
  });
  it("does not hide a failed configured signing identity with ad-hoc fallback", () => {
    const r = run("linker", "dev.chimera.desktop", "Developer ID Application: Example");
    expect(r.status).not.toBe(0); expect(r.stdout).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("macOS permission identity continuity", () => {
  function continuity(mode: string) {
    return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `
      set -euo pipefail
      source "$1"
      mode="$2"
      codesign() {
        case "$1" in
          -d) [ "$mode" != unreadable ] || return 1; printf 'Executable=/old/app\n# designated => identifier "dev.chimera.desktop" and anchor trusted\n' ;;
          --verify) printf '%s\n' "$@"; [ "$mode" = same ] ;;
        esac
      }
      verify_macos_permission_continuity /tmp '/tmp/replacement app'
    `, "test", helper, mode], { encoding: "utf8", env: { PATH: "/nonexistent" } });
  }
  it("accepts a replacement satisfying the existing designated requirement", () => {
    const r = continuity("same"); expect(r.status).toBe(0);
    expect(r.stdout).toContain('=identifier "dev.chimera.desktop" and anchor trusted');
  });
  it.each(["different", "unreadable"])("refuses %s signing identity before replacing the installed app", mode => {
    expect(continuity(mode).status).not.toBe(0);
  });
});
