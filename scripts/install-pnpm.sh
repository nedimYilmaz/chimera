#!/usr/bin/env bash
# Sourced by install.sh. Never replace a user's global package manager or enable
# Corepack shims just to build this repository. Keep argv as an array (no eval).
select_install_pnpm() {
  local required_version="$1"
  local installed_version="unavailable"
  PNPM_CMD=(pnpm)
  if command -v pnpm >/dev/null 2>&1; then
    installed_version="$(pnpm --version 2>/dev/null)" || installed_version="unavailable"
  fi
  if [ "$installed_version" != "$required_version" ]; then
    if ! command -v npx >/dev/null 2>&1; then
      fail "pnpm $required_version is required and npm/npx is unavailable. Install Node.js with npm, or install pnpm $required_version, then re-run scripts/install.sh."
      return 1
    fi
    PNPM_CMD=(npx --yes --registry=https://registry.npmjs.org "pnpm@$required_version")
    if [ "${DRY_RUN:-0}" -eq 1 ]; then
      info "Would use pnpm $required_version through npx for this install only; global pnpm is unchanged (no download in dry-run)."
      return 0
    fi
    info "Selecting pnpm $required_version through npx for this install only; global pnpm is unchanged."
    if ! installed_version="$("${PNPM_CMD[@]}" --version)"; then
      fail "Could not load pnpm $required_version through npx. Check access to registry.npmjs.org and retry. No build was started."
      return 1
    fi
    if [ "$installed_version" != "$required_version" ]; then
      fail "The selected pnpm did not report $required_version. Refusing to install with an unverified package-manager version."
      return 1
    fi
  fi
  info "pnpm $installed_version OK"
}
