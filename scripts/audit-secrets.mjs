// High-confidence, value-free pre-push scan. This complements (not replaces)
// provider-side secret scanning and a history audit before public release.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{32}/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{48,}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["google-oauth-client-secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
];
const findings = [];
for (const file of new Set(files)) {
  const path = resolve(root, file);
  let content;
  try {
    if (!statSync(path).isFile() || statSync(path).size > 8 * 1024 * 1024) continue;
    content = readFileSync(path, "utf8");
  } catch { continue; } // deleted paths in the index
  if (content.includes("\0")) continue;
  for (const [kind, pattern] of patterns) {
    const match = pattern.exec(content);
    if (match) findings.push({ file, kind, line: content.slice(0, match.index).split("\n").length });
  }
}
console.log(JSON.stringify({ scope: "tracked and unignored working files", findings }, null, 2));
process.exitCode = findings.length ? 1 : 0;
