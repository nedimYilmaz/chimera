import { describe, it, expect, vi } from "vitest";
import { CloudflaredTunnelSupervisor, type TunnelRunSpawnFn } from "@chimera/daemon/cloudflared-tunnel";

/** A fake spawnFn that records every spawned "process" and lets the test drive its exit. */
function fakeSpawnFactory() {
  const spawned: Array<{ cmd: string; args: string[]; env: Record<string, string>; exit: (code: number | null) => void; killed: boolean }> = [];
  const spawnFn: TunnelRunSpawnFn = (cmd, args, env) => {
    const rec = { cmd, args, env, exit: (_c: number | null) => {}, killed: false };
    spawned.push(rec);
    return { on: (_ev, cb) => { rec.exit = cb; }, kill: () => { rec.killed = true; } };
  };
  return { spawned, spawnFn };
}

describe("CloudflaredTunnelSupervisor", () => {
  it("spawns with TUNNEL_TOKEN in env, never in argv", () => {
    const seen: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
    const spawnFn: TunnelRunSpawnFn = (cmd, args, env) => {
      seen.push({ cmd, args, env });
      return { on: () => {}, kill: () => {} };
    };
    const sup = new CloudflaredTunnelSupervisor({ tunnelToken: "SECRET-TOK", spawnFn });
    sup.start();
    expect(seen[0]!.cmd).toBe("cloudflared");
    expect(seen[0]!.args.join(" ")).not.toContain("SECRET-TOK");
    expect(seen[0]!.env["TUNNEL_TOKEN"]).toBe("SECRET-TOK");
    sup.stop();
  });

  it("buildArgs() returns the token-from-env invocation", () => {
    const sup = new CloudflaredTunnelSupervisor({ tunnelToken: "x" });
    expect(sup.buildArgs()).toEqual(["tunnel", "run", "--token-from-env"]);
  });

  it("respawns on exit with backoff doubling capped at 60s, resets after 30s stable uptime", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const delays: number[] = [];
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? -1);
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const sup = new CloudflaredTunnelSupervisor({ tunnelToken: "tok", backoffBaseMs: 1000, stableMs: 5000, spawnFn });
    sup.start();
    spawned[0]!.exit(1); // quick flap -> base delay
    expect(delays[0]).toBe(1000);

    now += 6000; // second child stayed up past stableMs
    spawned[1]!.exit(1);
    expect(delays[1]).toBe(1000); // reset, not doubled

    sup.stop();
    dateSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it("caps the doubling backoff at 60000ms across successive respawns", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? -1);
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const sup = new CloudflaredTunnelSupervisor({ tunnelToken: "tok", backoffBaseMs: 40_000, spawnFn });
    sup.start();
    spawned[spawned.length - 1]!.exit(1);
    expect(delays[0]).toBe(40_000);
    spawned[spawned.length - 1]!.exit(1);
    expect(delays[1]).toBe(60_000);
    sup.stop();
    spy.mockRestore();
  });

  it("stop() suppresses respawn", async () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const sup = new CloudflaredTunnelSupervisor({ tunnelToken: "tok", backoffBaseMs: 10, spawnFn });
    sup.start();
    expect(spawned.length).toBe(1);
    sup.stop();
    const count = spawned.length;
    spawned[count - 1]!.exit(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned.length).toBe(count);
    expect(spawned[count - 1]!.killed).toBe(true);
  });

  it("start() is a no-op while a child is already running", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const sup = new CloudflaredTunnelSupervisor({ tunnelToken: "tok", spawnFn });
    sup.start();
    sup.start();
    expect(spawned.length).toBe(1);
    sup.stop();
  });
});
