#!/usr/bin/env bash
# Public bootstrap. The npm package and matching signed GitHub release must be published first.
set -euo pipefail
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node.js 24+ (including npm), then run this command again.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("Node.js 24+ is required"); process.exit(1); }'
version="${CHIMERA_VERSION:-latest}"
exec npm exec --yes --registry=https://registry.npmjs.org --package="@nedimyilmaz/chimera@${version}" -- chimera install "$@"
