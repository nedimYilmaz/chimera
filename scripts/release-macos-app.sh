#!/usr/bin/env bash
# MACOS-SIGN-NOTARIZE: builds the Tauri desktop app DMG signed + notarized for Developer ID
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
  echo "see docs/RELEASE-SIGNING.md. Refusing to build an unsigned/unnotarized release DMG." >&2
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
echo "building signed + notarized DMG (this can take several minutes while Apple notarizes)..."
# `app` must be listed too: with only `dmg`, Tauri deletes the intermediate .app once the DMG is
# built, and both the checks below and package-macos-release.mjs (the installer's tar.gz) need it.
(cd packages/app && pnpm tauri build --bundles app,dmg)

APP_PATH="packages/app/src-tauri/target/release/bundle/macos/chimera.app"
fresh_dmgs=()
while IFS= read -r -d '' artifact; do fresh_dmgs+=("$artifact"); done < <(find packages/app/src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -newer "$release_marker" -print0)
if [ "${#fresh_dmgs[@]}" -ne 1 ]; then
  echo "error: expected exactly one freshly built DMG; refusing to validate a stale or ambiguous artifact" >&2
  exit 1
fi
DMG_PATH="${fresh_dmgs[0]}"

if [ ! -d "$APP_PATH" ] || [ -z "$DMG_PATH" ]; then
  echo "error: build did not produce the expected .app/.dmg -- check the tauri build output above" >&2
  exit 1
fi

echo
echo "=== verification: $APP_PATH ==="
codesign -dv --verbose=4 "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl -a -t execute -v "$APP_PATH"
xcrun stapler validate "$APP_PATH"

echo
echo "=== verification: $DMG_PATH ==="
spctl -a -t open --context context:primary-signature -v "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
node scripts/release-checksums.mjs "$DMG_PATH"

echo
echo "all checks passed: $DMG_PATH is signed, notarized, and stapled."
