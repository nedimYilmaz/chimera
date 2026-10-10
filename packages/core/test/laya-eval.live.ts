/**
 * Opt-in live evaluation: Laya <old> vs <new> on the SAME checkpoint, through the Chimera route
 * (mcp_store_tools / mcp_store_call -> in-memory MCP server -> `python -m laya.mcp.server`).
 *
 *   node --import tsx scripts/eval-laya.ts [--versions 0.3.22,0.3.27] [--trials 3] [--floor 0.9]
 *        [--python <base python>] [--out results.json] [--report report.md] [--cache dir]
 *        [--pypi-json <reviewed candidate fixture>]
 *
 * What is held fixed, and how that is proven rather than assumed:
 *   - checkpoint: the Hub snapshot at LAYA.checkpoint.revision must already be in the local cache and
 *     its model.safetensors must hash to LAYA.checkpoint.files; nothing is downloaded (HF_HUB_OFFLINE=1,
 *     only the English checkpoint is selectable). Each server also re-checks the digest itself via
 *     LAYA_SHA256_DIGESTS, and a wrong digest must be REFUSED (negative control).
 *   - package: every version -- old and new alike -- is an unzipped, sha256-verified wheel put in front
 *     of one shared base interpreter via PYTHONPATH, so torch/transformers/mcp are identical and only
 *     the `laya` package differs. The base venv is never modified. A subprocess and the server's own
 *     laya_status both report which laya was imported; the harness aborts if it is not the requested one.
 *   - input: the 38 synthetic cases in laya-eval.cases.ts, text only. No desktop, browser or account
 *     is touched, and the Turkish cases run on the English checkpoint (out of domain; the multilingual
 *     checkpoint is deliberately not fetched).
 *
 * Latency: "cold" is the first laya_predict after the server process started (the model loads lazily
 * because LAYA_PRELOAD=0, and the digest is verified then). It is process-cold, not disk-cold -- the OS
 * page cache is warm after the first trial. Trials alternate which version goes first.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, homedir, platform, release, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "../../protocol/src/mcp-server-factory.js";
import { McpStoreRegistry, McpStoreConnectionManager } from "../src/mcpstore.js";
import { InMemoryKeychain } from "../src/keychain.js";
import { layaEntry } from "../src/computer-use.js";
import { chimeraHome } from "../src/paths.js";
import { buildLayaChoiceRequest, layaServerGatesBatch, parseLayaBatch, parseLayaDecision, type LayaDecision } from "../src/laya-decision.js";
import { latestStable, type LayaWheel } from "../src/laya-release.js";
import { LAYA_EVAL_CASES, validateLayaEvalCases } from "./laya-eval.cases.js";
import { breakdown, diffRuns, gateRecord, summarize, summarizeLatency, sweepFloors, wilson, type LayaEvalRecord, type Slice } from "./laya-eval.score.js";
import { LAYA } from "../../../scripts/integration-pins.mjs";

const exec = promisify(execFile);
const EXPECTED_TOOLS = ["laya_decide", "laya_predict", "laya_predict_batch", "laya_preset", "laya_route", "laya_route_batch", "laya_shortlist", "laya_status"];
const MAX_WHEEL_BYTES = 8 * 1024 * 1024;

const { values } = parseArgs({ options: {
  versions: { type: "string", default: "0.3.22,0.3.27" }, trials: { type: "string", default: "3" }, floor: { type: "string", default: "0.9" },
  python: { type: "string" }, out: { type: "string" }, report: { type: "string" }, cache: { type: "string", default: join(tmpdir(), "chimera-laya-eval") },
  "pypi-json": { type: "string" },
} });
const versions = values.versions!.split(",").map(v => v.trim()).filter(Boolean);
const trials = Number(values.trials);
const floor = Number(values.floor);
assert(versions.length >= 1 && new Set(versions).size === versions.length, "--versions needs distinct versions");
assert(Number.isInteger(trials) && trials >= 1 && trials <= 10, "--trials must be 1..10");
assert(floor >= 0 && floor <= 1, "--floor must be in [0, 1]");
assert.deepEqual(validateLayaEvalCases(LAYA_EVAL_CASES), [], "the case set is malformed");

const log = (message: string) => console.error(`[eval-laya] ${message}`);
const sha256File = (file: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(file).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
});

// ---- base interpreter ---------------------------------------------------------------------------
const integrations = join(chimeraHome(), "integrations");
const python = values.python ?? [`laya-${LAYA.version}`, "laya-0.3.22"].map(d => join(integrations, d, "bin", "python")).find(existsSync);
assert(python && existsSync(python), "No base interpreter with torch+transformers+mcp found. Pass --python <path> (macOS/Linux venv layout).");

// ---- wheels: pinned digest, or the digest committed in the PyPI fixture; never one fetched with the file
const fixturePath = fileURLToPath(new URL("./fixtures/pypi-laya.json", import.meta.url));
async function wheelFor(version: string): Promise<LayaWheel> {
  if (version === LAYA.version) return LAYA.wheel as LayaWheel;
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { releases?: Record<string, unknown> };
  // Keep historical digests available after a candidate becomes the pin, so the same command replays.
  const candidate = values["pypi-json"] ? JSON.parse(await readFile(values["pypi-json"], "utf8")) as { releases?: Record<string, unknown> } : null;
  const releases = { ...fixture.releases, ...candidate?.releases };
  const wheel = latestStable({ releases: { [version]: releases[version] } })?.wheel;
  assert(wheel, `Laya ${version} is neither the pin nor recorded in ${fixturePath}; record its digest there first`);
  return wheel;
}

async function stageOverlay(version: string): Promise<{ overlay: string; wheel: LayaWheel }> {
  const wheel = await wheelFor(version);
  assert(new URL(wheel.url).hostname === "files.pythonhosted.org", `unexpected wheel host: ${wheel.url}`);
  await mkdir(values.cache!, { recursive: true });
  const file = join(values.cache!, wheel.file);
  if (!existsSync(file) || (await sha256File(file)) !== wheel.sha256) {
    log(`downloading ${wheel.file} (cap ${MAX_WHEEL_BYTES / 1024 / 1024} MB)`);
    const res = await fetch(wheel.url, { signal: AbortSignal.timeout(60_000) });
    assert(res.ok, `wheel download failed: HTTP ${res.status}`);
    assert(Number(res.headers.get("content-length") ?? 0) <= MAX_WHEEL_BYTES, "wheel larger than the cap");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert(bytes.length <= MAX_WHEEL_BYTES, "wheel larger than the cap");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), wheel.sha256, "wheel sha256 does not match the recorded digest");
    await writeFile(file, bytes);
  }
  assert.equal(await sha256File(file), wheel.sha256, "cached wheel sha256 mismatch");
  const overlay = join(values.cache!, `overlay-${version}`);
  await rm(overlay, { recursive: true, force: true });
  await exec(python!, ["-m", "zipfile", "-e", file, overlay]);
  return { overlay: await realpath(overlay), wheel };
}

type Proof = { file: string; version: string | null; dist: string; mcp: string; torch: string; transformers: string; pinnedRevisions: Record<string, string> };

/** Import laya the way the server will (same interpreter, same PYTHONPATH) and report what actually loaded. */
async function proveImport(version: string, overlay: string): Promise<Proof> {
  const code = [
    "import json, importlib.metadata as m, laya, laya.revisions as r, torch, transformers",
    "print(json.dumps({'file': laya.__file__, 'version': getattr(laya, '__version__', None), 'dist': m.version('laya'), 'mcp': m.version('mcp'),",
    "  'torch': torch.__version__, 'transformers': transformers.__version__, 'pinnedRevisions': dict(r.PINNED_REVISIONS)}))",
  ].join("\n");
  const { stdout } = await exec(python!, ["-c", code], { env: { ...process.env, PYTHONPATH: overlay, PYTHONNOUSERSITE: "1" }, timeout: 120_000 });
  const proof = JSON.parse(stdout.trim().split("\n").pop()!) as Proof;
  assert((await realpath(proof.file)).startsWith(overlay + sep), `laya ${version} imported from ${proof.file}, not from the overlay ${overlay}`);
  assert.equal(proof.dist, version, `package metadata says ${proof.dist}, expected ${version}`);
  return proof;
}

// ---- checkpoint: full revision + digest, no download -------------------------------------------
async function verifyCheckpoint() {
  const { repo, revision, files } = LAYA.checkpoint as { repo: string; revision: string; files: Record<string, string> };
  const hub = process.env.HF_HUB_CACHE ?? join(process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface"), "hub");
  const repoDir = join(hub, `models--${repo.replace("/", "--")}`);
  const snapshot = join(repoDir, "snapshots", revision);
  assert(existsSync(snapshot), `checkpoint ${repo}@${revision} is not cached under ${hub}. This harness never downloads it; fetch it once with the Laya first-use install.`);
  const refMain = await readFile(join(repoDir, "refs", "main"), "utf8").then(s => s.trim()).catch(() => null);
  const verified: Record<string, { sha256: string; bytes: number; ok: boolean }> = {};
  for (const [name, expected] of Object.entries(files)) {
    const file = join(snapshot, name);
    assert(existsSync(file), `${file} is missing`);
    const sha256 = await sha256File(file);
    verified[name] = { sha256, bytes: (await stat(file)).size, ok: sha256 === expected };
    assert(verified[name]!.ok, `${name}: sha256 ${sha256} != pinned ${expected}`);
  }
  return { hub, repo, revision, refMain, refMainIsPinned: refMain === revision, files: verified };
}

// ---- the Chimera route -----------------------------------------------------------------------------
type Raw = { isError?: boolean; content?: unknown; structuredContent?: unknown };
type Route = { discover(): Promise<{ raw: Raw; ms: number }>; call(tool: string, args: Record<string, unknown>): Promise<{ raw: Raw; ms: number }>; close(): Promise<void> };

async function openRoute(env: Record<string, string>): Promise<Route> {
  const home = await mkdtemp(join(tmpdir(), "chimera-laya-eval-"));
  const registry = new McpStoreRegistry(home);
  registry.add(layaEntry({ home, python: python!, env }));
  const manager = new McpStoreConnectionManager(registry, new InMemoryKeychain());
  const server = await createChimeraMcpServer(async (method, p: any) => {
    if (method === "mcpstore.list") return registry.list();
    if (method === "mcpstore.tools") return { servers: await manager.tools(p.query, p.servers) };
    if (method === "mcpstore.call") return manager.call(p.server, p.tool, p.args, undefined, p.agentId);
    if (method === "mcpstore.session") return manager.session(p.server, p.action, p.agentId);
    throw new Error(`Unexpected method ${method}`);
  }, { depth: 0, agentId: "laya-eval" });
  const client = new Client({ name: "laya-eval", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const timed = async (name: string, args: Record<string, unknown>, timeout: number) => {
    const t0 = performance.now();
    // A tool failure may surface as an `isError` result or as a thrown protocol error; callers see one shape.
    const raw: Raw = await client.callTool({ name, arguments: args }, undefined, { timeout }).catch(error => ({ isError: true, content: [{ type: "text", text: String(error) }] }));
    return { raw, ms: performance.now() - t0 };
  };
  return {
    discover: () => timed("mcp_store_tools", { query: "laya" }, 120_000),
    call: (tool, args) => timed("mcp_store_call", { server: "laya", tool, args }, 300_000),
    close: async () => { await client.close(); await server.close(); await manager.closeAll(); await rm(home, { recursive: true, force: true }); },
  };
}

const textOf = (raw: Raw) => JSON.stringify(raw.content ?? raw);

/** What Chimera would do with a record, ignoring WHY it fell back (0.3.22 says server-abstained, a local-floor-only run says below-threshold). */
const verdict = (r: LayaEvalRecord) => { const g = gateRecord(r, { floor }); return "execute" in g ? `execute:${g.execute}` : "fallback"; };
const verdictDiffs = (a: readonly LayaEvalRecord[], b: readonly LayaEvalRecord[]) => a.filter((r, i) => b[i] && verdict(r) !== verdict(b[i]!)).length;

function serverEnv(overlay: string, checkpointHub: string, digests: Record<string, string>): Record<string, string> {
  return {
    // English only and fully offline: auto-routing must never be able to reach for the multilingual checkpoint.
    HF_HUB_OFFLINE: "1", HF_HUB_CACHE: checkpointHub, LAYA_MODELS: "english", LAYA_DEFAULT_MODEL: "english", LAYA_AUTO_TASK: "0",
    LAYA_REVISION: LAYA.checkpoint.revision, LAYA_SHA256_DIGESTS: JSON.stringify(digests), PYTHONNOUSERSITE: "1", PYTHONPATH: overlay,
  };
}

type TrialResult = {
  version: string; trial: number; order: number;
  discoveryMs: number; tools: string[]; batchServerGates: boolean; statusLaya: string | null; device: string | null;
  records: LayaEvalRecord[]; coldMs: number | null; coldServerMs: number | null;
  batch: { wallMs: number; totalLatencyMs: number | null; records: LayaEvalRecord[]; withAbstentionField: number } | null;
};

async function runTrial(version: string, trial: number, order: number, env: Record<string, string>): Promise<TrialResult> {
  const route = await openRoute(env);
  try {
    const discovery = await route.discover();
    const listing = JSON.parse((discovery.raw.content as { text: string }[])[0]!.text) as { servers: { connected: boolean; tools: { name: string; inputSchema: unknown }[] }[] };
    const server = listing.servers[0]!;
    assert(server.connected, `${version}: laya did not connect through the route: ${textOf(discovery.raw)}`);
    const tools = server.tools.map(t => t.name).sort();
    assert.deepEqual(tools, EXPECTED_TOOLS, `${version}: unexpected tool set`);

    const status = parseLayaPayload(await route.call("laya_status", {}));
    const statusLaya = status?.package_versions?.laya ?? null;
    assert.equal(statusLaya, version, `server reports laya ${statusLaya}, wanted ${version}`);

    const records: LayaEvalRecord[] = [];
    let coldMs: number | null = null;
    let coldServerMs: number | null = null;
    for (const c of LAYA_EVAL_CASES) {
      const { raw, ms } = await route.call("laya_predict", buildLayaChoiceRequest({ task: c.task, observation: c.observation, actions: c.actions, minConfidence: floor }));
      const decision = raw.isError ? null : parseLayaDecision(raw);
      if (!raw.isError && !decision) log(`${version} ${c.id}: unparseable answer: ${textOf(raw).slice(0, 200)}`);
      if (raw.isError) log(`${version} ${c.id}: tool error: ${textOf(raw).slice(0, 200)}`);
      if (records.length === 0) { coldMs = ms; coldServerMs = decision?.latencyMs ?? null; }
      records.push({ caseId: c.id, lang: c.lang, group: c.group, expected: c.expected, actions: Object.keys(c.actions), decision, wallMs: ms });
    }

    const batchTool = server.tools.find(t => t.name === "laya_predict_batch");
    const requests = LAYA_EVAL_CASES.map(c => { const { min_confidence: _drop, ...request } = buildLayaChoiceRequest({ task: c.task, observation: c.observation, actions: c.actions, minConfidence: floor }); return request; });
    // Top-level min_confidence: 0.3.27 honours it, 0.3.22's schema has no such parameter and ignores it.
    const batchCall = await route.call("laya_predict_batch", { requests, min_confidence: floor });
    const decisions = batchCall.raw.isError ? null : parseLayaBatch(batchCall.raw);
    const batch = decisions && decisions.length === LAYA_EVAL_CASES.length ? {
      wallMs: batchCall.ms,
      totalLatencyMs: parseLayaPayload(batchCall)?.total_latency_ms ?? null,
      records: LAYA_EVAL_CASES.map((c, i): LayaEvalRecord => ({ caseId: c.id, lang: c.lang, group: c.group, expected: c.expected, actions: Object.keys(c.actions), decision: decisions[i] ?? null, wallMs: null })),
      withAbstentionField: decisions.filter(d => d?.abstention != null).length,
    } : null;
    if (!batch) log(`${version}: batch result unusable: ${textOf(batchCall.raw).slice(0, 200)}`);

    return {
      version, trial, order, discoveryMs: discovery.ms, tools, batchServerGates: layaServerGatesBatch(batchTool?.inputSchema), statusLaya,
      device: status?.device ?? null, records, coldMs, coldServerMs, batch,
    };
  } finally {
    await route.close();
  }
}

/** The JSON payload inside an mcp_store_call result (see layaPayload for the envelope handling). */
function parseLayaPayload(call: { raw: Raw }): any {
  const sc = (call.raw.structuredContent as { result?: unknown } | undefined)?.result;
  if (typeof sc === "string") { try { return JSON.parse(sc); } catch { /* fall through to the text envelope */ } }
  const text = (call.raw.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
  const inner = (() => { try { return (JSON.parse(text) as { text?: string }).text ?? text; } catch { return text; } })();
  const start = inner.indexOf("{");
  const end = inner.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try { return JSON.parse(inner.slice(start, end + 1)); } catch { return null; }
}

/** A wrong digest must make the server refuse to load the checkpoint; a server that answers anyway is not verifying it. */
async function negativeControl(version: string, overlay: string, hub: string) {
  const route = await openRoute(serverEnv(overlay, hub, { "model.safetensors": "0".repeat(64) }));
  try {
    const c = LAYA_EVAL_CASES[0]!;
    const { raw } = await route.call("laya_predict", buildLayaChoiceRequest({ task: c.task, observation: c.observation, actions: c.actions, minConfidence: floor }));
    const text = textOf(raw);
    const message = text.match(/laya: SHA-256 mismatch[^"\\]*/i)?.[0] ?? text.slice(0, 200);
    return { version, refused: /SHA-256 mismatch/i.test(text), isError: Boolean(raw.isError), message };
  } finally {
    await route.close();
  }
}

// ---- main ---------------------------------------------------------------------------------------------
const checkpoint = await verifyCheckpoint();
log(`checkpoint ${checkpoint.repo}@${checkpoint.revision.slice(0, 12)} verified: ${Object.entries(checkpoint.files).map(([n, f]) => `${n} ${f.bytes} B sha256 ${f.sha256.slice(0, 12)}`).join(", ")}`);

const staged = new Map<string, { overlay: string; wheel: LayaWheel; proof: Proof }>();
for (const version of versions) {
  const { overlay, wheel } = await stageOverlay(version);
  staged.set(version, { overlay, wheel, proof: await proveImport(version, overlay) });
  log(`laya ${version}: imported from ${overlay} (mcp ${staged.get(version)!.proof.mcp}, torch ${staged.get(version)!.proof.torch})`);
}
const sameRevisions = new Set([...staged.values()].map(s => JSON.stringify(s.proof.pinnedRevisions))).size === 1;
const checkpointDigests = LAYA.checkpoint.files as Record<string, string>;

const runs: TrialResult[] = [];
for (let trial = 0; trial < trials; trial++) {
  const order = trial % 2 === 0 ? versions : [...versions].reverse();
  for (const [position, version] of order.entries()) {
    log(`trial ${trial + 1}/${trials}: laya ${version}`);
    runs.push(await runTrial(version, trial, position, serverEnv(staged.get(version)!.overlay, checkpoint.hub, checkpointDigests)));
  }
}
const negatives = [];
for (const version of versions) negatives.push(await negativeControl(version, staged.get(version)!.overlay, checkpoint.hub));

// ---- analysis -----------------------------------------------------------------------------------------
const opts = { floor };
const byVersion = (v: string) => runs.filter(r => r.version === v).sort((a, b) => a.trial - b.trial);
const analysis = versions.map(version => {
  const mine = byVersion(version);
  const first = mine[0]!;
  const determinism = mine.slice(1).map(r => diffRuns(first.records, r.records, opts));
  return {
    version,
    slice: breakdown(first.records, opts),
    // null (not true) when there is nothing to compare, so a 1-trial run cannot read as "deterministic".
    deterministic: determinism.length === 0 ? null : determinism.every(d => d.choiceDiffs.length === 0 && d.gateDiffs.length === 0 && d.probabilitiesIdentical),
    determinism,
    coldWall: mine.map(r => r.coldMs),
    coldServer: mine.map(r => r.coldServerMs),
    warmWall: summarizeLatency(mine.flatMap(r => r.records.slice(1).map(x => x.wallMs ?? Number.NaN))),
    warmServer: summarizeLatency(mine.flatMap(r => r.records.slice(1).map(x => x.decision?.latencyMs ?? Number.NaN))),
    discovery: summarizeLatency(mine.map(r => r.discoveryMs)),
    batch: mine.map(r => r.batch && ({
      wallMs: r.batch.wallMs, totalLatencyMs: r.batch.totalLatencyMs, withAbstentionField: r.batch.withAbstentionField,
      vsSequential: diffRuns(r.records, r.batch.records, opts),
      verdictDiffs: verdictDiffs(r.records, r.batch.records),
      slice: summarize(r.batch.records, opts),
    })),
    batchServerGates: first.batchServerGates,
    sweep: sweepFloors(first.records, [0, 0.5, 0.7, 0.8, 0.9, 0.95, 0.99]),
    device: first.device,
  };
});
const crossVersion = versions.length >= 2 ? diffRuns(byVersion(versions[0]!)[0]!.records, byVersion(versions.at(-1)!)[0]!.records, opts) : null;

const results = {
  meta: {
    date: new Date().toISOString(), floor, trials, versions, pin: LAYA.version, cases: LAYA_EVAL_CASES.length, basePython: python,
    host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? null, cores: cpus().length, node: process.version },
    checkpoint, pinnedRevisionsIdenticalAcrossVersions: sameRevisions,
    staged: Object.fromEntries([...staged].map(([v, s]) => [v, { wheel: s.wheel, proof: s.proof }])),
    scope: "English checkpoint only. Turkish cases are out of domain for it; the multilingual checkpoint was not downloaded and is untested.",
  },
  runs, negatives, analysis, crossVersion,
};
if (values.out) { await mkdir(dirname(values.out), { recursive: true }); // Compact, and with the home directory masked: this file is committed under docs/quality.
  await writeFile(values.out, `${JSON.stringify(results).replaceAll(homedir(), "~")}\n`); }

// ---- report -------------------------------------------------------------------------------------------------
const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const ci = (k: number, n: number) => { const w = wilson(k, n); return w ? `${pct(k / n)} [${pct(w[0])}, ${pct(w[1])}]` : "n/a"; };
const ms = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x.toFixed(0)}`);
const med = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)]! : null; };
const sliceRow = (label: string, s: Slice) => `| ${label} | ${s.n} | ${s.executed} | ${s.correct} | ${s.wrong} | ${s.overconfident} | ${s.handoffOk} | ${s.handoffMissed} | ${pct(s.coverage)} | ${pct(s.executedPrecision)} | ${pct(s.wrongActionRate)} | ${pct(s.abstentionRecall)} | ${s.rawAccuracy === null ? "n/a" : ci(s.rawCorrect, s.answerable)} |`;
const sliceHead = "| slice | n | executed | correct | wrong | over-confident | handoff ok | handoff missed | coverage | executed precision | wrong-action rate | abstention recall | raw argmax accuracy (95% CI) |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|";

const md: string[] = [];
md.push(`## Laya ${versions.join(" vs ")} — ${results.meta.date.slice(0, 16).replace("T", " ")} UTC`, "");
md.push(`Floor \`min_confidence\` ${floor}; ${LAYA_EVAL_CASES.length} synthetic cases; ${trials} trials per version (order alternated); host ${platform()} ${arch()}, ${results.meta.host.cpu}; device \`${analysis[0]!.device}\`.`, "");
md.push("### Provenance", "", "| laya | wheel sha256 | imported from | metadata | mcp | torch | transformers |", "|---|---|---|---|---|---|---|");
for (const [v, s] of staged) md.push(`| ${v} | \`${s.wheel.sha256.slice(0, 16)}…\` | \`${s.proof.file.replace(homedir(), "~")}\` | ${s.proof.dist} | ${s.proof.mcp} | ${s.proof.torch} | ${s.proof.transformers} |`);
md.push("", `Checkpoint \`${checkpoint.repo}\` @ \`${checkpoint.revision}\` (refs/main ${checkpoint.refMainIsPinned ? "equals" : "DIFFERS FROM"} the pin); ${Object.entries(checkpoint.files).map(([n, f]) => `\`${n}\` ${f.bytes} B sha256 \`${f.sha256}\` (matches LAYA.checkpoint)`).join("; ")}. \`PINNED_REVISIONS\` ${sameRevisions ? "identical" : "DIFFER"} across the compared versions.`, "");
md.push("### Wrong-digest negative control", "", "| laya | server refused the checkpoint | message |", "|---|---|---|");
for (const n of negatives) md.push(`| ${n.version} | ${n.refused ? "yes" : "**NO**"} | \`${n.message.replace(/\|/g, "/")}\` |`);
for (const a of analysis) {
  md.push("", `### Laya ${a.version} — decisions (trial 1)`, "", sliceHead, sliceRow("overall", a.slice.overall));
  for (const [k, s] of Object.entries(a.slice.byLang)) md.push(sliceRow(`lang ${k}${k === "tr" ? " (out of domain)" : ""}`, s));
  for (const [k, s] of Object.entries(a.slice.byGroup)) md.push(sliceRow(`group ${k}`, s));
  md.push("", a.determinism.length === 0
    ? "Determinism not tested (needs --trials >= 2)."
    : `Repeat trials ${a.deterministic ? "reproduced every choice, gate decision and probability exactly" : "**were NOT deterministic**"} (${a.determinism.length} comparisons).`);
}
md.push("", "### Latency (ms)", "", "| laya | first call, per trial (client) | first call, per trial (server) | warm client p50 / p95 | warm server p50 / p95 | discovery median |", "|---|---|---|---|---|---|");
for (const a of analysis) md.push(`| ${a.version} | ${a.coldWall.map(ms).join(", ")} | ${a.coldServer.map(ms).join(", ")} | ${ms(a.warmWall?.p50)} / ${ms(a.warmWall?.p95)} | ${ms(a.warmServer?.p50)} / ${ms(a.warmServer?.p95)} | ${ms(a.discovery?.p50)} |`);
md.push("", "### laya_predict_batch vs one call per case", "", "| laya | server gates batch | batch wall, per trial | server total, per trial | items with an abstention field | choices differing from sequential | execute/fallback verdicts differing | fallback reason differing |", "|---|---|---|---|---|---|---|---|");
for (const a of analysis) md.push(`| ${a.version} | ${a.batchServerGates ? "yes (min_confidence in schema)" : "no (parameter ignored; local floor only)"} | ${a.batch.map(b => ms(b?.wallMs)).join(", ")} | ${a.batch.map(b => ms(b?.totalLatencyMs)).join(", ")} | ${a.batch.map(b => b?.withAbstentionField ?? "n/a").join(", ")} | ${a.batch.map(b => b?.vsSequential.choiceDiffs.length ?? "n/a").join(", ")} | ${a.batch.map(b => b?.verdictDiffs ?? "n/a").join(", ")} | ${a.batch.map(b => (b ? b.vsSequential.gateDiffs.length - b.verdictDiffs : "n/a")).join(", ")} |`);
if (crossVersion) {
  md.push("", `### ${versions[0]} → ${versions.at(-1)}, case by case (trial 1)`, "",
    `Compared ${crossVersion.compared} cases; unmatched ${crossVersion.unmatched.length}; choice differences ${crossVersion.choiceDiffs.length}; gate differences ${crossVersion.gateDiffs.length}; max |Δ answer_confidence| ${crossVersion.maxConfidenceDelta === null ? "n/a" : crossVersion.maxConfidenceDelta.toExponential(2)}; per-action probabilities ${crossVersion.probabilitiesIdentical ? "identical" : "differ"}.`);
  for (const d of crossVersion.gateDiffs) md.push(`- ${d.caseId}: ${d.a} → ${d.b}`);
}
for (const a of analysis) {
  md.push("", `### Laya ${a.version} — local floor sweep (server verdict stripped)`, "", "| floor | executed | wrong | over-confident | coverage | executed precision | wrong-action rate | abstention recall |", "|---|---|---|---|---|---|---|---|");
  for (const r of a.sweep) md.push(`| ${r.floor} | ${r.executed} | ${r.wrong} | ${r.overconfident} | ${pct(r.coverage)} | ${pct(r.executedPrecision)} | ${pct(r.wrongActionRate)} | ${pct(r.abstentionRecall)} |`);
}
const text = `${md.join("\n")}\n`;
if (values.report) { await mkdir(dirname(values.report), { recursive: true }); await writeFile(values.report, text); }
console.log(text);

const failures = [
  ...negatives.filter(n => !n.refused).map(n => `laya ${n.version} loaded the checkpoint despite a wrong digest`),
  ...runs.filter(r => !r.batch).map(r => `laya ${r.version} trial ${r.trial}: batch result unusable`),
  ...runs.filter(r => r.records.some(x => x.decision === null)).map(r => `laya ${r.version} trial ${r.trial}: a laya_predict call failed`),
  ...(checkpoint.refMainIsPinned ? [] : [`refs/main (${checkpoint.refMain}) is not the pinned revision`]),
];
if (failures.length) { console.error(`[eval-laya] FAILED:\n- ${failures.join("\n- ")}`); process.exit(1); }
