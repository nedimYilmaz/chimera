import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { PeerConfig } from "@chimera/protocol";
import { SshTunnelSupervisor, type TunnelSpawnFn } from "@chimera/daemon/ssh-tunnel";

// Mocks the node:child_process module (not ssh itself) so the *real* defaultSpawn wiring inside
// ssh-tunnel.ts can be exercised — real ssh(1) is still never executed by anything in this file.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const PEER: PeerConfig = {
  engineId: "studio", publicKey: "PK", socketPath: "/tmp/chimera-test-tunnel.sock",
  ssh: { host: "studio.tail", remoteSocket: ".chimera/federation.sock", identityFile: "~/.ssh/chimera_fed", knownHostsFile: "~/.chimera/known_hosts" },
  allowSpawn: false, accounts: [], maxConcurrent: 4,
};

/** A fake spawnFn that records every spawned "process" and lets the test drive its exit. */
function fakeSpawnFactory() {
  const spawned: Array<{ cmd: string; args: string[]; exit: (code: number | null) => void; killed: boolean }> = [];
  const spawnFn: TunnelSpawnFn = (cmd, args) => {
    const rec = { cmd, args, exit: (_c: number | null) => {}, killed: false };
    spawned.push(rec);
    return { on: (_ev, cb) => { rec.exit = cb; }, kill: () => { rec.killed = true; } };
  };
  return { spawned, spawnFn };
}

describe("SshTunnelSupervisor", () => {
  it("builds the exact hardened ssh argv", () => {
    const sup = new SshTunnelSupervisor({ peer: PEER });
    expect(sup.buildArgs()).toEqual([
      "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=~/.chimera/known_hosts",
      "-i", "~/.ssh/chimera_fed",
      "-L", "/tmp/chimera-test-tunnel.sock:.chimera/federation.sock", "studio.tail",
    ]);
  });

  it("respawns on exit with backoff and stops cleanly — ssh(1) is never really executed", async () => {
    const spawned: Array<{ args: string[]; exit: (code: number) => void; killed: boolean }> = [];
    const spawnFn: TunnelSpawnFn = (cmd, args) => {
      expect(cmd).toBe("ssh");
      const rec = { args, exit: (_c: number) => {}, killed: false };
      spawned.push(rec);
      return { on: (_ev, cb) => { rec.exit = cb as (code: number) => void; }, kill: () => { rec.killed = true; } };
    };
    const sup = new SshTunnelSupervisor({ peer: PEER, backoffBaseMs: 10, spawnFn });
    sup.start();
    expect(spawned.length).toBe(1);
    spawned[0]!.exit(255);                                               // forward failure
    await new Promise((r) => setTimeout(r, 100));
    expect(spawned.length).toBeGreaterThanOrEqual(2);                    // respawned after backoff
    sup.stop();
    const count = spawned.length;
    spawned[count - 1]!.exit(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(spawned.length).toBe(count);                                  // no respawn after stop
    expect(spawned[count - 1]!.killed).toBe(true);
  });

  it("throws in the constructor when the peer has no ssh config", () => {
    const noSsh: PeerConfig = { ...PEER, ssh: undefined };
    expect(() => new SshTunnelSupervisor({ peer: noSsh })).toThrow(/no ssh config/);
  });

  it("omits -o UserKnownHostsFile and -i when identityFile/knownHostsFile are both absent", () => {
    const bare: PeerConfig = { ...PEER, ssh: { host: "studio.tail", remoteSocket: ".chimera/federation.sock" } };
    const sup = new SshTunnelSupervisor({ peer: bare });
    expect(sup.buildArgs()).toEqual([
      "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "-L", "/tmp/chimera-test-tunnel.sock:.chimera/federation.sock", "studio.tail",
    ]);
  });

  it("includes -i without -o UserKnownHostsFile when only identityFile is set", () => {
    const idOnly: PeerConfig = {
      ...PEER, ssh: { host: "studio.tail", remoteSocket: ".chimera/federation.sock", identityFile: "~/.ssh/chimera_fed" },
    };
    const sup = new SshTunnelSupervisor({ peer: idOnly });
    expect(sup.buildArgs()).toEqual([
      "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "-i", "~/.ssh/chimera_fed",
      "-L", "/tmp/chimera-test-tunnel.sock:.chimera/federation.sock", "studio.tail",
    ]);
  });

  it("includes -o UserKnownHostsFile without -i when only knownHostsFile is set", () => {
    const knownOnly: PeerConfig = {
      ...PEER, ssh: { host: "studio.tail", remoteSocket: ".chimera/federation.sock", knownHostsFile: "~/.chimera/known_hosts" },
    };
    const sup = new SshTunnelSupervisor({ peer: knownOnly });
    expect(sup.buildArgs()).toEqual([
      "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=~/.chimera/known_hosts",
      "-L", "/tmp/chimera-test-tunnel.sock:.chimera/federation.sock", "studio.tail",
    ]);
  });

  it("uses the default 1000ms backoff base when backoffBaseMs is not supplied", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? -1);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const sup = new SshTunnelSupervisor({ peer: PEER, spawnFn });
    sup.start();
    spawned[0]!.exit(1);
    expect(delays).toEqual([1000]);                                      // default base, unspecified
    spy.mockRestore();
    sup.stop();
  });

  it("start() is a no-op while a child is already running (single spawn)", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const sup = new SshTunnelSupervisor({ peer: PEER, spawnFn });
    sup.start();
    sup.start();                                                         // second call while child is live
    expect(spawned.length).toBe(1);
    sup.stop();
  });

  it("start() is a no-op after stop() has been called (does not resurrect)", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const sup = new SshTunnelSupervisor({ peer: PEER, spawnFn });
    sup.start();
    sup.stop();
    sup.start();                                                         // must stay stopped
    expect(spawned.length).toBe(1);
  });

  it("stop() before start() (never-started supervisor) does not throw", () => {
    const { spawnFn } = fakeSpawnFactory();
    const sup = new SshTunnelSupervisor({ peer: PEER, spawnFn });
    expect(() => sup.stop()).not.toThrow();
  });

  it("stop() is idempotent when called twice in a row", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const sup = new SshTunnelSupervisor({ peer: PEER, spawnFn });
    sup.start();
    sup.stop();
    expect(() => sup.stop()).not.toThrow();
    expect(spawned[0]!.killed).toBe(true);
  });

  it("unlinks a stale local socket file before spawning (ssh refuses to bind over one)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-tunnel-test-"));
    const socketPath = join(dir, "stale.sock");
    writeFileSync(socketPath, "");                                       // simulate a leftover socket from a dead ssh
    expect(existsSync(socketPath)).toBe(true);
    const stalePeer: PeerConfig = { ...PEER, socketPath };
    const { spawnFn } = fakeSpawnFactory();
    const sup = new SshTunnelSupervisor({ peer: stalePeer, spawnFn });
    sup.start();
    expect(existsSync(socketPath)).toBe(false);                          // unlinked before spawn
    sup.stop();
  });

  it("caps the doubling backoff at 60000ms across successive respawns", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    const delays: number[] = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? -1);
      cb();             // fire immediately — no real waiting, ssh(1) still never runs
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const sup = new SshTunnelSupervisor({ peer: PEER, backoffBaseMs: 40_000, spawnFn });
    sup.start();
    expect(spawned.length).toBe(1);
    spawned[spawned.length - 1]!.exit(1);   // 40000 -> respawn synchronously (mock fires cb immediately)
    expect(delays[0]).toBe(40_000);
    expect(spawned.length).toBe(2);
    spawned[spawned.length - 1]!.exit(1);   // 80000 capped to 60000
    expect(delays[1]).toBe(60_000);
    expect(spawned.length).toBe(3);
    spawned[spawned.length - 1]!.exit(1);   // stays capped at 60000
    expect(delays[2]).toBe(60_000);
    sup.stop();
    spy.mockRestore();
  });

  it("resets backoff to base after the tunnel stays up past stableMs, but keeps doubling on quick flaps", () => {
    const { spawned, spawnFn } = fakeSpawnFactory();
    let now = 1_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const delays: number[] = [];
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? -1);
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const sup = new SshTunnelSupervisor({ peer: PEER, backoffBaseMs: 1000, stableMs: 5000, spawnFn });
    sup.start();                                          // child #1 @ now=0
    spawned[0]!.exit(1);                                  // quick flap (0ms up) -> base delay, backoff doubles to 2000
    expect(delays[0]).toBe(1000);

    now += 6000;                                          // child #2 stayed up 6000ms >= stableMs
    spawned[1]!.exit(1);                                  // stable run -> backoff reset to base before this delay
    expect(delays[1]).toBe(1000);                          // would be 2000 without the reset

    sup.stop();
    dateSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it("defaultSpawn (no injected spawnFn) routes a real spawn-level 'error' into the respawn/backoff path " +
     "instead of crashing the daemon", async () => {
    // Node never emits "exit" when the child could not be spawned at all (missing binary, EACCES, EAGAIN/ENOMEM) —
    // only "error". An EventEmitter with no "error" listener throws synchronously on emit(), which is exactly how
    // this used to crash the daemon. This test drives the real (un-injected) defaultSpawn path via a mocked
    // node:child_process.spawn — no real ssh(1) process is ever created.
    class FakeChild extends EventEmitter {
      kill(): void {}
    }
    const children: FakeChild[] = [];
    vi.mocked(spawn).mockImplementation((() => {
      const c = new FakeChild();
      children.push(c);
      return c;
    }) as unknown as typeof spawn);

    const sup = new SshTunnelSupervisor({ peer: PEER, backoffBaseMs: 5 });   // no spawnFn -> real defaultSpawn
    sup.start();
    expect(children.length).toBe(1);
    expect(() => children[0]!.emit("error", new Error("spawn ssh ENOENT"))).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(children.length).toBeGreaterThanOrEqual(2);                      // backed off and respawned, not crashed
    sup.stop();
  });
});
