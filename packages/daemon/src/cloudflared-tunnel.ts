import { spawn as nodeSpawn } from "node:child_process";

export type TunnelRunSpawnFn = (cmd: string, args: string[], env: Record<string, string>) =>
  { on(ev: "exit", cb: (code: number | null) => void): void; kill(): void };

const defaultSpawn: TunnelRunSpawnFn = (cmd, args, env) => {
  const child = nodeSpawn(cmd, args, { stdio: "ignore", env: { ...process.env, ...env } });
  let exitCb: ((code: number | null) => void) | null = null;
  let settled = false;
  const fireOnce = (code: number | null) => {
    if (settled) return;                 // spawn-level "error" and a later "exit" must not double-fire the respawn
    settled = true;
    exitCb?.(code);
  };
  // Same rationale as ssh-tunnel.ts's defaultSpawn: a spawn-level failure emits "error" and
  // never "exit" — without this listener the daemon crashes on a missing/broken cloudflared.
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

/** Supervises `cloudflared tunnel run --token-from-env` (spec §4). Mirrors SshTunnelSupervisor's
 *  shape verbatim. Never used by tests with a real cloudflared binary. */
export class CloudflaredTunnelSupervisor {
  private child: ReturnType<TunnelRunSpawnFn> | null = null;
  private stopped = false;
  private backoffMs: number;
  private childStartedAt = 0;

  constructor(private opts: { tunnelToken: string; backoffBaseMs?: number; stableMs?: number; spawnFn?: TunnelRunSpawnFn }) {
    this.backoffMs = opts.backoffBaseMs ?? 1000;
  }

  buildArgs(): string[] {
    return ["tunnel", "run", "--token-from-env"];
  }

  start(): void {
    if (this.stopped || this.child) return;
    const spawnFn = this.opts.spawnFn ?? defaultSpawn;
    // TUNNEL_TOKEN rides env, never argv — same discipline as the tailscale authkey.
    this.child = spawnFn("cloudflared", this.buildArgs(), { TUNNEL_TOKEN: this.opts.tunnelToken });
    this.childStartedAt = Date.now();
    this.child.on("exit", () => {
      this.child = null;
      if (this.stopped) return;
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
