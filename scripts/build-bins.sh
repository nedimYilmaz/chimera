#!/usr/bin/env bash
# RELEASE-T1/T2: compiles the three Chimera bins (chimerad, chimera, chimera-mcp)
# into self-contained native binaries via `bun build --compile`. No tsx/pnpm/node/source is
# required on the target -- see docs/RELEASE-BUNDLING.md for the risk-gate findings (in
# particular: the claude/codex SDKs' vendored native CLIs are NOT embedded by this build and
# must ship alongside the binary; CHIMERA_CLAUDE_CLI_PATH / CHIMERA_CODEX_CLI_PATH point the
# daemon at them).
#
# Compilation goes through scripts/compile-bin.mjs (the `bun` JS API) rather than the `bun
# build` CLI directly.
#
# Usage: scripts/build-bins.sh [bun-target] [--tar]
#   bun-target  bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64 | bun-linux-arm64 |
#               bun-windows-x64 ... defaults to the host platform. Cross-compiling still needs
#               a matching bun release per target, fetched automatically on first use.
#   --tar       also package the three binaries into a tarball (see package_tar below). Version
#               stamping in the tarball name is a placeholder ("dev") -- RELEASE-T3 (CI) owns
#               the real version string.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build the Chimera bins (https://bun.sh)" >&2
  exit 1
fi

TARGET=""
DO_TAR=""
for arg in "$@"; do
  case "$arg" in
    --tar) DO_TAR=1 ;;
    *) TARGET="$arg" ;;
  esac
done

OUT_DIR="dist"
mkdir -p "$OUT_DIR"

SUFFIX=""
[ -n "$TARGET" ] && SUFFIX="-${TARGET#bun-}"
EXT=""
case "$TARGET" in bun-windows-*) EXT=".exe" ;; esac
if [ -z "$TARGET" ]; then
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;; esac
fi

build_one() {
  local name="$1" entry="$2"
  local out="$OUT_DIR/${name}${SUFFIX}${EXT}"
  echo "building $name${TARGET:+ for $TARGET} -> $out"
  bun scripts/compile-bin.mjs "$entry" "$out" "$TARGET"
}

build_one chimerad     packages/daemon/bin/chimerad.js
build_one chimera      packages/client/bin/chimera.js
build_one chimera-mcp  packages/mcp/bin/chimera-mcp.js

echo "built: $OUT_DIR/chimerad${SUFFIX}${EXT} $OUT_DIR/chimera${SUFFIX}${EXT} $OUT_DIR/chimera-mcp${SUFFIX}${EXT}"

if [ -n "$DO_TAR" ]; then
  # naming per the release-architect plan: chimera-cli-<version>-<os>-<arch>.tar.gz. Version
  # stamping is RELEASE-T3's job (CI) -- "dev" here is just so this helper is runnable standalone.
  os_arch="${TARGET#bun-}"
  [ -z "$os_arch" ] && os_arch="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
  TAR_PATH="$OUT_DIR/chimera-cli-dev-${os_arch}.tar.gz"
  tar -czf "$TAR_PATH" -C "$OUT_DIR" \
    "chimerad${SUFFIX}${EXT}" "chimera${SUFFIX}${EXT}" "chimera-mcp${SUFFIX}${EXT}"
  echo "packaged: $TAR_PATH"
fi
