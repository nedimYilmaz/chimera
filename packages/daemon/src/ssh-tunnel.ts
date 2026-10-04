import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import type { PeerConfig } from "@chimera/protocol";

export type TunnelSpawnFn = (cmd: string, args: string[]) =>
  { on(ev: "exit", cb: (code: number | null) => void): void; kill(): void };

const defaultSpawn: TunnelSpawnFn = (cmd, args) => {
  const child = nodeSpawn(cmd, args, { stdio: "ignore" });
  let exitCb: ((code: number | null) => void) | null = null;
  let settled = false;
  const fireOnce = (code: number | null) => {
    if (settled) return;                 // spawn-level "error" and a later "exit" must not double-fire the respawn
    settled = true;
    exitCb?.(code);
  };
  // A spawn-level failure (missing binary, EACCES, EAGAIN/ENOMEM under fork pressure) emits "error" and NEVER "exit"
  // (Node docs: "the exit and close events will not be emitted if the child process could not be spawned"). Without
  // this listener, EventEmitter rethrows "error" as an uncaught exception and crashes the daemon. Route it into the
  // same respawn/backoff path as a normal exit so a bad/missing ssh backs off and reconnects instead.
  child.on("error", () => fireOnce(1));
  return {
    on: (ev, cb) => {
      if (ev === "exit") {
        exitCb = cb;
        child.on("exit", (code) => fireOnce(code));
      }
    },
    kill: () => void child.kill("SIGTERM"),
  };
};

/** Supervises `ssh -N -L <local.sock>:<remote.sock> host` (spec §15 transport). Never used by tests with real ssh. */
export class SshTunnelSupervisor {
  private child: ReturnType<TunnelSpawnFn> | null = null;
  private stopped = false;
  private backoffMs: number;
  private childStartedAt = 0;

  constructor(private opts: { peer: PeerConfig; backoffBaseMs?: number; stableMs?: number; spawnFn?: TunnelSpawnFn }) {
    if (!opts.peer.ssh) throw new Error(`peer "${opts.peer.engineId}" has no ssh config`);
    this.backoffMs = opts.backoffBaseMs ?? 1000;
  }

  buildArgs(): string[] {
    const ssh = this.opts.peer.ssh!;
    return [
      "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      ...(ssh.knownHostsFile ? ["-o", `UserKnownHostsFile=${ssh.knownHostsFile}`] : []),
      ...(ssh.identityFile ? ["-i", ssh.identityFile] : []),
      "-L", `${this.opts.peer.socketPath}:${ssh.remoteSocket}`,
      ssh.host,
    ];
  }

  start(): void {
    if (this.stopped || this.child) return;
    if (existsSync(this.opts.peer.socketPath)) unlinkSync(this.opts.peer.socketPath);   // ssh won't bind over stale
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    this.child = spawnFn("ssh", this.buildArgs());
    this.childStartedAt = Date.now();
    this.child.on("exit", () => {
      this.child = null;
      if (this.stopped) return;
      // A tunnel that stayed up for a while was a real, working connection — the exit that just
      // happened is a fresh disruption, not a continuation of an earlier retry storm. Unlike the
      // doubling below, only reset here (never grow) so a rapid flap right after a stable period
      // doesn't get penalized twice.
      const stableMs = this.opts.stableMs ?? 30_000;
      if (Date.now() - this.childStartedAt >= stableMs) this.backoffMs = this.opts.backoffBaseMs ?? 1000;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      setTimeout(() => this.start(), delay);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }
}
