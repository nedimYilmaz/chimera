#!/usr/bin/env bash
# launchctl bootout returns before launchd finishes removing the job. Keep the
# old process quiescent before dependency writes and before loading its replacement.
unload_install_launchd() {
  local target="$1" attempt
  launchctl bootout "$target" >/dev/null 2>&1 || true
  for ((attempt = 0; attempt < 150; attempt++)); do
    if ! launchctl print "$target" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  fail "Timed out waiting for $target to unload. Installation stopped; inspect: launchctl print $target"
}

bootstrap_install_launchd() {
  local domain="$1" label="$2" plist="$3" attempt error
  # A disabled job cannot bootstrap, so enable it before trying to load it.
  launchctl enable "$domain/$label" || fail "Could not enable $domain/$label."
  # Even after print stops finding the old job, launchd can briefly report an
  # in-progress removal as bootstrap error 5. Retry only within a bounded window.
  for ((attempt = 0; attempt < 5; attempt++)); do
    if error=$(launchctl bootstrap "$domain" "$plist" 2>&1); then
      return 0
    fi
    if [ "$attempt" -lt 4 ]; then sleep 0.2; fi
  done
  printf '%s\n' "$error" >&2
  fail "Could not load $domain/$label. Inspect the plist with: plutil -lint \"$plist\". After resolving the launchd error, run: chimera start"
}
