#!/usr/bin/env bash
# MACOS-SIGN-NOTARIZE: builds the Tauri desktop .app signed + notarized for Developer ID
# distribution. See docs/RELEASE-SIGNING.md for the full one-time setup checklist (certificate,
# app-specific password, env vars) -- this script only drives the build once that setup is done.
#
# Tauri's own bundler does the actual signing/notarizing/stapling (crates/tauri-bundler, driven
# by `tauri build`) when it sees the right APPLE_* env vars -- this script does NOT call
# codesign/notarytool/stapler itself for the build. It (1) fails fast with a clear error if
# required env vars are missing, instead of silently producing an unsigned or unnotarized
# artifact, and (2) runs the same verification commands the owner would run by hand afterward,
# so a broken signature/notarization is caught here rather than on a user's machine.
#
# Required env (see docs/RELEASE-SIGNING.md -- never hard-code these, never pass on argv):
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: <name> (<team id>)", must already be in
#                            this machine's keychain (`security find-identity -v -p codesigning`)
#   APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID     Apple ID + app-specific password + team id, OR
#   APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH   App Store Connect API key, instead
#
# Usage: scripts/release-macos-app.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ "$(uname -s)" = "Darwin" ] || { echo "error: macOS release signing must run on macOS" >&2; exit 1; }
case "${APPLE_SIGNING_IDENTITY:-}" in
  "Developer ID Application: "*) ;;
  *) echo "error: a Developer ID Application signing identity is required; ad-hoc/local/App Store identities are not release identities" >&2; exit 1 ;;
esac
case "${1:-}" in
  ""|--check) ;;
  *) echo "usage: scripts/release-macos-app.sh [--check]" >&2; exit 1 ;;
esac

missing=()
[ -z "${APPLE_SIGNING_IDENTITY:-}" ] && missing+=(APPLE_SIGNING_IDENTITY)

if [ -n "${APPLE_ID:-}" ] || [ -n "${APPLE_PASSWORD:-}" ] || [ -n "${APPLE_TEAM_ID:-}" ]; then
  [ -z "${APPLE_ID:-}" ] && missing+=(APPLE_ID)
  [ -z "${APPLE_PASSWORD:-}" ] && missing+=(APPLE_PASSWORD)
  [ -z "${APPLE_TEAM_ID:-}" ] && missing+=(APPLE_TEAM_ID)
elif [ -n "${APPLE_API_KEY:-}" ] || [ -n "${APPLE_API_ISSUER:-}" ] || [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  [ -z "${APPLE_API_KEY:-}" ] && missing+=(APPLE_API_KEY)
  [ -z "${APPLE_API_ISSUER:-}" ] && missing+=(APPLE_API_ISSUER)
  [ -z "${APPLE_API_KEY_PATH:-}" ] && missing+=(APPLE_API_KEY_PATH)
else
  missing+=("APPLE_ID+APPLE_PASSWORD+APPLE_TEAM_ID (or APPLE_API_KEY+APPLE_API_ISSUER+APPLE_API_KEY_PATH)")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "error: missing required env var(s) for a signed+notarized build:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "see docs/RELEASE-SIGNING.md. Refusing to build an unsigned/unnotarized release app." >&2
  exit 1
fi

if [ -z "${APPLE_CERTIFICATE:-}" ]; then
  security find-identity -v -p codesigning | grep -F -- "\"$APPLE_SIGNING_IDENTITY\"" >/dev/null || {
    echo "error: the requested Developer ID identity is not available in the keychain" >&2; exit 1;
  }
fi
if [ "${1:-}" = "--check" ]; then
  echo "local prerequisites present; Apple credentials have NOT been validated online; no build performed"
  exit 0
fi

release_marker="$(mktemp -t chimera-release)"
trap 'rm -f -- "$release_marker"' EXIT
echo "building the signed + notarized app (this can take several minutes while Apple notarizes)..."
# Only the .app ships: package-macos-release.mjs tars it for the installer. Tauri notarizes the
# .app but not a DMG, so a DMG bundle was a second, unnotarized artifact nothing published.
node --test scripts/sign-desktop-runtime.test.mjs
node scripts/build-desktop-runtime.mjs
node scripts/test-desktop-runtime.mjs
node scripts/sign-desktop-runtime.mjs
(cd packages/app && pnpm tauri build --config src-tauri/tauri.standalone.conf.json --bundles app)

APP_PATH="packages/app/src-tauri/target/release/bundle/macos/chimera.app"
# Refuse to validate a stale bundle left by an earlier local build.
# Info.plist is rewritten by every build; the bundle directory's own mtime need not change.
if [ ! -f "$APP_PATH/Contents/Info.plist" ] || [ -z "$(find "$APP_PATH/Contents/Info.plist" -newer "$release_marker")" ]; then
  echo "error: build did not produce a fresh $APP_PATH -- check the tauri build output above" >&2
  exit 1
fi

echo
echo "=== verification: $APP_PATH ==="
codesign -dv --verbose=4 "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl -a -t execute -v "$APP_PATH"
xcrun stapler validate "$APP_PATH"

echo
echo "all checks passed: $APP_PATH is signed, notarized, and stapled."
