#!/usr/bin/env -S node --import tsx
// W2-6 EFFORT-AB-HARNESS: a minimal A/B runner that spawns real agents at two
// `effort` levels against a fixed, mechanically-checkable task set and reports
// success (repo's own tsc+vitest gates — no invented rubric), tokens
// (billableUsage, per P0-1 — see @chimera/protocol's UsageRowSchema doc
// comment), and wall time, per level.
//
// Dev-only: lives under packages/client/bench/, a sibling of src/ — the same
// exclusion trick packages/app/perf/ uses (client/tsconfig.json's
// `include: ["src"]` never sees this dir, so it's outside tsc(src), the
// production build, and every copy-guard by construction, not by an added
// rule).
//
//   node --import tsx packages/client/bench/effort-ab/run.ts [options]
//
// Options:
//   --effort-a <level>   first effort level to compare (default: low)
//   --effort-b <level>   second effort level to compare (default: xhigh)
//   --effort <level>     repeatable; N-way effort comparison (e.g. pass three
//                        times for low/medium/xhigh). Overrides effort-a/-b.
//   --reps <n>           repeat each (task, effort) cell n times (default 1)
//                        — W2-7: this is what makes a reading POWERED instead
//                        of a single lucky/unlucky run per cell.
//   --concurrency <n>    run up to n agents at once (default 1, sequential
//                        like the original harness); safe because every cell
//                        has its own scratchDir/agentId.
//   --backend <name>     account name to spawn under (default: claude)
//   --provider <name>    provider id (default: claude)
//   --task <id>          run only this task id (repeatable; default: all)
//   --home <path>        reuse an existing throwaway CHIMERA_HOME instead of
//                         creating + tearing down a fresh one
//
// Method (mirrors the RM-1 rebaseline recipe — chimera/tokenopt memory
// b003ccd9): spins up a fully ISOLATED throwaway chimerad against a fresh
// CHIMERA_HOME, never touches the shared production daemon/socket/state.
// Account NAMES/types mirror the shared daemon's config.d/ui.json
// (claude+codex "subscription") because credentials resolve at the OS
// keychain/CLI level, not per-CHIMERA_HOME — this reuses real credentials
// with zero risk to the shared daemon.

import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ChimeraClient } from "../../src/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../..");
const FIXTURES_DIR = join(HERE, "fixtures");
const TSC_BIN = join(REPO_ROOT, "node_modules/.bin/tsc");
const VITEST_BIN = join(REPO_ROOT, "node_modules/.bin/vitest");
// Scratch copies MUST live inside the repo tree, not os.tmpdir() — tsc/vitest
// running inside a scratch dir resolve `vitest`/`typescript` by walking up to
// the repo's own node_modules; a dir outside the repo has no such ancestor.
// Gitignored (see .gitignore).
const RUNS_DIR = join(HERE, ".runs");

type Task = { id: string; dir: string; prompt: string };

// SCOPE DISCIPLINE (per the task brief): a HANDFUL of real, mechanically
// checkable tasks beats a large synthetic suite. Each fixture is a tiny
// self-contained TS project (own tsconfig.json + vitest.config.ts) with one
// seeded logic bug; success = tsc --noEmit clean AND vitest green, the
// repo's own gate shape, nothing invented.
const TASKS: Task[] = [
  {
    id: "median",
    dir: "median",
    prompt:
      "This is a tiny standalone TypeScript project (median.ts + median.check.ts, a vitest " +
      "test file). Run `npx tsc --noEmit -p tsconfig.json` and " +
      "`npx vitest run --config vitest.config.ts` in this directory to see the current state. " +
      "One test fails. Find the bug in median.ts and fix it — do not change the test file. " +
      "When both tsc and vitest pass, you're done.",
  },
  {
    id: "rate-limiter",
    dir: "rate-limiter",
    prompt:
      "This is a tiny standalone TypeScript project (bucket.ts, limiter.ts, limiter.check.ts, " +
      "a vitest test file). Run `npx tsc --noEmit -p tsconfig.json` and " +
      "`npx vitest run --config vitest.config.ts` in this directory to see the current state. " +
      "One test fails. Find the bug (it's a unit-conversion mistake in the token-bucket refill " +
      "math) and fix it — do not change the test file. When both tsc and vitest pass, you're done.",
  },
  // W2-7: two HARDER fixtures targeting the blind spot the N=2 reading was
  // silent on — root cause not local to the failing test, and an ambiguous
  // spec with a naive-patch trap. Both still gated purely by tsc+vitest.
  {
    id: "cart-discount",
    dir: "cart-discount",
    prompt:
      "This is a small multi-file TypeScript cart-pricing project (money.ts, discount.ts, " +
      "cart.ts, cart.check.ts, a vitest test file). Run `npx tsc --noEmit -p tsconfig.json` and " +
      "`npx vitest run --config vitest.config.ts` in this directory to see the current state. " +
      "Some tests fail. Find the root cause and fix it — do not change the test file. The bug " +
      "may not be in the file closest to the failing assertion; read across files if needed. " +
      "When both tsc and vitest pass, you're done.",
  },
  {
    id: "meeting-overlap",
    dir: "meeting-overlap",
    prompt:
      "This is a tiny standalone TypeScript project (interval.ts, interval.check.ts, a vitest " +
      "test file) implementing meeting-overlap detection. Run `npx tsc --noEmit -p tsconfig.json` " +
      "and `npx vitest run --config vitest.config.ts` in this directory to see the current state. " +
      "Some tests fail. The exact intended semantics for boundary cases are not fully spelled out " +
      "in prose — the test file's edge cases are the authoritative spec, so read all of them " +
      "carefully before you decide on a fix. Do not change the test file. When both tsc and " +
      "vitest pass, you're done.",
  },
];

type RunResult = {
  task: string;
  effort: string;
  rep: number;
  agentState: string;
  tscPass: boolean;
  vitestPass: boolean;
  wallMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  billableTokens: number;
  scratchDir: string;
};

function parseArgs(argv: string[]) {
  const opts = {
    effortLevels: ["low", "xhigh"] as string[],
    explicitEfforts: [] as string[],
    backend: "claude",
    provider: "claude",
    taskIds: null as string[] | null,
    home: null as string | null,
    // W2-7 POWERED: repeat each (task, effort) cell `reps` times so one lucky
    // or unlucky run can't decide the reading; run up to `concurrency` agents
    // at once (each cell has its own scratchDir/agentId, so concurrent spawns
    // are safe — see runPool below) to keep wall time sane at N>1.
    reps: 1,
    concurrency: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--effort-a") opts.effortLevels[0] = argv[++i];
    else if (a === "--effort-b") opts.effortLevels[1] = argv[++i];
    else if (a === "--effort") opts.explicitEfforts.push(argv[++i]);
    else if (a === "--backend") opts.backend = argv[++i];
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "--task") opts.taskIds = [...(opts.taskIds ?? []), argv[++i]];
    else if (a === "--home") opts.home = argv[++i];
    else if (a === "--reps") opts.reps = Number(argv[++i]);
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]);
  }
  // --effort (repeatable) fully overrides the effort-a/effort-b pair once
  // used, so 3+ level comparisons (e.g. low/medium/xhigh) don't need to
  // shoehorn into the original 2-slot flags.
  if (opts.explicitEfforts.length > 0) opts.effortLevels = opts.explicitEfforts;
  return opts;
}

// Simple concurrency-limited pool: `concurrency` workers pull from a shared
// index cursor until the item list is exhausted. Each cell's own scratchDir
// and agentId are independent, so concurrent spawns against the same
// throwaway daemon are safe (per-account cap defaults to maxAgentsTotal=12,
// see packages/protocol/src/index.ts — comfortably above any concurrency
// used here).
async function runPool<In, Out>(items: In[], concurrency: number, worker: (item: In) => Promise<Out>): Promise<Out[]> {
  const results: Out[] = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runWorker));
  return results;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

// The shared production daemon's config.d/ui.json account shapes (name +
// provider + auth.type only — never touch or copy secrets). Subscription
// auth resolves via the OS keychain/CLI at spawn time, independent of
// CHIMERA_HOME, so a fresh isolated home with these same account NAMES gets
// the same real credentials with zero blast radius on the shared daemon.
const THROWAWAY_CONFIG = {
  accounts: [
    { name: "claude", provider: "claude", auth: { type: "subscription" } },
    { name: "codex", provider: "codex", auth: { type: "subscription", homeDir: join(process.env.HOME ?? "", ".codex") } },
  ],
};

function runGate(scratchDir: string): { tscPass: boolean; vitestPass: boolean; tscOut: string; vitestOut: string } {
  const tsc = spawnSync(TSC_BIN, ["--noEmit", "-p", join(scratchDir, "tsconfig.json")], { encoding: "utf8" });
  const vitest = spawnSync(VITEST_BIN, ["run", "--config", join(scratchDir, "vitest.config.ts")], {
    encoding: "utf8",
    cwd: scratchDir,
  });
  return {
    tscPass: tsc.status === 0,
    vitestPass: vitest.status === 0,
    tscOut: (tsc.stdout ?? "") + (tsc.stderr ?? ""),
    vitestOut: (vitest.stdout ?? "") + (vitest.stderr ?? ""),
  };
}

async function waitTerminal(client: ChimeraClient, agentId: string, deadlineMs: number): Promise<string> {
  const TERMINAL = new Set(["done", "failed", "killed"]);
  for (;;) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new Error(`agent ${agentId} did not reach a terminal state before the deadline`);
    // supervisor.waitFor REJECTS (not returns) when its own timeoutMs elapses before a
    // terminal state — it's a polling primitive, not a single long wait. Swallow that one
    // rejection shape and keep polling until OUR deadline; anything else is a real error.
    try {
      const rec = await client.request<{ state: string }>("agent.wait", { agentId, timeoutMs: Math.min(300_000, remaining) });
      if (TERMINAL.has(rec.state)) return rec.state;
    } catch (e) {
      // client.request rejects with the RAW RPC error shape ({code, message}), not an Error
      // instance (see ChimeraClient's `p.reject(r.error)` / disconnect-object reject) — check
      // `.message` directly rather than `instanceof Error`, which this never satisfies.
      const msg = (e as { message?: unknown } | undefined)?.message;
      if (typeof msg !== "string" || !msg.includes("waitFor timed out")) throw e;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasks = opts.taskIds ? TASKS.filter((t) => opts.taskIds!.includes(t.id)) : TASKS;
  if (tasks.length === 0) throw new Error("no matching tasks");

  const home = opts.home ?? mkdtempSync(join(tmpdir(), "chimera-effort-ab-"));
  const ownHome = !opts.home;
  if (!existsSync(join(home, "config.json"))) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify(THROWAWAY_CONFIG, null, 2));
  }
  console.log(`CHIMERA_HOME = ${home}${ownHome ? " (fresh, isolated, torn down on exit)" : " (reused)"}`);

  // ChimeraClient.connect's own autostart retry window is a fixed 5s — too
  // short for a cold daemon boot that also fetches the model catalog over the
  // network (observed: daemon.log shows it listening ~6-7s in). Retry the
  // connect itself (autostart:false after the first attempt, since the first
  // attempt's spawn is still coming up) instead of patching the shared client.
  async function connectWithRetry(): Promise<ChimeraClient> {
    const deadline = Date.now() + 60_000;
    let lastErr: unknown;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      try {
        return await ChimeraClient.connect({ home, autostart: attempt === 0 });
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw lastErr;
  }
  const client = await connectWithRetry();

  type Cell = { task: Task; effort: string; rep: number };
  const cells: Cell[] = [];
  for (const task of tasks) {
    for (const effort of opts.effortLevels) {
      for (let rep = 1; rep <= opts.reps; rep++) cells.push({ task, effort, rep });
    }
  }
  console.log(`${cells.length} cells (${tasks.length} tasks x ${opts.effortLevels.length} efforts x ${opts.reps} reps), concurrency=${opts.concurrency}`);

  async function runCell({ task, effort, rep }: Cell): Promise<RunResult> {
    mkdirSync(RUNS_DIR, { recursive: true });
    const scratchDir = mkdtempSync(join(RUNS_DIR, `${task.id}-${effort}-r${rep}-`));
    cpSync(join(FIXTURES_DIR, task.dir), scratchDir, { recursive: true });

    console.log(`\n=== ${task.id} @ effort=${effort} rep=${rep} ===`);
    console.log(`scratch: ${scratchDir}`);

    const startTs = Date.now();
    const spawned = await client.request<{ agentId: string }>("agent.spawn", {
      spec: {
        prompt: task.prompt,
        cwd: scratchDir,
        isolation: "none",
        account: opts.backend,
        provider: opts.provider,
        effort,
        permissionProfile: "acceptEdits",
        maxTurns: 20,
      },
    });
    const agentId = spawned.agentId;
    console.log(`spawned ${agentId} (${task.id}/${effort}/r${rep})`);

    const agentState = await waitTerminal(client, agentId, startTs + 15 * 60_000);
    const endTs = Date.now();
    const wallMs = endTs - startTs;
    console.log(`${agentId} terminal state: ${agentState} (${wallMs}ms)`);

    const gate = runGate(scratchDir);
    console.log(`${agentId} gate: tsc=${gate.tscPass ? "PASS" : "FAIL"} vitest=${gate.vitestPass ? "PASS" : "FAIL"}`);
    if (!gate.tscPass || !gate.vitestPass) {
      console.log(`--- ${agentId} gate output (tail) ---`);
      console.log((gate.tscOut + "\n" + gate.vitestOut).split("\n").slice(-25).join("\n"));
    }

    // usage.query aggregates billableUsage (cost-scope, cumulative — see
    // P0-1 / protocol UsageQueryGroup doc comment), grouped by agent so
    // this pulls exactly this one spawn's totals. +2000ms pads clock
    // skew between this process and the daemon's own event timestamps.
    const usage = await client.request<{
      groups: Array<{ key: string; costUsd: number; tokensIn: number; tokensOut: number; cacheReadTokens: number; cacheCreationTokens: number }>;
    }>("usage.query", { from: startTs - 2000, to: endTs + 2000, groupBy: "agent" });
    const group = usage.groups.find((g) => g.key === agentId) ?? {
      key: agentId,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    return {
      task: task.id,
      effort,
      rep,
      agentState,
      tscPass: gate.tscPass,
      vitestPass: gate.vitestPass,
      wallMs,
      costUsd: group.costUsd,
      tokensIn: group.tokensIn,
      tokensOut: group.tokensOut,
      cacheReadTokens: group.cacheReadTokens,
      cacheCreationTokens: group.cacheCreationTokens,
      billableTokens: group.tokensIn + group.tokensOut + group.cacheReadTokens + group.cacheCreationTokens,
      scratchDir,
    };
  }

  let results: RunResult[] = [];
  try {
    results = await runPool(cells, opts.concurrency, runCell);
  } finally {
    client.close();
    if (ownHome) {
      try {
        const pid = Number(readFileSync(join(home, "daemon.pid"), "utf8").trim());
        if (pid > 0) process.kill(pid, "SIGTERM");
      } catch {
        // no pid file / already gone — nothing to tear down
      }
    }
  }

  console.log("\n\n=== RESULTS (per run) ===");
  const header = ["task", "effort", "rep", "state", "tsc", "vitest", "wallMs", "costUsd", "tokensIn", "tokensOut", "cacheRead", "cacheCreate", "billableTokens"];
  console.log(header.join("\t"));
  for (const r of results) {
    console.log(
      [
        r.task,
        r.effort,
        r.rep,
        r.agentState,
        r.tscPass ? "PASS" : "FAIL",
        r.vitestPass ? "PASS" : "FAIL",
        r.wallMs,
        r.costUsd.toFixed(4),
        r.tokensIn,
        r.tokensOut,
        r.cacheReadTokens,
        r.cacheCreationTokens,
        r.billableTokens,
      ].join("\t"),
    );
  }

  // W2-7 POWERED: aggregate per (task, effort) cell so a single lucky/unlucky
  // run can't decide the reading — report n, gate-pass rate, and mean±stdev
  // for the metrics that matter. Any gate FAILURE is called out on its own
  // line regardless of aggregate cost savings, per the brief.
  console.log("\n=== AGGREGATE (per task x effort cell) ===");
  const aggHeader = ["task", "effort", "n", "passRate", "meanCostUsd", "sdCostUsd", "meanBillableTok", "sdBillableTok", "meanWallMs", "sdWallMs"];
  console.log(aggHeader.join("\t"));
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = `${r.task} ${r.effort}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  for (const [key, rs] of groups) {
    const [task, effort] = key.split(" ");
    const passed = rs.filter((r) => r.tscPass && r.vitestPass);
    console.log(
      [
        task,
        effort,
        rs.length,
        `${passed.length}/${rs.length}`,
        mean(rs.map((r) => r.costUsd)).toFixed(4),
        stdev(rs.map((r) => r.costUsd)).toFixed(4),
        Math.round(mean(rs.map((r) => r.billableTokens))),
        Math.round(stdev(rs.map((r) => r.billableTokens))),
        Math.round(mean(rs.map((r) => r.wallMs))),
        Math.round(stdev(rs.map((r) => r.wallMs))),
      ].join("\t"),
    );
    if (passed.length < rs.length) {
      console.log(`  !!! GATE FAILURE: ${task}/${effort} passed only ${passed.length}/${rs.length} — see per-run rows above for which rep(s).`);
    }
  }

  console.log("\n" + JSON.stringify(results, null, 2));

  // The SIGTERM'd daemon can still hold home/daemon.sock open for a beat after we send the
  // signal (no wait() on a detached+unref'd child) — rmSync recursive:true still races an
  // in-flight unlink/rewrite under that fd on macOS. A couple retries clears it without
  // needing to actually wait() the detached process.
  if (ownHome) {
    for (let attempt = 0; ; attempt++) {
      try { rmSync(home, { recursive: true, force: true }); break; }
      catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
