/**
 * Is there a newer stable Laya than the one pinned in scripts/integration-pins.mjs that nobody has
 * picked up yet? The daily `laya-release-integration` command trigger runs this and dispatches the
 * upgrade only when stdout carries a line.
 *
 *   node --import tsx scripts/check-laya-release.ts [--pypi-json file] [--pending 0.3.28,...]
 *                                                  [--state file [--record]] [--home dir]
 *
 * stdout: `LAYA_RELEASE <version>` when an upgrade should be dispatched, otherwise nothing.
 * stderr: why (always), plus the next steps when dispatching.
 * exit:   0 = checked (with or without a candidate); 2 = could not check (network / bad JSON) --
 *         stdout stays empty in that case so a flaky network never dispatches or double-dispatches.
 *
 * Dedup inputs: the pin, the runtimes already provisioned under <home>/integrations/laya-* (a
 * directory counts only once its ready.json exists), and versions already dispatched (--pending
 * and/or the `dispatched` list of the --state file). --record appends the emitted version to that
 * state file so tomorrow's run stays silent until the task lands and the pin moves.
 *
 * Nothing is installed, downloaded beyond the PyPI index, or written unless --record is given.
 */
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chimeraHome } from "../packages/core/src/paths.js";
import { decideLayaRelease, latestStable, layaVersionFromDir, parseStableVersion } from "../packages/core/src/laya-release.js";
import { LAYA } from "./integration-pins.mjs";

const { values } = parseArgs({ options: {
  "pypi-json": { type: "string" }, pending: { type: "string" }, state: { type: "string" },
  record: { type: "boolean" }, home: { type: "string" },
} });
const fail = (message: string): never => { console.error(`laya-release: ${message}`); process.exit(2); };

if (values.record && !values.state) fail("--record needs --state <file> to know where to remember the dispatched version");

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { return fail(`cannot read ${file}: ${(error as Error).message}`); }
}

async function pypiIndex(): Promise<unknown> {
  if (values["pypi-json"]) return readJson(values["pypi-json"]);
  try {
    const res = await fetch("https://pypi.org/pypi/laya/json", { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (!res.ok) return fail(`PyPI answered HTTP ${res.status}`);
    return await res.json();
  } catch (error) { return fail(`PyPI request failed: ${(error as Error).message}`); }
}

async function installedVersions(home: string): Promise<string[]> {
  const root = join(home, "integrations");
  const names = await readdir(root).catch(() => [] as string[]);
  return names.flatMap(name => {
    const version = layaVersionFromDir(name);
    return version && existsSync(join(root, name, "ready.json")) ? [version] : [];
  });
}

async function dispatchedVersions(): Promise<string[]> {
  const fromFlag = (values.pending ?? "").split(",").map(s => s.trim()).filter(Boolean);
  let fromState: string[] = [];
  if (values.state && existsSync(values.state)) {
    const state = await readJson(values.state);
    const list = (state as { dispatched?: unknown } | null)?.dispatched;
    fromState = Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
  }
  const all = [...fromFlag, ...fromState];
  const bad = all.filter(v => !parseStableVersion(v));
  if (bad.length) console.error(`laya-release: ignoring non-stable pending entries: ${bad.join(", ")}`);
  return all.filter(v => parseStableVersion(v));
}

const home = values.home ?? chimeraHome();
const index = await pypiIndex();
const latest = latestStable(index);
const installed = await installedVersions(home);
const pending = await dispatchedVersions();
const decision = decideLayaRelease({ latest: latest?.version ?? null, pinned: LAYA.version, installed, pending });

console.error(`laya-release: pinned ${LAYA.version}; PyPI latest stable ${latest?.version ?? "none"}; installed [${installed.join(", ")}]; pending [${pending.join(", ")}]`);
console.error(`laya-release: ${decision.action} -- ${decision.reason}`);
if (decision.action === "none") process.exit(0);

console.error([
  `laya-release: candidate wheel ${latest?.wheel ? `${latest.wheel.file} sha256 ${latest.wheel.sha256}` : "NOT FOUND (no pure-python wheel; do not pin)"}`,
  "laya-release: the PyPI version is NOT the model checkpoint. Re-verify laya.revisions.PINNED_REVISIONS and the Hub revision/digest",
  `laya-release: against LAYA.checkpoint (${LAYA.checkpoint.revision.slice(0, 12)}...) before changing it; then follow "Upgrading or rolling back Laya" in docs/computer-use.md.`,
].join("\n"));
console.log(`LAYA_RELEASE ${decision.version}`);

if (values.record && values.state) {
  const prior = existsSync(values.state) ? ((await readJson(values.state)) as { dispatched?: string[] } | null) : null;
  const dispatched = [...new Set([...(prior?.dispatched ?? []), decision.version])];
  await mkdir(dirname(values.state), { recursive: true });
  // Rename into place so a crash cannot leave a truncated file that the next run would reject.
  const tmp = `${values.state}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ dispatched }, null, 2)}\n`);
  await rename(tmp, values.state);
}
