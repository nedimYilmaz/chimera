#!/usr/bin/env node
// P0-2 MODEL-ATTR backfill (one-off): relabels usage ledger rows whose model was stamped
// with the literal "default" (engine.ts's old `spec.model ?? "default"` bug, fixed in this
// same slice — see core/engine.ts's resolveContext).
//
// Evidence (chimera/tokenopt memory 952ea243, verified 2026-07-24): of the default-model
// rows, every agent EXCEPT f436e21d-6ab9-4230-9535-7effd0792562 has a recoverable session
// transcript whose every one of 4,362 unique non-synthetic API message ids used
// claude-opus-4-8 — proof, not a guess. f436e21d's session is unavailable (no surviving
// session id), so it is relabeled to the honest "unknown" rather than assumed.
//
// SAFETY: usage.jsonl is the LIVE daemon's append-only ledger — it can grow between this
// script's read and write. We snapshot the file, transform only the lines that existed at
// snapshot time, then re-check for any lines appended since and preserve them verbatim
// (never touched, never lost), before an atomic rename over the original.
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const UNVERIFIABLE_AGENT_ID = "f436e21d-6ab9-4230-9535-7effd0792562";
const PROVEN_MODEL = "claude-opus-4-8";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const homeArgIdx = args.indexOf("--home");
const home = homeArgIdx >= 0 ? args[homeArgIdx + 1] : (process.env.CHIMERA_HOME || join(homedir(), ".chimera"));
const usageDir = join(home, "usage");

if (!existsSync(usageDir)) {
  console.error(`no usage dir at ${usageDir}`);
  process.exit(1);
}

const SEALED_FILE_RE = /^usage\.\d{4}-\d{2}\.jsonl$/;
const files = readdirSync(usageDir).filter((n) => n === "usage.jsonl" || SEALED_FILE_RE.test(n));

let totalRelabeledProven = 0;
let totalRelabeledUnknown = 0;

for (const name of files) {
  const path = join(usageDir, name);
  const isActive = name === "usage.jsonl";

  const before = readFileSync(path, "utf8");
  const beforeLines = before.split("\n");
  const snapshotLineCount = beforeLines.length;

  let relabeledProven = 0;
  let relabeledUnknown = 0;
  const outLines = beforeLines.map((line) => {
    if (!line) return line;
    let row;
    try { row = JSON.parse(line); } catch { return line; }   // torn line — leave untouched, same tolerance as UsageLedger's reader
    if (row.model !== "default") return line;
    if (row.agent === UNVERIFIABLE_AGENT_ID) {
      row.model = "unknown";
      relabeledUnknown++;
    } else {
      row.model = PROVEN_MODEL;
      relabeledProven++;
    }
    return JSON.stringify(row);
  });

  if (isActive) {
    // Re-check for daemon appends that landed since the snapshot; preserve them verbatim.
    const after = readFileSync(path, "utf8");
    const afterLines = after.split("\n");
    if (afterLines.length > snapshotLineCount) {
      const appended = afterLines.slice(snapshotLineCount);
      console.log(`  ${name}: ${appended.length} line(s) appended by the live daemon since snapshot — preserved verbatim`);
      outLines.splice(snapshotLineCount, outLines.length - snapshotLineCount, ...appended);
    }
  }

  totalRelabeledProven += relabeledProven;
  totalRelabeledUnknown += relabeledUnknown;
  console.log(`${name}: ${relabeledProven} row(s) -> "${PROVEN_MODEL}", ${relabeledUnknown} row(s) -> "unknown"`);

  if (!dryRun && (relabeledProven > 0 || relabeledUnknown > 0)) {
    const tmpPath = `${path}.backfill-tmp`;
    writeFileSync(tmpPath, outLines.join("\n"));
    renameSync(tmpPath, path);   // atomic on the same filesystem
  }
}

console.log(`\nTOTAL: ${totalRelabeledProven} -> "${PROVEN_MODEL}", ${totalRelabeledUnknown} -> "unknown"${dryRun ? " (dry run, nothing written)" : ""}`);
