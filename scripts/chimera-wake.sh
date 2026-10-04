#!/bin/sh
# chimera-wake 1 — the ONLY privileged surface chimera has.
#
# Installed by `scripts/install.sh --enable-wake` as /usr/local/libexec/chimera-wake (root:wheel
# 0755) and granted NOPASSWD in /etc/sudoers.d/chimera-wake. chimerad invokes it as:
#   sudo -n /usr/local/libexec/chimera-wake <verb> [<YYYY-MM-DDThh:mm:ssZ>]
# This file is the checked-in single source of truth: --enable-wake prints it and installs it
# verbatim, so what the operator reads is exactly what runs as root.
#
# WHY A WRAPPER AND NOT `NOPASSWD: /usr/bin/pmset`: pmset's own flags can reconfigure ALL power
# management for every power source, and its cancel-every-scheduled-event verb wipes the
# operator's own and the system's events alike. This script's total reachable authority is
# "schedule or cancel one wakeorpoweron event owned by the tag `chimera`" — the owner tag is a
# literal below and is never an argument.
set -eu
IFS='	
'
PATH=/usr/bin:/bin:/usr/sbin:/sbin   # never inherit a PATH: this runs as root
export PATH
umask 022
VERSION=1
OWNER=chimera                        # literal, never from argv
MAX_HORIZON_SECONDS=31536000         # 365 days

# TEST-ONLY seam: packages/core/test/wake-wrapper.test.ts drives this exact file with a stub
# `pmset` first on PATH. Honoured ONLY for an unprivileged invocation, so the installed root-run
# copy can never have its PATH chosen by its caller — not even if some sudoers policy disabled
# env_reset. Unprivileged, this script has no authority to lend, so the seam gives away nothing.
if [ -n "${CHIMERA_WAKE_TEST_PATH:-}" ] && [ "$(id -u)" -ne 0 ]; then
  PATH="$CHIMERA_WAKE_TEST_PATH:$PATH"
fi

usage() { echo "usage: chimera-wake probe | schedule <YYYY-MM-DDThh:mm:ssZ> | cancel <YYYY-MM-DDThh:mm:ssZ>" >&2; exit 2; }

[ "$#" -ge 1 ] || usage
verb=$1

if [ "$verb" = "probe" ]; then
  [ "$#" -eq 1 ] || usage
  echo "chimera-wake $VERSION"
  exit 0
fi

case "$verb" in schedule|cancel) ;; *) usage ;; esac
[ "$#" -eq 2 ] || usage
iso=$2

# Whitelist, not a blacklist: anything that is not exactly a second-resolution UTC ISO-8601
# timestamp is rejected before `date` or `pmset` ever see it, so there is no metacharacter,
# no flag and no second argument that can reach either.
case "$iso" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
  *) echo "chimera-wake: not a YYYY-MM-DDThh:mm:ssZ UTC timestamp: $iso" >&2; exit 2 ;;
esac

epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s 2>/dev/null) || {
  echo "chimera-wake: unparseable timestamp: $iso" >&2; exit 2; }
now=$(date +%s)
[ "$epoch" -gt "$now" ] || { echo "chimera-wake: $iso is in the past" >&2; exit 2; }
[ "$((epoch - now))" -lt "$MAX_HORIZON_SECONDS" ] || {
  echo "chimera-wake: $iso is more than 365 days out" >&2; exit 2; }

# pmset(1) takes LOCAL "MM/dd/yy HH:mm:ss", quoted. (Verified 2026-09-02: the epoch round trip
# above converts 2026-09-03T03:00:00Z to 09/03/26 06:00:00 in a UTC+3 zone.)
#
# F01-QA-5: during a fall-back DST hour the same local wall-clock string names two different UTC
# instants (01:30 occurs twice). A job scheduled inside that hour can wake up to an hour off, and
# a cancel that matches by this exact string (see install.sh's --disable-wake path) can hit the
# wrong occurrence. pmset(1) only accepts local wall clock — there is no UTC or offset form to ask
# for instead — so this is inherent to the interface, not something this script can fix.
local_ts=$(date -r "$epoch" +"%m/%d/%y %H:%M:%S")

if [ "$verb" = "schedule" ]; then
  pmset schedule wakeorpoweron "$local_ts" "$OWNER"
else
  pmset schedule cancel wakeorpoweron "$local_ts" "$OWNER"
fi
echo "$local_ts"
