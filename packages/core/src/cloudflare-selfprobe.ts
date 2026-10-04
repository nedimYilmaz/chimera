import { spawn } from "node:child_process";

// Spec §3: the mandatory two-directional Cloudflare Access selfprobe — a completion
// condition, not a verification step. Provisioning is not done until a connection WITH the
// service token succeeds AND one WITHOUT it is refused. The negative probe is the
// load-bearing half: it's the only runtime proof the hostname isn't open to the world.
//
// UNVERIFIED (spec §3/§4, do not upgrade to an assertion): whether the edge validates the
// Access JWT before forwarding bytes on this non-HTTP (raw SSH) connection — mitigated by
// this being a runtime proof rather than a docs claim. Also UNVERIFIED: `cloudflared access
// ssh`'s service-token flags/env (source-only, known 2026.6.0 regression).

export type ProbeFn = (opts: {
  hostname: string;
  withToken: { clientId: string; clientSecret: string } | null;
  timeoutMs: number;
}) => Promise<{ sawSshBanner: boolean }>;

const SSH_BANNER_RE = /^SSH-2\.0-/;

/** Spawns `cloudflared access ssh --hostname <hostname>` and reads stdout for the SSH banner.
 *  CF_ACCESS_CLIENT_* env is injected ONLY when withToken is set — never in argv (D0). */
export const realCloudflareAccessProbe: ProbeFn = ({ hostname, withToken, timeoutMs }) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (withToken) {
      env.CF_ACCESS_CLIENT_ID = withToken.clientId;
      env.CF_ACCESS_CLIENT_SECRET = withToken.clientSecret;
    }
    const child = spawn("cloudflared", ["access", "ssh", "--hostname", hostname], { env, stdio: ["ignore", "pipe", "ignore"] });
    let sawSshBanner = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve({ sawSshBanner });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (SSH_BANNER_RE.test(chunk.toString("utf8"))) {
        sawSshBanner = true;
        finish();
      }
    });
    child.on("error", finish);
    child.on("exit", finish);
    const timer = setTimeout(finish, timeoutMs);
  });

export async function selfprobeCloudflareTunnel(opts: {
  hostname: string;
  clientId: string;
  clientSecret: string;
  probe?: ProbeFn;
  retryWindowMs?: number;
  retryIntervalMs?: number;
}): Promise<"passed" | "failed"> {
  const probe = opts.probe ?? realCloudflareAccessProbe;
  const retryWindowMs = opts.retryWindowMs ?? 120_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 5_000;
  const probeTimeoutMs = 10_000;
  const deadline = Date.now() + retryWindowMs;

  while (true) {
    const positive = await probe({
      hostname: opts.hostname,
      withToken: { clientId: opts.clientId, clientSecret: opts.clientSecret },
      timeoutMs: probeTimeoutMs,
    });
    const negative = await probe({ hostname: opts.hostname, withToken: null, timeoutMs: probeTimeoutMs });

    // Same-round requirement: a stale negative pass from an earlier round must not count once
    // the positive only just started passing.
    if (positive.sawSshBanner && !negative.sawSshBanner) return "passed";

    if (Date.now() >= deadline) return "failed";
    await new Promise((r) => setTimeout(r, retryIntervalMs));
  }
}
