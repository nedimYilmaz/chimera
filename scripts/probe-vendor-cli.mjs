// RELEASE-T1 spike probe (kept for re-verification, not run automatically by build-bins.sh
// or CI): exercises ONLY the claude-agent-sdk's child-CLI path resolution — query() reaches
// spawn() before any network/auth round-trip, so the failure mode tells you whether the
// vendored native CLI was found, independent of whether the turn itself would succeed.
//
// Usage (see docs/RELEASE-BUNDLING.md for the full compiled-binary story):
//   cd packages/core && bun build ../../scripts/probe-vendor-cli.mjs --compile --outfile /tmp/probe
//   /tmp/probe                       # default SDK resolution (fails once truly standalone)
//   /tmp/probe /path/to/vendor/claude  # explicit override (the CHIMERA_CLAUDE_CLI_PATH mitigation)
import { query } from "@anthropic-ai/claude-agent-sdk";

const cliPath = process.argv[2];
const options = { maxTurns: 1, ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}) };

try {
  const stream = query({ prompt: "hi", options });
  for await (const _msg of stream) {
    console.log("PROBE_RESULT: got a message from the child CLI — resolution + spawn succeeded");
    process.exit(0);
  }
  console.log("PROBE_RESULT: stream ended with no messages");
} catch (err) {
  console.log(`PROBE_ERROR: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
}
