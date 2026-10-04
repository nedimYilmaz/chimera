#!/usr/bin/env bash
# Chimera installer/upgrader/uninstaller: prereq check, git pull, workspace
# build, PATH bins, app bundle install, auto-start service. Idempotent — safe
# to re-run, and a re-run on a machine with an existing install is a full
# zero-touch upgrade: pulls latest code, stops the daemon + desktop app,
# rebuilds, reinstalls the app bundle, and brings everything back up.
# Pass --uninstall to reverse everything (see below). macOS is the primary
# target; Linux is best-effort.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${CHIMERA_INSTALL_PREFIX:-$HOME/.local/bin}"
LAUNCHD_LABEL="${CHIMERA_LAUNCHD_LABEL:-com.chimera.chimerad}"
SYSTEMD_UNIT="${CHIMERA_SYSTEMD_UNIT:-chimerad.service}"
CHIMERA_HOME_DIR="${CHIMERA_HOME:-$HOME/.chimera}"
BUILD_APP=1
SKIP_SERVICE=0
DO_PULL=1
UNINSTALL=0
PURGE_DATA=0
ENABLE_WAKE=0
DISABLE_WAKE=0
NODE_MIN_MAJOR=24
PNPM_VERSION="11.11.0"
# Must match packages/app/src-tauri/tauri.conf.json's "productName"/"identifier"
# — that's the .app bundle name and the bundle id we use to
# confirm a bundle under /Applications is actually ours before deleting it.
APP_NAME="chimera"
APP_BUNDLE_ID="dev.chimera.desktop"
# Escape hatch for verifying the upgrade/uninstall sequencing without
# touching a real daemon, app, git checkout, or data directory.
DRY_RUN="${CHIMERA_INSTALL_DRY_RUN:-0}"
# Overridable purely for test isolation (fake footprints). The install path
# always picks whichever of these is writable; uninstall must check both,
# since either could hold a bundle from a past install.
IFS=' ' read -r -a APPS_DIR_CANDIDATES <<< "${CHIMERA_INSTALL_APPS_DIRS:-/Applications $HOME/Applications}"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!!\033[0m %s\n' "$1" >&2; }
fail()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }
dry()   { printf '\033[1;36m[dry-run]\033[0m would %s\n' "$1"; }

BUILD_FLAGS_SEEN=()
for arg in "$@"; do
  case "$arg" in
    --with-app) BUILD_APP=1; BUILD_FLAGS_SEEN+=("--with-app") ;;
    --no-app) BUILD_APP=0; BUILD_FLAGS_SEEN+=("--no-app") ;;
    --no-service) SKIP_SERVICE=1; BUILD_FLAGS_SEEN+=("--no-service") ;;
    --no-pull) DO_PULL=0; BUILD_FLAGS_SEEN+=("--no-pull") ;;
    --uninstall) UNINSTALL=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    --enable-wake) ENABLE_WAKE=1 ;;
    --disable-wake) DISABLE_WAKE=1 ;;
    -h|--help)
      echo "usage: scripts/install.sh [--no-app] [--no-service] [--no-pull]"
      echo "       scripts/install.sh --uninstall [--purge-data]"
      echo "       scripts/install.sh --enable-wake | --disable-wake"
      echo "  (default)      builds the Tauri desktop app — the primary interface — auto-installing Rust/cargo via rustup if missing"
      echo "  --no-app       skip building the desktop app (daemon/CLI still install)"
      echo "  --with-app     (default, kept for back-compat) build the desktop app"
      echo "  --no-service   skip installing the launchd/systemd auto-start service"
      echo "  --no-pull      don't git-pull before rebuilding (re-running is normally a full upgrade)"
      echo "  --uninstall    remove everything install/upgrade set up (service, bins, app bundle);"
      echo "                 \$CHIMERA_HOME (accounts/sessions/logs) is left in place unless --purge-data"
      echo "                 is also given. Cannot be combined with the build flags above."
      echo "  --purge-data   with --uninstall, also delete \$CHIMERA_HOME after a typed confirmation"
      echo "  --enable-wake  (macOS, standalone) opt in to RTC wake: install a root-owned wrapper and a"
      echo "                 NOPASSWD sudoers drop-in granting ONLY that wrapper, so the daemon can ask"
      echo "                 the Mac to wake shortly before a scheduled job. Prints everything it would"
      echo "                 write and requires a typed confirmation first."
      echo "  --disable-wake (standalone) reverse --enable-wake: cancel chimera's own wake events and"
      echo "                 remove both files. Also done automatically by --uninstall."
      echo
      echo "Re-running this script on a machine with an existing install is a zero-touch"
      echo "upgrade: it pulls the latest code, stops the daemon and desktop app, rebuilds,"
      echo "reinstalls the app bundle, and restarts whatever was running. Set"
      echo "CHIMERA_INSTALL_DRY_RUN=1 to print what an upgrade or uninstall would do without doing it."
      exit 0
      ;;
    *) fail "unknown option: $arg" ;;
  esac
done

if [ "$PURGE_DATA" -eq 1 ] && [ "$UNINSTALL" -eq 0 ]; then
  fail "--purge-data requires --uninstall (it only applies when uninstalling)."
fi
if [ "$UNINSTALL" -eq 1 ] && [ "${#BUILD_FLAGS_SEEN[@]}" -gt 0 ]; then
  fail "--uninstall can't be combined with ${BUILD_FLAGS_SEEN[*]} (those only apply to install/upgrade). Run: scripts/install.sh --uninstall"
fi
if [ "$ENABLE_WAKE" -eq 1 ] && [ "$DISABLE_WAKE" -eq 1 ]; then
  fail "--enable-wake and --disable-wake are opposites; pass exactly one."
fi
if { [ "$ENABLE_WAKE" -eq 1 ] || [ "$DISABLE_WAKE" -eq 1 ]; } && [ "$UNINSTALL" -eq 1 ]; then
  fail "--enable-wake/--disable-wake are standalone commands and can't be combined with --uninstall (--uninstall already removes wake scheduling). Run them separately."
fi
if { [ "$ENABLE_WAKE" -eq 1 ] || [ "$DISABLE_WAKE" -eq 1 ]; } && [ "${#BUILD_FLAGS_SEEN[@]}" -gt 0 ]; then
  fail "--enable-wake/--disable-wake are standalone commands and can't be combined with ${BUILD_FLAGS_SEEN[*]}. Run them separately."
fi
# Deterministic BEFORE any privileged step: --enable-wake ends in a sudoers change, and the one
# thing worse than refusing is appearing to succeed because a cached sudo ticket happened to exist.
if [ "$ENABLE_WAKE" -eq 1 ] && [ "$DRY_RUN" -ne 1 ] && [ ! -t 0 ]; then
  fail "--enable-wake requires an interactive terminal to confirm a sudoers change. Refusing to run non-interactively. Re-run in a terminal, or set CHIMERA_INSTALL_DRY_RUN=1 to see exactly what it would write."
fi
if [ "$PURGE_DATA" -eq 1 ] && [ "$DRY_RUN" -ne 1 ] && [ ! -t 0 ]; then
  fail "--purge-data requires an interactive terminal to confirm deleting $CHIMERA_HOME_DIR. Refusing to run non-interactively. Re-run in a terminal, or delete it manually if you're sure: rm -rf \"$CHIMERA_HOME_DIR\""
fi

# Overridable purely for test isolation, like DRY_RUN above: the macOS-only refusal in
# enable_wake() is otherwise unreachable from a test running on a Mac.
OS="${CHIMERA_INSTALL_OS:-$(uname -s)}"
UID_NUM="$(id -u)"

# Paths that both service install/removal and upgrade-footprint detection need.
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LAUNCHD_LABEL.plist"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$SYSTEMD_UNIT"

# Wake scheduling (--enable-wake). These three are CONSTANTS on purpose and deliberately have no
# env override: WAKE_WRAPPER is the exact string packages/core/src/wake.ts hard-codes as
# WAKE_WRAPPER_PATH and the exact string the sudoers rule grants. A configurable privileged path
# is a path someone else can point somewhere else.
WAKE_WRAPPER="/usr/local/libexec/chimera-wake"
WAKE_WRAPPER_DIR="/usr/local/libexec"
WAKE_SUDOERS="/etc/sudoers.d/chimera-wake"
WAKE_WRAPPER_SRC="$REPO_ROOT/scripts/chimera-wake.sh"

# ---------------------------------------------------------------------------
# Shared helpers (install/upgrade and uninstall both use these)
# ---------------------------------------------------------------------------

source "$REPO_ROOT/scripts/install-app.sh"

# ---------------------------------------------------------------------------
# Wake scheduling (macOS RTC wake) — the only privileged thing this installer
# can do. Opt-in, printed in full before anything is written, and reversible.
# ---------------------------------------------------------------------------

# A root-run 0755 script is only as safe as every directory above it: if a local user can write an
# ancestor, they can REPLACE the wrapper and get a passwordless root shell out of our sudoers rule.
# Homebrew on an Intel Mac owns /usr/local as <user>:admin — exactly this case — so this refuses
# rather than warns.
check_wake_ancestor() {
  local d="$1" u m
  u="$(stat -f '%u' "$d")"
  m="$(stat -f '%Lp' "$d")"
  if [ "$u" != "0" ] || [ $(( 8#$m & 8#0022 )) -ne 0 ]; then
    fail "$d is writable by a non-root user (owner uid $u, mode $m). A root-run wrapper under a user-writable directory is a local privilege-escalation hole — refusing to install. Fix with: sudo chown root:wheel $d && sudo chmod 755 $d  (note: on an Intel Mac this directory may belong to Homebrew; see INSTALL.md)."
  fi
}

# One function so the text PRINTED for review and the text actually installed can never drift.
# No argument pattern in the rule: sudoers argument matching is easy to get subtly wrong, and the
# wrapper's own whitelist is a stronger and more readable guarantee.
wake_sudoers_text() {
  cat <<EOF
# chimera: RTC wake scheduling. Installed by scripts/install.sh --enable-wake, removed by
# --disable-wake. This grants ONE root-owned script and nothing else — never /usr/bin/pmset.
$(id -un) ALL=(root) NOPASSWD: $WAKE_WRAPPER
EOF
}

enable_wake() {
  [ "$OS" = "Darwin" ] || fail "wake scheduling is macOS-only (pmset). On Linux the daemon still fires late-and-coalesces — see README."
  [ -f "$WAKE_WRAPPER_SRC" ] || fail "missing $WAKE_WRAPPER_SRC — run this from a chimera checkout."

  # visudo lives in /usr/sbin, which is NOT on every login PATH (verified missing on a real macOS
  # shell here). Resolved read-only up front, before anything is printed or written: reaching the
  # syntax gate with an unresolvable visudo would roll a half-done install back while blaming the
  # sudoers text for what is really a missing binary. Check mode needs no privilege
  # (`/usr/sbin/visudo -cf <file>` as a normal user → "parsed OK", rc=0).
  local visudo_bin
  visudo_bin="$(command -v visudo || true)"
  [ -n "$visudo_bin" ] || visudo_bin=/usr/sbin/visudo
  [ -x "$visudo_bin" ] || fail "cannot find visudo (looked on PATH and at /usr/sbin/visudo). Refusing to install $WAKE_SUDOERS unchecked — a malformed sudoers drop-in can lock you out of sudo entirely."

  check_wake_ancestor /usr/local
  # /usr/local/libexec usually doesn't exist yet. Creating it is a WRITE, so it happens in step 4
  # after the typed confirmation — no sudo, not even a mkdir, runs before the operator says yes.
  if [ -d "$WAKE_WRAPPER_DIR" ]; then check_wake_ancestor "$WAKE_WRAPPER_DIR"; fi

  local user probe_out tmp_sudoers confirm
  user="$(id -un)"
  echo
  info "RTC wake setup — NOTHING has been written yet. Read both files first."
  echo
  echo "1. $WAKE_WRAPPER  (root:wheel, mode 0755) — installed verbatim from $WAKE_WRAPPER_SRC:"
  echo "-----8<----- chimera-wake -----8<-----"
  cat "$WAKE_WRAPPER_SRC"
  echo "-----8<------------------------8<-----"
  echo
  echo "2. $WAKE_SUDOERS  (root:wheel, mode 0440):"
  echo "-----8<----- sudoers drop-in -----8<-----"
  wake_sudoers_text
  echo "-----8<---------------------------8<-----"
  echo
  echo "This lets user '$user' run that ONE script as root without a password. It grants no other"
  echo "command — not pmset itself. The script's entire authority is: schedule or cancel one"
  echo "wakeorpoweron event tagged 'chimera' at a validated future timestamp at most 365 days out."
  echo "Consequence to weigh: an RTC wake means this Mac wakes unattended and runs agents at 03:00,"
  echo "so maxBudgetUsd and overlapPolicy on your scheduled jobs matter more, not less."
  echo
  echo "Undo at any time with:  ./scripts/install.sh --disable-wake"
  echo

  if [ "$DRY_RUN" -eq 1 ]; then
    dry "install $WAKE_WRAPPER (root:wheel 0755) and $WAKE_SUDOERS (root:wheel 0440)"
    info "DRY RUN complete — nothing was written and sudo was never invoked."
    return
  fi

  [ -t 0 ] || fail "--enable-wake requires an interactive terminal to confirm a sudoers change. Refusing to proceed non-interactively."
  printf "Type 'yes' to install the two files above: "
  read -r confirm
  if [ "$confirm" != "yes" ]; then
    fail "Confirmation was not 'yes'; aborting. Nothing was written."
  fi

  info "Installing $WAKE_WRAPPER..."
  sudo mkdir -p "$WAKE_WRAPPER_DIR"
  # Re-checked AFTER the mkdir: a pre-existing user-owned libexec must not slip through just
  # because it didn't exist when we looked the first time.
  check_wake_ancestor "$WAKE_WRAPPER_DIR"
  sudo install -o root -g wheel -m 0755 "$WAKE_WRAPPER_SRC" "$WAKE_WRAPPER"

  tmp_sudoers="$(mktemp -t chimera-wake-sudoers)"
  wake_sudoers_text > "$tmp_sudoers"
  # A malformed drop-in can lock this account out of sudo ENTIRELY, so the syntax gate runs on the
  # temp file BEFORE it is ever placed in /etc/sudoers.d — and the wrapper is rolled back if it fails.
  if ! "$visudo_bin" -cf "$tmp_sudoers" >/dev/null; then
    rm -f "$tmp_sudoers"
    sudo rm -f "$WAKE_WRAPPER"
    fail "the generated sudoers drop-in failed 'visudo -c'; it was NOT installed and $WAKE_WRAPPER was removed again."
  fi
  info "Installing $WAKE_SUDOERS..."
  sudo install -o root -g wheel -m 0440 "$tmp_sudoers" "$WAKE_SUDOERS"
  rm -f "$tmp_sudoers"

  # A half-installed privileged path is worse than none: if the daemon's exact call doesn't work,
  # both files come back out.
  if ! probe_out="$(sudo -n "$WAKE_WRAPPER" probe 2>&1)"; then
    sudo rm -f "$WAKE_SUDOERS" "$WAKE_WRAPPER"
    fail "installed, but the daemon's own call 'sudo -n $WAKE_WRAPPER probe' failed: $probe_out — both files have been removed again."
  fi
  info "wake scheduling enabled ($probe_out). Verify with: pmset -g sched   (chimera's event appears as \"by 'chimera'\"), and with: chimera job_status <job>  ->  wakeScheduling.available: true"
}

disable_wake() {
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "cancel chimera-owned wake events one by one via $WAKE_WRAPPER, then remove $WAKE_WRAPPER and $WAKE_SUDOERS"
    return
  fi
  if [ ! -e "$WAKE_WRAPPER" ] && [ ! -e "$WAKE_SUDOERS" ]; then
    info "RTC wake scheduling isn't installed here (no $WAKE_WRAPPER, no $WAKE_SUDOERS) — nothing to remove."
    return
  fi

  # Best effort and never fatal. While the wrapper still exists, hand it back every event chimera
  # itself scheduled, ONE AT A TIME by exact timestamp: pmset's cancel-every-event verb would wipe
  # the operator's and macOS's own events too, so it is never used here or in the wrapper.
  # `pmset -g sched` is unprivileged (verified rc=0), and the type word in its output is not
  # guaranteed, so only the time and the owner tag are matched.
  if [ -e "$WAKE_WRAPPER" ] && command -v pmset >/dev/null 2>&1; then
    local line when epoch iso
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      when="$(printf '%s\n' "$line" | sed -n 's/.*at \([0-9][0-9]\/[0-9][0-9]\/[0-9][0-9][0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\).*/\1/p')"
      if [ -z "$when" ]; then
        warn "couldn't read the time out of a chimera wake event: $line — cancel it by hand with: pmset schedule cancel wakeorpoweron \"<the time shown above>\" chimera"
        continue
      fi
      # F01-QA-5: `when` is the local wall-clock string pmset printed back; during a fall-back DST
      # hour that string names two different instants, so this round trip can land on the wrong
      # one and hand the wrapper the wrong ISO to cancel — inherent to pmset's local-time-only
      # interface (see the matching note in chimera-wake.sh), not fixable here.
      if ! epoch="$(date -j -f "%m/%d/%Y %H:%M:%S" "$when" +%s 2>/dev/null)" \
         || ! iso="$(date -u -r "$epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" \
         || ! sudo -n "$WAKE_WRAPPER" cancel "$iso" >/dev/null 2>&1; then
        warn "couldn't cancel the chimera wake event at $when — cancel it by hand with: pmset schedule cancel wakeorpoweron \"$when\" chimera"
        continue
      fi
      info "Cancelled chimera wake event at $when."
    done <<< "$(pmset -g sched 2>/dev/null | grep "by 'chimera'" || true)"
  fi

  sudo rm -f "$WAKE_SUDOERS" "$WAKE_WRAPPER"
  info "RTC wake scheduling is off. Scheduled jobs still fire — late-and-coalesced after a sleep, reported as trigger \"sleep-wake\"."
}

# ---------------------------------------------------------------------------
# Uninstall mode
# ---------------------------------------------------------------------------

remove_service() {
  FOUND_SERVICE=0
  if [ "$OS" = "Darwin" ]; then
    if [ -e "$PLIST_PATH" ]; then
      FOUND_SERVICE=1
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "stop chimerad, unload $LAUNCHD_LABEL (launchctl bootout), and remove $PLIST_PATH"
      else
        info "Stopping and removing the launchd agent ($LAUNCHD_LABEL)..."
        launchctl bootout "gui/${UID_NUM}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
        rm -f "$PLIST_PATH"
      fi
    fi
  elif [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    if [ -e "$UNIT_PATH" ]; then
      FOUND_SERVICE=1
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "stop+disable $SYSTEMD_UNIT, remove $UNIT_PATH, and systemctl --user daemon-reload"
      else
        info "Stopping and removing the systemd user unit ($SYSTEMD_UNIT)..."
        systemctl --user disable --now "$SYSTEMD_UNIT" >/dev/null 2>&1 || true
        rm -f "$UNIT_PATH"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      fi
    fi
  fi
}

remove_bins() {
  REMOVED_ANY_BIN=0
  for name in chimerad chimera; do
    path="$PREFIX/$name"
    if [ -L "$path" ]; then
      target="$(readlink "$path")"
      case "$target" in
        "$REPO_ROOT"/*)
          REMOVED_ANY_BIN=1
          if [ "$DRY_RUN" -eq 1 ]; then
            dry "remove symlink $path -> $target"
          else
            info "Removing $path..."
            rm -f "$path"
          fi
          ;;
        *)
          warn "$path is a symlink but doesn't point into this repo ($target) — leaving it in place."
          ;;
      esac
    elif [ -e "$path" ]; then
      warn "$path exists but isn't a symlink we manage — leaving it in place."
    fi
  done
}

remove_app_bundle() {
  FOUND_APP=0
  [ "$OS" = "Darwin" ] || return 0
  for apps_dest in "${APPS_DIR_CANDIDATES[@]}"; do
    bundle="$apps_dest/${APP_NAME}.app"
    [ -d "$bundle" ] || continue
    bundle_id=""
    if command -v defaults >/dev/null 2>&1; then
      bundle_id="$(defaults read "$bundle/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
    fi
    if [ "$bundle_id" = "$APP_BUNDLE_ID" ]; then
      FOUND_APP=1
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "remove app bundle $bundle (bundle id '$bundle_id' matches ours)"
      else
        info "Removing app bundle $bundle..."
        rm -rf "$bundle"
      fi
    else
      warn "Found $bundle but its bundle id ('$bundle_id') doesn't match ours ('$APP_BUNDLE_ID') — leaving it in place."
    fi
  done
}

purge_data() {
  if [ ! -e "$CHIMERA_HOME_DIR" ]; then
    info "No data directory found at $CHIMERA_HOME_DIR; nothing to purge."
    return
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "delete $CHIMERA_HOME_DIR (state, events, projects.json, keychain refs, logs) after typed confirmation"
    return
  fi
  # Non-TTY is already rejected earlier for the whole run, but guard here too
  # since this is the one genuinely destructive, unrecoverable step.
  [ -t 0 ] || fail "--purge-data requires an interactive terminal. Refusing to proceed non-interactively."
  warn "This will permanently delete $CHIMERA_HOME_DIR — all accounts, sessions, and agent state. This cannot be undone."
  printf 'Type the path to confirm (%s): ' "$CHIMERA_HOME_DIR"
  read -r confirm
  if [ "$confirm" != "$CHIMERA_HOME_DIR" ]; then
    fail "Confirmation did not match; aborting. $CHIMERA_HOME_DIR was NOT deleted."
  fi
  info "Deleting $CHIMERA_HOME_DIR..."
  rm -rf "$CHIMERA_HOME_DIR"
}

do_uninstall() {
  info "Uninstalling Chimera..."
  if [ "$DRY_RUN" -eq 1 ]; then
    info "DRY RUN — printing the removal plan; nothing will be changed, stopped, or deleted."
  fi

  quit_app_if_running
  remove_service
  remove_bins
  remove_app_bundle
  # Reverse --enable-wake too: leaving a NOPASSWD sudoers rule behind pointing at a script this
  # uninstall just made unreachable would be the worst possible leftover.
  if [ "$DRY_RUN" -eq 1 ] || [ -e "$WAKE_WRAPPER" ] || [ -e "$WAKE_SUDOERS" ]; then
    disable_wake
  fi

  FOUND_ANYTHING=0
  [ "$APP_WAS_RUNNING" -eq 1 ] && FOUND_ANYTHING=1
  [ "$FOUND_SERVICE" -eq 1 ] && FOUND_ANYTHING=1
  [ "$REMOVED_ANY_BIN" -eq 1 ] && FOUND_ANYTHING=1
  [ "$FOUND_APP" -eq 1 ] && FOUND_ANYTHING=1
  if [ "$FOUND_ANYTHING" -eq 0 ]; then
    info "No Chimera install footprint found here — already clean."
  fi

  echo
  if [ "$PURGE_DATA" -eq 1 ]; then
    purge_data
  else
    info "Wake scheduling paths checked: $WAKE_WRAPPER, $WAKE_SUDOERS"
    info "Data left in place: $CHIMERA_HOME_DIR (accounts, sessions, agent state, logs). Pass --purge-data to also delete it."
  fi

  echo
  if [ "$DRY_RUN" -eq 1 ]; then
    info "DRY RUN complete — nothing was changed, stopped, or deleted."
  else
    info "Chimera uninstall complete."
    if [ "$PURGE_DATA" -ne 1 ]; then
      echo "Reinstalling later (./scripts/install.sh) picks up right where you left off — agent sessions in $CHIMERA_HOME_DIR resume automatically."
    fi
  fi
  exit 0
}

# Standalone commands: they short-circuit before the upgrade-detection and prereq steps below,
# because "enable wake" must never turn into "and also rebuild everything".
if [ "$ENABLE_WAKE" -eq 1 ]; then
  enable_wake
  exit 0
fi
if [ "$DISABLE_WAKE" -eq 1 ]; then
  disable_wake
  exit 0
fi

if [ "$UNINSTALL" -eq 1 ]; then
  do_uninstall
fi

# ---------------------------------------------------------------------------
# Install / upgrade mode
# ---------------------------------------------------------------------------

EXISTING_INSTALL=0
if [ -L "$PREFIX/chimerad" ] || [ -e "$PLIST_PATH" ] || [ -e "$UNIT_PATH" ]; then
  EXISTING_INSTALL=1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "DRY RUN — printing what an upgrade would do; no files will be changed, nothing will be stopped/started."
fi
if [ "$EXISTING_INSTALL" -eq 1 ]; then
  info "Existing Chimera install detected — running as an upgrade."
else
  info "No existing install detected — fresh install."
fi

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------

info "Checking prerequisites..."

if ! command -v git >/dev/null 2>&1; then
  fail "git is required but not found. Install it and re-run:
  macOS:  xcode-select --install   (or: brew install git)
  Linux:  sudo apt install git     (or your distro's package manager)"
fi

have_brew() { [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; }

if ! command -v node >/dev/null 2>&1; then
  if have_brew; then
    info "node not found; installing via Homebrew..."
    brew install node
  else
    fail "node (>= $NODE_MIN_MAJOR) is required but not found. Install it and re-run:
  macOS:  brew install node
  Linux:  install Node $NODE_MIN_MAJOR+ from your package manager or https://nodejs.org"
  fi
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
  fail "node $NODE_MAJOR found but Chimera requires >= $NODE_MIN_MAJOR. Upgrade node and re-run:
  macOS:  brew upgrade node
  Linux:  install Node $NODE_MIN_MAJOR+ from your package manager or https://nodejs.org"
fi
info "node $(node --version) OK"

source "$REPO_ROOT/scripts/install-pnpm.sh"
select_install_pnpm "$PNPM_VERSION"

# Rust/cargo is needed to build the Tauri desktop app, which is the primary
# interface. The app builds by default, so
# auto-install Rust via rustup if it's missing — mirroring the node/pnpm
# auto-install above — rather than silently skipping the app.
HAVE_CARGO=0
if command -v cargo >/dev/null 2>&1; then
  HAVE_CARGO=1
elif [ "$BUILD_APP" -eq 1 ]; then
  info "Rust/cargo not found; installing via rustup (needed for the desktop app)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
  # shellcheck disable=SC1091
  [ -f "${CARGO_HOME:-$HOME/.cargo}/env" ] && . "${CARGO_HOME:-$HOME/.cargo}/env"
  if command -v cargo >/dev/null 2>&1; then
    HAVE_CARGO=1
    info "rust $(cargo --version 2>/dev/null || echo installed) OK"
  else
    warn "rustup ran but 'cargo' isn't on PATH yet. Open a new shell (or 'source \$HOME/.cargo/env') and re-run, or build the app later: pnpm --filter @chimera/app tauri build"
  fi
fi

# ---------------------------------------------------------------------------
# 2. Update: pull latest code
# ---------------------------------------------------------------------------

GIT_OLD_REV=""
GIT_NEW_REV=""
if [ "$DO_PULL" -eq 0 ]; then
  info "Skipping git pull (--no-pull)."
elif [ ! -e "$REPO_ROOT/.git" ]; then
  # curl | bash (or an extracted tarball) has no repo checkout to pull.
  # (a linked worktree's .git is a file, not a dir, hence -e not -d.)
  info "No .git found; skipping git pull."
elif ! git -C "$REPO_ROOT" remote | grep -q .; then
  warn "No git remote configured; skipping git pull (pass --no-pull to silence this)."
elif [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  warn "Working tree has uncommitted changes; skipping git pull so they aren't clobbered. Commit or stash them and re-run, or pass --no-pull to silence this."
elif [ -z "$(git -C "$REPO_ROOT" branch --show-current)" ]; then
  warn "Detached HEAD; skipping git pull."
else
  GIT_OLD_REV="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "run: git pull --ff-only (currently at $GIT_OLD_REV)"
  else
    info "Pulling latest code (git pull --ff-only)..."
    git -C "$REPO_ROOT" pull --ff-only
    GIT_NEW_REV="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  fi
fi

# pnpm install restructures node_modules (symlinks, workspace links), and
# agent worktrees symlink into this repo's node_modules at every level (see
# CLAUDE.md) — a live pnpm install racing an active agent through that
# symlink chain is the documented corruption case here, not mere untidiness.
# A prior manual pull can also leave node_modules on the old dependency tree.
# Compare the installed lockfile too; HEAD equality alone doesn't prove that
# install will be a no-op (especially when upgrading the package manager).
LOCKFILE_CHANGED=0
if [ -n "$GIT_OLD_REV" ] && [ -n "$GIT_NEW_REV" ] && [ "$GIT_OLD_REV" != "$GIT_NEW_REV" ]; then
  if ! git -C "$REPO_ROOT" diff --quiet "$GIT_OLD_REV" "$GIT_NEW_REV" -- pnpm-lock.yaml; then
    LOCKFILE_CHANGED=1
  fi
fi
if ! cmp -s "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/node_modules/.pnpm/lock.yaml"; then
  LOCKFILE_CHANGED=1
fi

# ---------------------------------------------------------------------------
# 3. Stop what's running. The daemon's stop path is a graceful SIGTERM
#    (suspend, not kill) — still-running agents resume on restart.
#
#    Build-then-swap: when dependencies didn't change (the common case),
#    stopping is deferred until right before the app-bundle/service swap
#    below, so chimerad keeps serving through the entire multi-minute
#    typecheck + Tauri build. It's only stopped here, before the build, when
#    pnpm-lock.yaml changed and pnpm install itself needs to run against a
#    quiesced tree (see the node_modules-symlink note above).
# ---------------------------------------------------------------------------

source "$REPO_ROOT/scripts/install-launchd.sh"

stop_running_services() {
  DAEMON_WAS_RUNNING=0
  if [ "$OS" = "Darwin" ]; then
    if launchctl print "gui/${UID_NUM}/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
      DAEMON_WAS_RUNNING=1
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "run: launchctl bootout gui/${UID_NUM}/${LAUNCHD_LABEL}  (graceful SIGTERM; agent sessions resume on restart)"
      else
        info "Stopping chimerad ($LAUNCHD_LABEL)..."
        unload_install_launchd "gui/${UID_NUM}/${LAUNCHD_LABEL}"
      fi
    fi
  elif [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
      DAEMON_WAS_RUNNING=1
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "run: systemctl --user stop $SYSTEMD_UNIT  (graceful SIGTERM; agent sessions resume on restart)"
      else
        info "Stopping chimerad ($SYSTEMD_UNIT)..."
        systemctl --user stop "$SYSTEMD_UNIT" || true
      fi
    fi
  fi

  quit_app_if_running
}

DAEMON_WAS_RUNNING=0
APP_WAS_RUNNING=0
if [ "$LOCKFILE_CHANGED" -eq 1 ]; then
  info "Installed dependencies differ from this checkout — stopping before install (pnpm install must not race a live agent's node_modules symlinks)."
  stop_running_services
fi

# ---------------------------------------------------------------------------
# 4. Build
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
  dry "run: pnpm install (workspace dependencies)"
  dry "run: pnpm run typecheck"
else
  info "Installing workspace dependencies (pnpm install)..."
  # CI=true: this script has no TTY when run non-interactively (curl | bash), and pnpm
  # refuses to purge/reconcile an unexpected node_modules layout without either a TTY
  # confirmation or CI mode.
  ( cd "$REPO_ROOT" && CI=true "${PNPM_CMD[@]}" install --frozen-lockfile )

  info "Typechecking workspace packages (informational — daemon/client run via tsx at runtime, so this can't block install)..."
  ( cd "$REPO_ROOT" && "${PNPM_CMD[@]}" run typecheck ) || warn "typecheck reported issues; this does not block install (bins run via tsx, not compiled output)."
fi

APP_BUNDLE_PATH=""
if [ "$BUILD_APP" -eq 1 ]; then
  if [ "$HAVE_CARGO" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      dry "run: pnpm tauri build (packages/app)"
    else
      info "Building the Tauri desktop app — the primary interface (this can take a while)..."
      ( cd "$REPO_ROOT/packages/app" && "${PNPM_CMD[@]}" tauri build )
      if [ "$OS" = "Darwin" ]; then
        prepare_macos_app_signature \
          "$REPO_ROOT/packages/app/src-tauri/target/release/bundle/macos/${APP_NAME}.app" \
          "$REPO_ROOT/packages/app/src-tauri/entitlements.plist" "$APP_BUNDLE_ID" \
          || fail "Desktop app signature verification failed; refusing to install it."
      fi
    fi
  else
    warn "Skipping the desktop app build — Rust/cargo is unavailable (rustup auto-install did not put cargo on PATH)."
    warn "Open a new shell (or 'source \$HOME/.cargo/env') and run: pnpm --filter @chimera/app tauri build"
  fi
else
  info "Skipping the desktop app build (--no-app). Build it later with:"
  info "  pnpm --filter @chimera/app tauri build"
fi

# Preserve the installed bundle when an update would invalidate privacy grants.
if [ "$BUILD_APP" -eq 1 ] && [ "$HAVE_CARGO" -eq 1 ] && [ "$OS" = "Darwin" ] && [ "$DRY_RUN" -eq 0 ]; then
  APPS_DEST="/Applications"
  [ -w "$APPS_DEST" ] || APPS_DEST="$HOME/Applications"
  verify_macos_permission_continuity "$APPS_DEST/${APP_NAME}.app" \
    "$REPO_ROOT/packages/app/src-tauri/target/release/bundle/macos/${APP_NAME}.app" \
    || fail "Desktop update would reset macOS permissions."
fi

# Build succeeded. If the daemon was still up for it (dependencies unchanged,
# see step 3), stop it now, right before the swap below.
if [ "$LOCKFILE_CHANGED" -eq 0 ]; then
  info "Build complete — stopping chimerad now, right before installing it."
  stop_running_services
fi

# ---------------------------------------------------------------------------
# 5. Install the app bundle (macOS)
# ---------------------------------------------------------------------------

if [ "$BUILD_APP" -eq 1 ] && [ "$OS" = "Darwin" ]; then
  APP_BUNDLE_SRC="$REPO_ROOT/packages/app/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
  APPS_DEST="/Applications"
  [ -w "$APPS_DEST" ] || APPS_DEST="$HOME/Applications"
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "install the app bundle: $APP_BUNDLE_SRC -> $APPS_DEST/${APP_NAME}.app (ditto, replacing any existing bundle)"
    APP_BUNDLE_PATH="$APPS_DEST/${APP_NAME}.app"
  elif [ "$HAVE_CARGO" -eq 1 ]; then
    if [ -d "$APP_BUNDLE_SRC" ]; then
      info "Installing the desktop app to $APPS_DEST/${APP_NAME}.app..."
      mkdir -p "$APPS_DEST"
      # ditto (not cp/rsync) preserves resource forks, xattrs, and the code
      # signature — a plain byte copy of a signed .app can fail Gatekeeper.
      rm -rf "${APPS_DEST:?}/${APP_NAME}.app"
      ditto "$APP_BUNDLE_SRC" "$APPS_DEST/${APP_NAME}.app"
      codesign --verify --deep --strict "$APPS_DEST/${APP_NAME}.app" \
        || fail "Installed desktop app signature verification failed."
      APP_BUNDLE_PATH="$APPS_DEST/${APP_NAME}.app"
    else
      warn "Built app bundle not found at $APP_BUNDLE_SRC; skipping app-bundle install."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 6. Install bins on PATH
# ---------------------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
  dry "symlink chimerad/chimera into $PREFIX"
else
  info "Installing chimerad/chimera to $PREFIX..."
  mkdir -p "$PREFIX"
  chmod +x "$REPO_ROOT/packages/daemon/bin/chimerad.js" \
           "$REPO_ROOT/packages/client/bin/chimera.js"
  ln -sf "$REPO_ROOT/packages/daemon/bin/chimerad.js" "$PREFIX/chimerad"
  ln -sf "$REPO_ROOT/packages/client/bin/chimera.js" "$PREFIX/chimera"
  fi

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) warn "$PREFIX is not on your PATH. Add this to your shell rc (~/.zshrc or ~/.bashrc):
    export PATH=\"$PREFIX:\$PATH\"" ;;
esac

# ---------------------------------------------------------------------------
# 7. Auto-start service (re-installing also restarts chimerad on the new build)
# ---------------------------------------------------------------------------

NODE_BIN="$(command -v node)"
CHIMERAD_JS="$REPO_ROOT/packages/daemon/bin/chimerad.js"
# launchd starts with a deliberately narrow PATH and therefore cannot see CLIs installed under
# nvm/asdf/mise. Pin the same executable visible during install; an explicit override still wins.
CODEX_CLI_PATH="${CHIMERA_CODEX_CLI_PATH:-$(command -v codex 2>/dev/null || true)}"
if [ -n "$CODEX_CLI_PATH" ] && [ ! -x "$CODEX_CLI_PATH" ]; then
  warn "Configured Codex CLI is unavailable: $CODEX_CLI_PATH; rediscovering from PATH."
  CODEX_CLI_PATH="$(command -v codex 2>/dev/null || true)"
fi
SERVICE_INSTALLED=0

if [ "$SKIP_SERVICE" -eq 1 ]; then
  info "Skipping auto-start service install (--no-service)."
elif [ "$OS" = "Darwin" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "install/refresh launchd agent at $PLIST_PATH and (re)start chimerad ($LAUNCHD_LABEL)"
  else
    info "Installing launchd user agent ($LAUNCHD_LABEL)..."
    LOG_DIR="${CHIMERA_HOME:-$HOME/.chimera}"
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CHIMERAD_JS}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/daemon.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
$( [ -n "${CHIMERA_HOME:-}" ] && printf '    <key>CHIMERA_HOME</key><string>%s</string>\n' "${CHIMERA_HOME}" )
$( [ -n "$CODEX_CLI_PATH" ] && printf '    <key>CHIMERA_CODEX_CLI_PATH</key><string>%s</string>\n' "$CODEX_CLI_PATH" )
  </dict>
</dict>
</plist>
PLIST
    unload_install_launchd "gui/${UID_NUM}/${LAUNCHD_LABEL}"
    bootstrap_install_launchd "gui/${UID_NUM}" "$LAUNCHD_LABEL" "$PLIST_PATH"
    SERVICE_INSTALLED=1
    info "launchd agent installed at $PLIST_PATH (starts chimerad on login, restarts on crash)."
  fi
elif [ "$OS" = "Linux" ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping auto-start service install (Linux best-effort). You can start chimerad manually with: chimera start"
  elif [ "$DRY_RUN" -eq 1 ]; then
    dry "install/refresh systemd user unit at $UNIT_PATH and (re)start chimerad ($SYSTEMD_UNIT)"
  else
    info "Installing systemd user unit ($SYSTEMD_UNIT) [best-effort]..."
    LOG_DIR="${CHIMERA_HOME:-$HOME/.chimera}"
    mkdir -p "$UNIT_DIR" "$LOG_DIR"
    cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=Chimera daemon

[Service]
ExecStart=${NODE_BIN} ${CHIMERAD_JS}
Restart=on-failure
Environment=HOME=${HOME}
$( [ -n "${CHIMERA_HOME:-}" ] && printf 'Environment=CHIMERA_HOME=%s\n' "${CHIMERA_HOME}" )
$( [ -n "$CODEX_CLI_PATH" ] && printf 'Environment=CHIMERA_CODEX_CLI_PATH=%s\n' "$CODEX_CLI_PATH" )
StandardOutput=append:${LOG_DIR}/daemon.log
StandardError=append:${LOG_DIR}/daemon.log

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now "$SYSTEMD_UNIT"
    SERVICE_INSTALLED=1
    info "systemd user unit installed at $UNIT_PATH."
    warn "For chimerad to auto-start on boot without an active login session, also run: loginctl enable-linger \$USER"
  fi
else
  warn "Unrecognized OS '$OS'; skipping auto-start service install. You can start chimerad manually with: chimera start"
fi

# ---------------------------------------------------------------------------
# 8. Restart whatever was running before the upgrade
# ---------------------------------------------------------------------------

# --no-service means step 7 never re-bootstrapped the service (which is what
# normally brings chimerad back) — if it was running before, bring it back
# manually so an upgrade never leaves a previously-running daemon down.
if [ "$SKIP_SERVICE" -eq 1 ] && [ "$DAEMON_WAS_RUNNING" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "restart chimerad manually (chimera start) — --no-service skips the managed service but it was running before the upgrade"
  else
    info "Restarting chimerad (was running before the upgrade; --no-service skips the managed service)..."
    node "$REPO_ROOT/packages/client/bin/chimera.js" start >/dev/null 2>&1 || warn "failed to restart chimerad automatically; run: chimera start"
  fi
fi

if [ "$APP_WAS_RUNNING" -eq 1 ] && [ "$OS" = "Darwin" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "relaunch the $APP_NAME desktop app (open -a $APP_NAME) — it was running before the upgrade"
  else
    info "Relaunching the $APP_NAME desktop app..."
    open -a "$APP_NAME" 2>/dev/null || warn "failed to relaunch the app automatically; open it manually."
  fi
fi

# ---------------------------------------------------------------------------
# 9. Summary
# ---------------------------------------------------------------------------

echo
if [ "$DRY_RUN" -eq 1 ]; then
  info "DRY RUN complete — nothing was changed, stopped, or started."
else
  info "Chimera install complete."
fi
if [ -n "$GIT_OLD_REV" ] && [ -n "$GIT_NEW_REV" ] && [ "$GIT_OLD_REV" != "$GIT_NEW_REV" ]; then
  echo "  updated:   $GIT_OLD_REV -> $GIT_NEW_REV"
fi
echo "  bins:      $PREFIX/{chimerad,chimera}"
if [ -n "$APP_BUNDLE_PATH" ]; then
  echo "  app:       $APP_BUNDLE_PATH"
fi
if [ "$SERVICE_INSTALLED" -eq 1 ]; then
  echo "  service:   installed and starting"
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "  service:   (dry run — not touched)"
else
  echo "  service:   not installed (start chimerad manually with: chimera start)"
fi
echo
echo "Next steps:"
echo "  1. Make sure $PREFIX is on your PATH (open a new shell if you just installed pnpm/node)."
echo "  2. Run:  chimera status     # starts chimerad if needed and prints health"
echo "  3. Launch the desktop app (the primary interface, built by default)."
echo "  4. First run has zero accounts configured — the onboarding screen walks you through provider setup."
echo
echo "Re-run this script any time to upgrade in place (git pull + rebuild + restart)."
echo "See INSTALL.md for details, updating, and uninstalling."
