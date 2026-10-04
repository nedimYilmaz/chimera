// Read-only, streaming SHA-256 manifest. Supply exact artifacts, not a directory
// (so stale builds and credentials cannot accidentally enter a release manifest).
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const artifacts = process.argv.slice(2);
if (!artifacts.length) throw new Error("Pass one or more exact release artifact paths");
const names = new Set();
const lines = [];
for (const artifact of artifacts) {
  const name = basename(artifact);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || names.has(name)) throw new Error("Unsafe or duplicate release artifact name");
  if (!(await lstat(artifact)).isFile()) throw new Error("Artifacts must be regular files, not directories or symlinks");
  names.add(name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  lines.push(`${hash.digest("hex")}  ${name}`);
}
console.log(lines.join("\n"));
