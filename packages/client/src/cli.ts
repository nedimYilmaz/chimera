// Entry module for the `chimera` CLI. Not exec'd directly (a #!/usr/bin/env node
// shebang can't run TypeScript) — bin/chimera.js registers tsx then imports this.
import { ChimeraClient } from "./client.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chimeraHome } from "@chimera/core/paths";
import { collectDoctor, supportReport } from "./doctor.js";

const [cmd, ...rest] = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string>();
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) {
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(a.slice(2), next); i++; }
    else flags.set(a.slice(2), "true");
  } else positional.push(a);
}
const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
const fail = (e: unknown): never => {
  // Error instances JSON.stringify to "{}" and lose their message; surface it so a
  // connect/startup failure ("chimerad did not come up") prints something actionable.
  console.error(JSON.stringify(e instanceof Error ? { message: e.message } : e));
  process.exit(1);
};

// Offline diagnostics must work even when the daemon cannot boot.
if (cmd === "doctor" || cmd === "support-report") {
  const report = collectDoctor(chimeraHome());
  out(cmd === "support-report" ? supportReport(report) : report);
  process.exit(report.ok ? 0 : 1);
}

// `federation init` is an offline key-gen operation and must NOT autostart a
// daemon, so this is handled BEFORE the shared ChimeraClient.connect() below
// (not as a switch case — a case would fall through to the connect first).
if (cmd === "federation") {
  const sub = positional[0];
  const home = chimeraHome();
  if (sub === "init") {
    const { EngineIdentity } = await import("@chimera/core/federation/identity");
    const identity = EngineIdentity.loadOrCreate(home);
    let engineId = "<unset - add engine.id to config.json>";
    try { engineId = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).engine?.id ?? engineId; } catch {}
    console.log(JSON.stringify({
      engineId,
      publicKey: identity.publicKey,
      federationSocket: join(home, "federation.sock"),
      pasteIntoPeerConfig: {
        engineId, publicKey: identity.publicKey,
        socketPath: `<local path this machine's ssh forward creates, e.g. ~/.chimera/peers/${engineId}.sock>`,
        allowSpawn: false, accounts: [],
      },
    }, null, 2));
    console.log("# tip: raise permissionTimeoutMs for cross-engine poke:caller spawns (link round-trip eats into the 120s default)");
    process.exit(0);
  }
  if (sub === "status") {
    const c = await ChimeraClient.connect().catch(fail);
    try {
      const st = await c.request<{ engineId: string; peers: Array<{ engineId: string; state: string; outboxPending: number }> }>("daemon.status");
      console.log(`engine: ${st.engineId}`);
      if (!st.peers?.length) console.log("no peers configured");
      else for (const p of st.peers) console.log(`${p.engineId}\t${p.state}\toutbox:${p.outboxPending}`);
      c.close();
      process.exit(0);
    } catch (e) { c.close(); fail(e); }   // mirror the main switch's error discipline (clean {message} + closed socket)
  }
  console.error("usage: chimera federation <init|status>");
  process.exit(1);
}

// `start`/`stop` manage the installed auto-start service (scripts/install.sh's launchd
// agent / systemd user unit) when present, so a KeepAlive/Restart=on-failure service
// doesn't immediately relaunch what `stop` just shut down. Handled BEFORE the shared
// ChimeraClient.connect() below (same reason as `federation`) since that call
// autostarts chimerad — exactly the side effect `stop` must not trigger, and `start`
// wants to route through the service manager instead of a bare detached spawn.
function launchdLabel(): string { return process.env.CHIMERA_LAUNCHD_LABEL ?? "com.chimera.chimerad"; }
function systemdUnit(): string { return process.env.CHIMERA_SYSTEMD_UNIT ?? "chimerad.service"; }
function launchdPlistPath(): string { return join(homedir(), "Library", "LaunchAgents", `${launchdLabel()}.plist`); }
function systemdUnitPath(): string { return join(homedir(), ".config", "systemd", "user", systemdUnit()); }

// Best-effort: drives the OS service manager if a service was installed by
// scripts/install.sh; returns false (caller falls back to a direct daemon
// action) when no service is present for this platform.
function controlService(action: "start" | "stop"): boolean {
  if (process.platform === "darwin" && existsSync(launchdPlistPath())) {
    const uid = process.getuid?.() ?? 0;
    const domain = `gui/${uid}`;
    const target = `gui/${uid}/${launchdLabel()}`;
    if (action === "stop") {
      // Unload the job instead of only sending SIGTERM: the installer sets
      // KeepAlive, so a plain signal can be interpreted as a crash and restart.
      spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
    } else {
      const loaded = spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status === 0;
      if (!loaded) spawnSync("launchctl", ["bootstrap", domain, launchdPlistPath()], { stdio: "ignore" });
      spawnSync("launchctl", ["enable", target], { stdio: "ignore" });
      spawnSync("launchctl", ["kickstart", target], { stdio: "ignore" });
    }
    return true;
  }
  if (process.platform === "linux" && existsSync(systemdUnitPath())) {
    spawnSync("systemctl", ["--user", action, systemdUnit()], { stdio: "ignore" });
    return true;
  }
  return false;
}

// `restart` is stop-then-start in one gesture: it falls THROUGH the stop block below (without
// exiting) into the start block. Worth having as its own verb because the two-command version has
// a race an operator can't see — `chimera stop && chimera start` can reconnect to a daemon that
// is still releasing its socket, and then "started" reports the old process. The settle wait
// below is the part that is easy to forget by hand.
if (cmd === "stop" || cmd === "restart") {
  if (!controlService("stop")) {
    try {
      const c = await ChimeraClient.connect({ autostart: false });
      await c.request("daemon.stop");
      c.close();
    } catch { /* not running — nothing to stop */ }
  }
  if (cmd === "stop") {
    out({ ok: true });
    process.exit(0);
  }
  // Give the old process its socket-release window before the start path's autostart connect,
  // which would otherwise happily attach to the daemon we just asked to die.
  for (let i = 0; i < 25; i++) {
    try {
      const c = await ChimeraClient.connect({ autostart: false });
      c.close();
      await new Promise((r) => setTimeout(r, 200));
    } catch { break; }   // refused connection == it is gone
  }
}

if (cmd === "start" || cmd === "restart") {
  if (!controlService("start")) await ChimeraClient.connect().catch(fail);   // fallback: same detached-spawn autostart as every other command
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const c = await ChimeraClient.connect({ autostart: false });
      const st = await c.request("daemon.status");
      c.close();
      out(st);
      process.exit(0);
    } catch (e) {
      if (Date.now() > deadline) fail(e);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

const client = await ChimeraClient.connect().catch(fail);   // existing line stays, now only reached for non-federation/start/stop commands

try {
  switch (cmd) {
    case "status": out(await client.request("daemon.status")); break;
    case "spawn": {
      const spec: Record<string, unknown> = { prompt: flags.get("prompt"), cwd: flags.get("cwd") };
      if (flags.has("account")) spec.account = flags.get("account");
      if (flags.has("isolation")) spec.isolation = flags.get("isolation");
      if (flags.has("profile")) spec.permissionProfile = flags.get("profile");
      if (flags.has("deliver-to")) spec.deliverTo = flags.get("deliver-to");
      if (flags.has("provider")) spec.provider = flags.get("provider");
      if (flags.has("cross-provider-failover")) spec.crossProviderFailover = flags.get("cross-provider-failover") === "true";
      const rec = await client.request<{ agentId: string }>("agent.spawn", { spec });
      if (flags.has("wait")) out(await client.request("agent.wait", { agentId: rec.agentId, timeoutMs: Number(flags.get("timeout") ?? 60_000) }));
      else out(rec);
      break;
    }
    // OPERATOR-HOLD: takes ids as positionals so a shell pipeline can drive it —
    // `chimera hold $(...)` is the whole reason a CLI surface exists for this.
    case "hold":
    case "release": {
      if (positional.length === 0) fail(new Error(`usage: chimera ${cmd} <agentId> [agentId...]`));
      out(await client.request(cmd === "hold" ? "agent.hold" : "agent.release", { agentIds: positional }));
      break;
    }
    case "wait": out(await client.request("agent.wait", { agentId: positional[0], timeoutMs: Number(flags.get("timeout") ?? 60_000) })); break;
    case "listen": {
      const kinds = new Set((flags.get("events") ?? "result").split(","));
      const agentId = flags.get("agent");
      const timeoutMs = Number(flags.get("timeout") ?? 300_000);
      const hit = await new Promise<unknown | null>((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        // A subscribe failure is a real error (exit 1), not a poke-channel timeout
        // (exit 2) — hooks branch on that exact code, so don't let the void'd
        // rejection masquerade as "no event arrived".
        client.subscribe(agentId ? { agentId } : {}, (e) => {
          if (kinds.has(e.kind)) { clearTimeout(timer); resolve(e); }
        }).catch((err) => { clearTimeout(timer); reject(err); });
      });
      if (hit === null) { client.close(); process.exit(2); }
      out(hit);
      break;
    }
    case "send": out(await client.request("agent.send", { agentId: positional[0], text: positional.slice(1).join(" ") })); break;
    case "kill": out(await client.request("agent.kill", { agentId: positional[0] })); break;
    case "signal": out(await client.request("agent.send", {
      agentId: flags.get("agent"), text: flags.get("text") ?? "", from: `hook:${flags.get("kind") ?? "unknown"}`,
    })); break;
    case "answer": {
      const optionIds: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        // mirror the top-level parser's guard: a dangling `--option` before another
        // flag (or at argv end) contributes nothing, instead of swallowing the next
        // flag's name as a bogus optionId that would resolve the question with junk.
        if (rest[i] === "--option" && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) optionIds.push(rest[++i]!);
      }
      const answer: { optionIds?: string[]; text?: string } = {};
      if (optionIds.length) answer.optionIds = optionIds;
      if (flags.has("text")) answer.text = flags.get("text")!;
      out(await client.request("agent.answerQuestion", { questionId: positional[0], answer }));
      break;
    }
    case "team": {
      const action = positional[0];
      // TYPED-CLIENT-SDK: migrated off the untyped request() onto the generated family-group
      // sugar (client.team.xxx(...)) — same compile-time guarantee as queue.* below, less noise.
      if (action === "create") out(await client.team.create({ spec: JSON.parse(flags.get("spec") ?? "{}") }));
      else if (action === "list") out(await client.team.list({}));
      else if (action === "status") out(await client.team.status({ name: positional[1]! }));
      else if (action === "dissolve") out(await client.team.dissolve({ name: positional[1]! }));
      else {
        console.error("usage: chimera team <create --spec <json> | list | status <name> | dissolve <name>>");
        client.close(); process.exit(1);
      }
      break;
    }
    case "queue": {
      const action = positional[0];
      // TYPED-CLIENT-SDK: migrated from the FEATURE-8 client.call("queue.xxx", ...)
      // proof-of-concept onto the generated family-group sugar (client.queue.xxx(...)) — same
      // compile-time guarantee (a malformed request here is a compile error, not something that
      // only surfaces at the daemon), less call-site noise.
      if (action === "create") {
        const spec = flags.has("spec")
          ? JSON.parse(flags.get("spec")!)
          : { name: flags.get("name")!, ...(flags.has("retry-limit") ? { retryLimit: Number(flags.get("retry-limit")) } : {}) };
        out(await client.queue.create({ spec }));
      } else if (action === "list") {
        out(await client.queue.list({}));
      } else if (action === "push") {
        out(await client.queue.push({
          queue: positional[1]!, prompt: flags.get("prompt")!,
          ...(flags.has("priority") ? { priority: Number(flags.get("priority")) } : {}),
          ...(flags.has("role") ? { role: flags.get("role") } : {}),
          ...(flags.has("overrides") ? { overrides: JSON.parse(flags.get("overrides")!) } : {}),
        }));
      } else if (action === "status") out(await client.queue.status({ queue: positional[1]! }));
      else if (action === "cancel") out(await client.queue.cancelTask({ taskId: positional[1]! }));
      else {
        console.error("usage: chimera queue <create --name <n> [--retry-limit N] | list | push <queue> --prompt <p> [--priority N] [--role r] [--overrides <json>] | status <queue> | cancel <taskId>>");
        client.close(); process.exit(1);
      }
      break;
    }
    default:
      console.error(`usage: chimera <doctor|support-report|start|stop|restart|status|spawn|wait|listen|send|answer|kill|hold|release|signal|team|queue> [flags]`);
      process.exit(1);
  }
  client.close();
} catch (e) { client.close(); fail(e); }
