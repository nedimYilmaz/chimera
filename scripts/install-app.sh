#!/usr/bin/env bash
# Tauri productName is the bundle label; Cargo names the running executable.
APP_EXECUTABLE="chimera-app"

quit_app_if_running() {
  APP_WAS_RUNNING=0
  if [ "$OS" = "Darwin" ] && pgrep -x "$APP_EXECUTABLE" >/dev/null 2>&1; then
    APP_WAS_RUNNING=1
    if [ "$DRY_RUN" -eq 1 ]; then
      dry "quit the $APP_NAME desktop app gracefully (osascript quit; pkill fallback after 10s)"
    else
      info "Quitting the $APP_NAME desktop app..."
      osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -x "$APP_EXECUTABLE" >/dev/null 2>&1 || break
        sleep 1
      done
      if pgrep -x "$APP_EXECUTABLE" >/dev/null 2>&1; then
        warn "$APP_NAME app still running after graceful quit; force-stopping."
        pkill -x "$APP_EXECUTABLE" 2>/dev/null || true
      fi
    fi
  fi
}


# Local Tauri builds may leave only the linker's executable signature. Seal the
# complete bundle so macOS can attribute permissions to its declared app identity.
# Never replace a failed Developer ID signature with an ad-hoc signature.
prepare_macos_app_signature() {
  local bundle="$1" entitlements="$2" expected_id="$3" actual_id details
  actual_id=$(plutil -extract CFBundleIdentifier raw -o - "$bundle/Contents/Info.plist") || return 1
  if [ "$actual_id" != "$expected_id" ]; then
    printf 'Refusing to sign unexpected app identity: %s\n' "$actual_id" >&2
    return 1
  fi
  if codesign --verify --deep --strict "$bundle" 2>/dev/null; then return 0; fi
  details=$(codesign -dv "$bundle" 2>&1) || {
    printf 'App signature is missing or unreadable; refusing automatic repair.\n' >&2
    return 1
  }
  case "$details" in
    *Authority=*)
      printf 'Signed app verification failed; rebuild with its signing identity.\n' >&2
      return 1 ;;
  esac
  case "$details" in
    *Signature=adhoc*) ;;
    *) printf 'Refusing to replace a non-ad-hoc signature.\n' >&2; return 1 ;;
  esac
  case "$details" in
    *linker-signed*) ;;
    *) printf 'App signature is damaged; refusing automatic repair.\n' >&2; return 1 ;;
  esac
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && [ "$APPLE_SIGNING_IDENTITY" != "-" ]; then
    printf 'Configured signing identity was not applied; refusing ad-hoc fallback.\n' >&2
    return 1
  fi
  codesign --force --sign - --identifier "$expected_id" --entitlements "$entitlements" "$bundle" || return 1
  codesign --verify --deep --strict "$bundle"
}

# TCC remembers the installed app's designated requirement, not just its name.
# Test the replacement against that identity before replacing the app.
verify_macos_permission_continuity() {
  local installed="$1" replacement="$2" details requirement="" line
  [ -d "$installed" ] || return 0
  details=$(codesign -d -r- "$installed" 2>&1) || {
    printf 'Cannot read the installed app signing identity; preserving the installed app.\n' >&2
    return 1
  }
  while IFS= read -r line; do
    case "$line" in
      'designated => '*) requirement="${line#designated => }" ;;
      '# designated => '*) requirement="${line#\# designated => }" ;;
    esac
  done <<< "$details"
  if [ -z "$requirement" ] || ! codesign --verify --deep --strict -R "=$requirement" "$replacement" 2>/dev/null; then
    printf 'The replacement changes the macOS permission identity. Installation stopped; the existing app and its permissions are preserved.\nBuild with the same Developer ID Application signing identity. Ad-hoc rebuilds cannot preserve an older binary hash identity.\n' >&2
    return 1
  fi
}
