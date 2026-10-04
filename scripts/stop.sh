#!/usr/bin/env bash
# Stop Chimera's managed daemon and desktop app without uninstalling anything.
# This is intentionally narrower than scripts/install.sh --uninstall: it leaves
# bins, service definitions, app bundles, and CHIMERA_HOME data in place.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHD_LABEL="${CHIMERA_LAUNCHD_LABEL:-com.chimera.chimerad}"
SYSTEMD_UNIT="${CHIMERA_SYSTEMD_UNIT:-chimerad.service}"
CHIMERA_HOME_DIR="${CHIMERA_HOME:-$HOME/.chimera}"
APP_NAME="${CHIMERA_APP_NAME:-chimera}"
DRY_RUN="${CHIMERA_STOP_DRY_RUN:-${CHIMERA_INSTALL_DRY_RUN:-0}}"
STOP_DAEMON=1
STOP_APP=1
FORCE=0

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1" >&2; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }
dry()  { printf '\033[1;36m[dry-run]\033[0m would %s\n' "$1"; }

usage() {
  cat <<USAGE
usage: scripts/stop.sh [--daemon-only] [--app-only] [--force] [--dry-run]

Stops Chimera without uninstalling:
  - daemon: launchd/systemd service if installed, otherwise the CHIMERA_HOME pid
    file or CLI fallback
  - app:    the desktop app process ("$APP_NAME")

Options:
  --daemon-only  stop only chimerad
  --app-only     stop only the desktop app
  --force        after graceful stop times out, send SIGKILL to leftover pids
  --dry-run      print what would be stopped without changing anything

Environment:
  CHIMERA_HOME                 default: $HOME/.chimera
  CHIMERA_LAUNCHD_LABEL        default: com.chimera.chimerad
  CHIMERA_SYSTEMD_UNIT         default: chimerad.service
  CHIMERA_APP_NAME             default: chimera
  CHIMERA_STOP_DRY_RUN=1       same as --dry-run
USAGE
}

mode_seen=""
for arg in "$@"; do
  case "$arg" in
    --daemon-only)
      [ "$mode_seen" = "app" ] && fail "--daemon-only cannot be combined with --app-only"
      mode_seen="daemon"
      STOP_APP=0
      ;;
    --app-only)
      [ "$mode_seen" = "daemon" ] && fail "--app-only cannot be combined with --daemon-only"
      mode_seen="app"
      STOP_DAEMON=0
      ;;
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $arg" ;;
  esac
done

OS="$(uname -s)"
UID_NUM="$(id -u)"
PLIST_PATH="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
UNIT_PATH="$HOME/.config/systemd/user/$SYSTEMD_UNIT"
DAEMON_TOUCHED=0
APP_TOUCHED=0

pid_alive() {
  kill -0 "$1" >/dev/null 2>&1
}

wait_for_pid_exit() {
  pid="$1"
  label="$2"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pid_alive "$pid" || return 0
    sleep 1
  done

  if ! pid_alive "$pid"; then
    return 0
  fi

  if [ "$FORCE" -eq 1 ]; then
    warn "$label still running after graceful stop; force-stopping pid $pid."
    if [ "$DRY_RUN" -eq 1 ]; then
      dry "send SIGKILL to $label pid $pid"
    else
      kill -KILL "$pid" 2>/dev/null || true
    fi
  else
    warn "$label still appears to be running after 10s; re-run with --force if you need a hard stop."
  fi
}

stop_pid_file_daemon() {
  pid_file="$CHIMERA_HOME_DIR/daemon.pid"
  [ -f "$pid_file" ] || return 1

  read -r pid < "$pid_file" || return 1
  case "$pid" in
    ''|*[!0-9]*) warn "Ignoring invalid daemon pid file: $pid_file"; return 1 ;;
  esac

  if ! pid_alive "$pid"; then
    warn "Daemon pid file exists but pid $pid is not running: $pid_file"
    return 1
  fi

  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *chimerad*|*packages/daemon/bin/chimerad.js*) ;;
    *)
      warn "Refusing to signal pid $pid from $pid_file because it does not look like chimerad: $command_line"
      return 1
      ;;
  esac

  DAEMON_TOUCHED=1
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "send SIGTERM to chimerad pid $pid from $pid_file"
  else
    info "Stopping chimerad pid $pid..."
    kill -TERM "$pid" 2>/dev/null || true
    wait_for_pid_exit "$pid" "chimerad"
  fi
  return 0
}

stop_cli_daemon() {
  [ -x "$REPO_ROOT/packages/client/bin/chimera.js" ] || return 1
  command -v node >/dev/null 2>&1 || return 1

  DAEMON_TOUCHED=1
  if [ "$DRY_RUN" -eq 1 ]; then
    dry "run: node $REPO_ROOT/packages/client/bin/chimera.js stop"
  else
    info "Stopping chimerad via the Chimera CLI fallback..."
    node "$REPO_ROOT/packages/client/bin/chimera.js" stop >/dev/null 2>&1 || true
  fi
  return 0
}

stop_daemon() {
  if [ "$OS" = "Darwin" ]; then
    target="gui/${UID_NUM}/${LAUNCHD_LABEL}"
    if launchctl print "$target" >/dev/null 2>&1; then
      DAEMON_TOUCHED=1
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "run: launchctl bootout $target"
      else
        info "Stopping chimerad via launchd ($LAUNCHD_LABEL)..."
        launchctl bootout "$target" >/dev/null 2>&1 || true
      fi
      return 0
    fi
    [ -e "$PLIST_PATH" ] && info "launchd agent is installed but not loaded: $PLIST_PATH"
  elif [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
      DAEMON_TOUCHED=1
      if [ "$DRY_RUN" -eq 1 ]; then
        dry "run: systemctl --user stop $SYSTEMD_UNIT"
      else
        info "Stopping chimerad via systemd user unit ($SYSTEMD_UNIT)..."
        systemctl --user stop "$SYSTEMD_UNIT" || true
      fi
      return 0
    fi
    [ -e "$UNIT_PATH" ] && info "systemd user unit is installed but not active: $UNIT_PATH"
  fi

  stop_pid_file_daemon && return 0
  if { [ "$OS" = "Darwin" ] && [ -e "$PLIST_PATH" ]; } || { [ "$OS" = "Linux" ] && [ -e "$UNIT_PATH" ]; }; then
    return 0
  fi
  stop_cli_daemon && return 0
  return 0
}

stop_app() {
  if ! command -v pgrep >/dev/null 2>&1; then
    warn "pgrep not found; cannot detect the $APP_NAME desktop app."
    return 0
  fi

  if ! pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    return 0
  fi

  APP_TOUCHED=1
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$OS" = "Darwin" ]; then
      dry "quit the $APP_NAME desktop app gracefully (osascript quit; pkill fallback after 10s)"
    else
      dry "send SIGTERM to $APP_NAME desktop app processes"
    fi
    return 0
  fi

  if [ "$OS" = "Darwin" ]; then
    info "Quitting the $APP_NAME desktop app..."
    osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -x "$APP_NAME" >/dev/null 2>&1 || return 0
      sleep 1
    done
    warn "$APP_NAME app still running after graceful quit; sending SIGTERM."
    pkill -TERM -x "$APP_NAME" 2>/dev/null || true
  else
    info "Stopping the $APP_NAME desktop app..."
    pkill -TERM -x "$APP_NAME" 2>/dev/null || true
  fi

  sleep 1
  if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
    if [ "$FORCE" -eq 1 ]; then
      warn "$APP_NAME app still running; force-stopping."
      pkill -KILL -x "$APP_NAME" 2>/dev/null || true
    else
      warn "$APP_NAME app still appears to be running; re-run with --force if you need a hard stop."
    fi
  fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  info "DRY RUN - printing what would be stopped; nothing will be changed."
fi

[ "$STOP_DAEMON" -eq 1 ] && stop_daemon
[ "$STOP_APP" -eq 1 ] && stop_app

if [ "$DAEMON_TOUCHED" -eq 0 ] && [ "$APP_TOUCHED" -eq 0 ]; then
  info "No running Chimera daemon or desktop app found."
elif [ "$DRY_RUN" -eq 1 ]; then
  info "DRY RUN complete - nothing was stopped."
else
  info "Chimera stop complete."
fi
