import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chimeraHome, daemonEndpoint } from "@chimera/core/paths";
import { ConfigStore, ConfigWatcher } from "@chimera/core/configstore";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { PROVIDERS, effectiveCatalog } from "@chimera/core/providers/catalog";
import { buildBackends } from "@chimera/core/providers/registry";
import type { AgentBackend } from "@chimera/core";
import type { ChimeraEngineHandle } from "@chimera/core/backend";
import { reattachFromState } from "@chimera/core/reattach";
import { SnapshotScheduler } from "@chimera/core/snapshot";
import { startRpcServer } from "./server.js";
import { EngineIdentity } from "@chimera/core/federation/identity";
import { startFederationServer } from "./federation.js";
import { SshTunnelSupervisor } from "./ssh-tunnel.js";
import { logError } from "./logger.js";

// BOOT-LATENCY: a daemon that takes seconds to bind its socket is indistinguishable, from any
// client's point of view, from one that failed to start — which is exactly how a slow boot was
// being read ("chimerad won't come up"). The phase timings below turn that into a fact in the
// log instead of a guess, and are the regression signal if boot ever creeps back up.
const bootT0 = Date.now();
const bootPhases: string[] = [];
let lastPhaseAt = bootT0;
const bootPhase = (label: string): void => {
  const now = Date.now();
  bootPhases.push(`${label} ${now - lastPhaseAt}ms`);
  lastPhaseAt = now;
};

const home = chimeraHome();
mkdirSync(home, { recursive: true });
// SPOTLIGHT-EXCLUDE: keep the OS content indexer out of the daemon's own state directory.
//
// Measured on an operator's machine while RPCs were timing out at 30s: load average 103 on 12
// cores, and the single largest consumer was not chimera — it was Metadata.framework at 140% CPU,
// against a ~14% daemon. This directory is 2 GB across a thousand files that are rewritten
// constantly (event segments rotate, the audit ledger appends, agent records are rewritten per
// turn), so every write feeds the indexer, and the daemon then competes with it for the CPU it
// needs to answer a request. A fast handler on a starved thread still misses a deadline —
// queue.list measured 1 ms while accounts.list, which has to SPAWN a process, measured 2.7 s.
//
// Nothing here is ever Spotlight-searched: it is machine-local runtime state with chimera's own
// search over it (events.search, the chronicle index). The marker is the documented user-level
// opt-out, needs no privileges, and is inert if the indexer is already off.
//
// Best-effort by construction: a failure here must never stop the daemon from booting, and an
// existing file is left alone rather than rewritten on every start.
try {
  const marker = join(home, ".metadata_never_index");
  if (!existsSync(marker)) writeFileSync(marker, "");
} catch { /* an unwritable home surfaces on the next real write, not here */ }
const pidFile = join(home, "daemon.pid");
const stateFile = join(home, "state.json");
const socketPath = daemonEndpoint(home);

// SHUTDOWN-RACE (F01 follow-up): a signal that arrives while the daemon is still coming up used
// to hit nothing — process.on("SIGTERM", ...) was registered only after `await startRpcServer(...)`
// near the bottom of this file, so a restart-triggered SIGTERM landing in that window (the exact
// window a supervisor/launchd restart hits) exited with NO cleanup: no agent detach, no wake
// cancel (F01.1/F01.2 rely on detach() to release the caffeinate hold and cancel the outstanding
// RTC wake), no pid/socket file removed. Registering the handlers HERE, before claimPidFile()'s
// write and every await that follows, closes that window: `fullShutdown` stays null until the real
// shutdown() (defined near the bottom, once `server`/`engine`/etc. exist) assigns itself into it —
// a signal before that point runs `earlyShutdown` instead, which only ever has a pid file (maybe)
// to clean up. `shuttingDown` is shared across both paths so either one is idempotent on its own
// and across the pre/post-boot boundary.
let shuttingDown = false;
let pidFileClaimed = false;
let fullShutdown: (() => Promise<void>) | null = null;
function earlyShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // Do not unlink an endpoint before ownership is established. A signal during
  // startup must not remove another daemon's socket (or a user's regular file).
  // A socket left by our interrupted bind is recovered safely on the next boot.
  try { if (pidFileClaimed && existsSync(pidFile)) unlinkSync(pidFile); } catch { /* best-effort — process is exiting regardless */ }
  process.exit(0);
}
process.on("SIGTERM", () => { if (fullShutdown) void fullShutdown(); else earlyShutdown(); });
process.on("SIGINT", () => { if (fullShutdown) void fullShutdown(); else earlyShutdown(); });

// CHIMERA_TEST_SIGNAL_DELAY_MS: test-only. The pre-listen window this fix closes is real but
// sub-millisecond-to-a-few-ms wide in practice (dominated by tsx transpile time, which varies by
// machine/load), so hitting it via wall-clock timing from outside the process is inherently
// flaky. This widens the window on demand so a blackbox test can land a signal inside it
// deterministically. No-op unless the env var is set.
if (process.env.CHIMERA_TEST_SIGNAL_DELAY_MS) {
  // HANDLERS-READY MARKER (test-only, same gate): the window opens the instant the handlers above
  // are registered — but that instant is gated behind this module's ENTIRE import graph being
  // transpiled by tsx, measured at 400-565ms on this machine and load-dependent. A test that
  // sleeps a fixed wall-clock guess before signalling is therefore asserting "did transpile finish
  // in time?", not "does the early handler work" — and a false RED about clean shutdown, read
  // right before an operator restarts the daemon, is worse than no test at all. Writing the marker
  // HERE, after registration and before the widened window, gives the test the real precondition
  // to wait on. Deliberately not stdout: the child is spawned stdio:"ignore".
  try { writeFileSync(join(home, "signal-handlers-ready"), ""); } catch { /* test-only aid — never block boot */ }
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.CHIMERA_TEST_SIGNAL_DELAY_MS)));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
// SINGLETON-RACE: a plain read-check-then-write has a TOCTOU window — two chimerad processes
// starting within the same instant (e.g. a burst of worktree agents autostarting concurrently
// against the same home right after the prior daemon died) can both pass the "is anyone alive"
// check before either writes its own pid, then both proceed to boot and the loser steals the
// socket path (server.ts unconditionally unlinks+rebinds) out from under the winner — an orphan
// that ran ahead of this fix. `wx` (exclusive create) makes the claim itself one atomic syscall:
// at most one racer ever succeeds; every loser inspects what won and either refuses (a live
// daemon truly holds it) or removes a stale file and retries.
function claimPidFile(): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      writeFileSync(pidFile, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let old: number;
      try { old = Number(readFileSync(pidFile, "utf8")); } catch { continue; } // vanished mid-race — retry
      if (pidAlive(old)) { console.error(`chimerad already running (pid ${old})`); process.exit(1); }
      try { unlinkSync(pidFile); } catch { /* another loser already removed it — retry */ }
    }
  }
  throw new Error(`chimerad: could not claim ${pidFile} after repeated retries`);
}
claimPidFile();
pidFileClaimed = true;

// D7: the daemon boots against the EFFECTIVE config (config.json + config.d/* overlay) so a
// provider account added to the overlay gets its backend loaded at startup. This ONE store
// is reused by the Engine below (passed in via opts.configStore) so boot parses the config
// files exactly once instead of twice.
const configStore = new ConfigStore(home);
const cfg = configStore.current();
const providers = [...new Set(cfg.accounts.map((a) => a.provider))];
let backends: Map<string, AgentBackend>;
// INPROC-CHIMERA-BRIDGE: buildBackends() constructs every GenericAgentBackend BEFORE Engine
// exists below, so it can't be handed the real engine yet — engineBox is a lazy accessor that
// closes over this mutable slot, filled in the moment Engine is constructed. There is no await
// between here and that assignment, so a spawn can never observe engineBox.current still null
// (the daemon isn't accepting RPCs until well after this point).
const engineBox: { current: ChimeraEngineHandle | null } = { current: null };
const engineAccessor = { get: () => { if (!engineBox.current) throw new Error("chimera engine not ready yet"); return engineBox.current; } };
if (process.env.CHIMERA_BACKEND === "fake") {
  backends = new Map();
  for (const p of providers) backends.set(p, new FakeAgentBackend([], p));
} else {
  // F23-0D: PROVIDERS (packages/core/src/providers/catalog.ts) replaces the old hand-built
  // claude/codex-only map — every catalog provider referenced by a configured account gets
  // a real backend (claude/codex via their existing SDK-wrapper classes, every other
  // provider via GenericAgentBackend+OpenAICompatChatClient), with zero per-provider code
  // here. A configured account whose provider ISN'T in the catalog simply gets no backend
  // entry — AgentSupervisor.launch() already turns that into a clean spawn-time
  // UnknownAgentError, not a daemon crash.
  // Apply provider overrides and custom profiles before initial backend construction. The
  // Engine reconciles later config.patch writes for configured providers onto future spawns;
  // already-running agents keep the backend instance they launched with.
  // CUSTOM-OPENAI-COMPAT: effectiveCatalog also folds in a synthesized profile per
  // cfg.customProviders entry, so an operator's custom provider gets a real backend at boot
  // the same way a built-in does — no separate code path. (An account ADDED after boot for a
  // brand-new custom provider is picked up live by Engine.doReconcileBackends, which calls the
  // same helper — see engine.ts. A custom entry with no account needs no backend yet;
  // providers.models can still discover its models directly from the effective profile.)
  const catalog = effectiveCatalog(cfg);
  // DYNAMIC-MODEL-METADATA: hand the claude/codex backends a lazy accessor to the Engine's
  // model-metadata service (constructed just below) so their authoritative cost uses catalog
  // pricing. Lazy because the service lives on the Engine, which doesn't exist until after this call.
  backends = await buildBackends(catalog, {
    providers, engine: engineAccessor, modelCatalog: () => engineBox.current?.modelCatalog,
    // TERMINAL-RUNTIME: resolved HERE rather than inside the backend, for the same reason
    // codeRoot below is — the daemon knows where it was loaded from; core would have to guess.
    terminal: { home, mcpBin: fileURLToPath(new URL("../../mcp/bin/chimera-mcp.js", import.meta.url)) },
  });
}

// DAEMON-RUNS-FROM-DELETED-WORKTREE: this daemon's own resolved code root (packages/daemon/src,
// i.e. where THIS file loaded from) — passed in explicitly rather than left to Engine's
// import.meta.url fallback so daemon.status reports the daemon's actual location, not core's.
const codeRoot = dirname(fileURLToPath(import.meta.url));
// A `.chimera/worktrees/*` checkout is managed and routinely swept by the janitor; a daemon
// left running from inside one is one `rm -rf` away from silently serving stale, unmaintainable
// code (already-loaded modules survive in memory, but anything lazily require()'d later fails
// with an error pointing nowhere useful). A hard warning, not a refusal: killing dev's ability
// to ever start chimerad from a worktree would break legitimate local iteration (this very task
// is being developed from one). Loud and unmissable is the right tradeoff here, not a lockout.
if (/\/\.chimera\/worktrees\//.test(codeRoot)) {
  console.error(`chimerad: WARNING — running from inside a managed worktree (${codeRoot}). This directory is swept automatically and may be deleted out from under this process, leaving it running stale/broken code with no restart. Run from a permanent checkout for anything long-lived.`);
}
bootPhase("backends");
const engine = new Engine({ home, backends, configStore, codeRoot });
bootPhase("engine");
engineBox.current = engine;
// DYNAMIC-MODEL-METADATA: load the persisted catalog cache + (if enabled and stale/absent) kick a
// background remote refresh. Fire-and-forget — never blocks the daemon coming up, and a fetch
// failure degrades to the stale/empty cache + hardcoded fallback. Skipped under the fake backend so
// the test daemon never touches the network. init() itself only fetches when remote.enabled.
if (process.env.CHIMERA_BACKEND !== "fake") void engine.modelCatalog.init();
// ACCOUNT-QUOTA-METERS-PULL: same fake-backend gate as modelCatalog.init() just above — the
// test daemon (CHIMERA_BACKEND=fake) never touches the network. start() fires an immediate
// baseline poll of every claude account (so the meter is populated from daemon boot, not
// empty for the first cadence interval) then arms its own unref'd timer; no explicit stop()
// needed in shutdown() (same precedent as healthMonitor.start() below — dies with the process).
if (process.env.CHIMERA_BACKEND !== "fake") engine.quotaPoller.start();

let fedServer: { close(): Promise<void> } | null = null;
let tunnels: SshTunnelSupervisor[] = [];
if (engine.engineId !== "local") {
  const identity = EngineIdentity.loadOrCreate(home);
  fedServer = await startFederationServer({ socketPath: join(home, "federation.sock"), engine, identity });
  console.error(`chimerad federation: engine "${engine.engineId}" listening on ${join(home, "federation.sock")}`);
  tunnels = engine.peerConfigs().filter((p) => p.ssh).map((p) => new SshTunnelSupervisor({ peer: p }));
  for (const t of tunnels) t.start();
}

// Task CR2: re-attach prior running CONDUCTORS under their original agentId (resumed, idle) so a
// daemon restart brings orchestrator sessions back; every other prior running agent (spec §3: no
// reattach in v1) is still just marked "interrupted". See reattachConductors for the split.
// Task REATTACHTEST: the state.json read + torn-state tolerance is extracted into
// reattachFromState (packages/core/src/reattach.ts) so it's unit-testable with injected fakes.
// LAZY-REATTACH: cfg.reattach decides whether the prior run's running agents come back as
// process-less paused records (default) or are all re-spawned here and now.
reattachFromState(engine, stateFile, undefined, undefined, cfg.reattach);
bootPhase("reattach");

// FEATURE MAIN-CONDUCTOR-PERSISTENT: the daemon-owned MAIN conductor seat must always
// exist once onboarding is done — ensure it right after reattach (AgentSupervisor.spawn
// registers a record synchronously before its first `await`, so reattachConductors'
// fire-and-forget re-spawn above has already re-registered a prior running main
// conductor by the time this line runs; ensureMainConductor's own live-check then
// correctly no-ops instead of spawning a duplicate). Zero accounts ⇒ pre-onboarding,
// nothing to spawn a conductor WITH yet — skip entirely. Best-effort: a spawn failure
// must never block daemon boot.
if (cfg.accounts.length > 0) {
  engine.ensureMainConductor().catch((err) => logError("boot", "ensureMainConductor failed", err));
}

engine.scheduler.tick().catch((err) => logError("scheduler", "initial tick failed", err));   // re-drain queue tasks reverted to pending (spec §3); never crash-loop the daemon on persisted state

// D6 (Network & tailscale): if a tailscale auth key is stored and we are not logged in, join the
// tailnet now (`tailscale up --auth-key`) and BURN the key on success; a failure emits
// network_error (message scrubbed of the key) and never crashes boot.
engine.autoJoinNetwork().catch((err) => logError("network", "auto-join tailnet failed", err));

// FEATURE-4: crash-safe, DEBOUNCED snapshot (write-temp + fsync + rename + fsync-dir, on a
// bounded cadence rather than every single event — see SnapshotScheduler for the full
// rationale). Boot-time replay (reattachFromState) folds any events since the last flush back
// in, using `lastSeq` recorded alongside `agents`, so the interrupted-marking below still sees
// state as fresh as the crash allowed.
const snapshotScheduler = new SnapshotScheduler(engine, stateFile, {
  maxEvents: cfg.snapshot.maxEvents,
  maxIntervalMs: cfg.snapshot.maxIntervalMs,
});
snapshotScheduler.start();

// R2 (self-healing supervision): periodic liveness probe over running agents — started after
// full boot, alongside snapshotScheduler.start(). No explicit .stop() in shutdown(): its timer
// is unref'd (same precedent as JobScheduler's own timer), left to die with the process.
engine.healthMonitor.start();

const shutdown = async () => {
  if (shuttingDown) return;                       // SIGTERM/SIGINT/daemon.stop can race; tear down exactly once
  shuttingDown = true;
  snapshotScheduler.flush();                       // resumable running set on disk BEFORE teardown (crash mid-shutdown safe)
  // R2-DURABLE-LOG: force any pending group-commit fsync on the event log + every open mailbox
  // BEFORE teardown — a clean shutdown must never leave a group-commit window unflushed.
  engine.events.flushDurable();
  engine.mailboxes.flushDurable();
  // RESTART-RESUME: suspend, don't kill — processes are terminated but records
  // stay "running" (+sessionId), so the final snapshot persists a RESUMABLE set
  // and the next boot re-attaches every agent into its prior session. kill()
  // (state -> killed, never resumed) remains the user-initiated path only.
  await engine.supervisor.suspendForShutdown().catch((err) => logError("shutdown", "suspendForShutdown failed", err));
  await engine.mcpStoreConnections.closeAll().catch((err) => logError("mcpstore", "closeAll failed", err));
  // F49: revokes every live grant and closes the loopback socket. Ordered here rather than left to
  // process exit, because a grant outliving the daemon that authorises it is the one state this
  // listener must never reach.
  await engine.operatorWeb.close().catch((err) => logError("operator-web", "close failed", err));
  await engine.mcpListener.close().catch((err) => logError("mcp-listener", "close failed", err));
  snapshotScheduler.flush();                       // final truth: suspended-but-resumable
  configWatcher.stop();
  await engine.federation?.stop().catch((err) => logError("federation", "stop failed", err));
  await fedServer?.close().catch((err) => logError("federation", "server close failed", err));
  for (const t of tunnels) t.stop();
  // F01: releases the sleep assertion, cancels the outstanding OS wake event and flushes
  // lastTickMs [F02]. `caffeinate -w <daemon pid>` is only the backstop for the paths that never
  // reach here (SIGKILL, panic) — the clean path should not rely on it.
  engine.jobs.detach();
  await server.close();
  if (existsSync(pidFile)) unlinkSync(pidFile);
  process.exit(0);
};
const server = await startRpcServer({ socketPath, engine, onStop: () => void shutdown() });
// Only from this point on can shutdown() safely reference `server` — assigning it into
// fullShutdown here (rather than at its definition above) means a signal arriving any time before
// this line still finds fullShutdown null and takes earlyShutdown's minimal path instead of
// dereferencing a `server` that doesn't exist yet.
fullShutdown = shutdown;
bootPhase("listen");

// F12: warm the span store from the retained event log AFTER the socket is up, so a restart
// costs the operator's first sli.rollup nothing and daemon start nothing (measured ~750ms of
// read+parse; see the F12 plan). unref'd + fire-and-forget: it is a cache warm, never a boot
// dependency — rollup() rebuilds lazily on its own if this never runs.
// QA fix: replayFromLogAsync (worker-pool tailAsync) instead of the sync replayFromLog — the
// daemon is already accepting connections here, so a synchronous tail would stall every RPC/MCP
// call in flight for the duration of the read (measured 392ms on a real log).
setTimeout(() => { engine.otel.replayFromLogAsync().catch(() => { /* a cold rollup will retry */ }); }, 0).unref();

// D7 (coverage C9/C10): watch config.json + config.d/* and diff-apply live edits (300ms
// debounce). A broken file keeps the old config active + emits config_error; the daemon
// never crashes. engine.reloadConfig() does the reread/validate/diff-apply/emit.
const configWatcher = new ConfigWatcher({ home, onReload: () => engine.reloadConfig() });
configWatcher.start();

// ORPHANED-DAEMON-LEAK: opt-in (client.ts's autostart sets this whenever the caller passed an
// explicit `home` — every test/e2e spawn) parent-liveness watchdog. A daemon started this way
// must not outlive the process that spawned it: if that process is hard-killed (worktree
// teardown, CI timeout) before it gets the chance to call daemon.stop or send SIGTERM, this is
// the only thing that ever notices — nothing else observes a dead, unrelated parent. Polling
// (not a 'disconnect' hook) because there is no portable Node event for "an arbitrary other
// process, not a pipe/stdio owner, exited"; 5s is frequent enough that a leaked daemon dies
// within seconds instead of days, cheap enough to run for a process's whole life.
const parentPid = process.env.CHIMERA_PARENT_PID ? Number(process.env.CHIMERA_PARENT_PID) : null;
if (parentPid !== null) {
  const parentWatch = setInterval(() => {
    if (!pidAlive(parentPid)) {
      console.error(`chimerad: spawning parent (pid ${parentPid}) is gone — this is an ephemeral daemon (CHIMERA_PARENT_PID set) and must not outlive it. Shutting down.`);
      void shutdown();
    }
  }, 5000);
  parentWatch.unref();
}

console.error(`chimerad listening on ${join(home, "daemon.sock")} (boot ${Date.now() - bootT0}ms: ${bootPhases.join(", ")})`);
