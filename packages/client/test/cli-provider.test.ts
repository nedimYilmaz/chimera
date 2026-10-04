import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";
import { encodeFrame, decodeFrames, type RpcRequest } from "@chimera/protocol";
import { makeMultiProviderHome, makeEngineHome } from "../../core/test/helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const home = makeMultiProviderHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };

function cli(args: string[], customEnv: NodeJS.ProcessEnv = env): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", CLI, ...args], { env: customEnv }, (err, stdout) =>
      resolve({ stdout, code: err ? (err as { code?: number }).code ?? 1 : 0 }));
  });
}

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("chimera CLI provider flags", () => {
  it("spawn --provider codex --cross-provider-failover --wait finishes on the codex fake", async () => {
    const { stdout, code } = await cli([
      "spawn", "--prompt", "cli codex", "--cwd", "/tmp", "--isolation", "none",
      "--provider", "codex", "--cross-provider-failover", "--wait",
    ]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(rec.state).toBe("done");
    expect(rec.provider).toBe("codex");
    expect(rec.spec.crossProviderFailover).toBe(true);
    expect(rec.resultText).toBe("fake:cli codex");
  }, 20_000);

  // ---------- additional coverage beyond the brief's one example test ----------

  it("spawn --provider claude --wait routes to claude and leaves crossProviderFailover at its schema default (false)", async () => {
    const { stdout, code } = await cli([
      "spawn", "--prompt", "cli claude", "--cwd", "/tmp", "--isolation", "none",
      "--provider", "claude", "--wait",
    ]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(rec.state).toBe("done");
    expect(rec.provider).toBe("claude");
    expect(rec.spec.crossProviderFailover).toBe(false);
    expect(rec.resultText).toBe("fake:cli claude");
  }, 20_000);

  it("spawn with an unknown --provider value fails the round-trip (AgentSpecSchema rejects it, exit 1)", async () => {
    expect.assertions(1);
    const { code } = await cli([
      "spawn", "--prompt", "bad provider", "--cwd", "/tmp", "--isolation", "none", "--provider", "gpt4",
    ]);
    expect(code).toBe(1);
  }, 20_000);

  // ---------- exact wire-param coverage via a fake daemon (mirrors cli.test.ts's
  // startFakeDaemon rationale: racing the real fake backend's near-instant script
  // gives no way to assert precisely what the CLI put on the wire) ----------

  async function startFakeDaemon(
    respond: (req: RpcRequest) => { result?: unknown; error?: { code: string; message: string } },
  ): Promise<{ home: string; requests: RpcRequest[]; close: () => Promise<void> }> {
    const fakeHome = makeEngineHome();
    const socketPath = join(fakeHome, "daemon.sock");
    const requests: RpcRequest[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          const req = f as RpcRequest;
          if (req.type !== "request") continue;
          if (req.method === "daemon.hello") {
            sock.write(encodeFrame({ id: req.id, type: "response", ok: true, result: { ok: true, protocolVersion: 1 } }));
            continue;
          }
          requests.push(req);
          const r = respond(req);
          sock.write(encodeFrame(r.error
            ? { id: req.id, type: "response", ok: false, error: r.error }
            : { id: req.id, type: "response", ok: true, result: r.result }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    return {
      home: fakeHome,
      requests,
      close: () => new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
    };
  }

  it("spawn without --provider or --cross-provider-failover omits both keys from the wire spec", async () => {
    const fake = await startFakeDaemon(() => ({ result: { agentId: "agent-neither", state: "running" } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code } = await cli(["spawn", "--prompt", "neither", "--cwd", "/tmp"], fenv);
      expect(code).toBe(0);
      const req = fake.requests.find((r) => r.method === "agent.spawn");
      expect(req?.params).toEqual({ spec: { prompt: "neither", cwd: "/tmp" } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("spawn --cross-provider-failover false forwards spec.crossProviderFailover:false (explicit value, not the bare-flag default)", async () => {
    const fake = await startFakeDaemon(() => ({ result: { agentId: "agent-cpf-false", state: "running" } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code } = await cli(
        ["spawn", "--prompt", "cpf-false", "--cwd", "/tmp", "--cross-provider-failover", "false"], fenv,
      );
      expect(code).toBe(0);
      const req = fake.requests.find((r) => r.method === "agent.spawn");
      expect(req?.params).toEqual({ spec: { prompt: "cpf-false", cwd: "/tmp", crossProviderFailover: false } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("spawn --cross-provider-failover true (explicit value) forwards spec.crossProviderFailover:true", async () => {
    const fake = await startFakeDaemon(() => ({ result: { agentId: "agent-cpf-true", state: "running" } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code } = await cli(
        ["spawn", "--prompt", "cpf-true", "--cwd", "/tmp", "--cross-provider-failover", "true"], fenv,
      );
      expect(code).toBe(0);
      const req = fake.requests.find((r) => r.method === "agent.spawn");
      expect(req?.params).toEqual({ spec: { prompt: "cpf-true", cwd: "/tmp", crossProviderFailover: true } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("a bare --cross-provider-failover immediately followed by --provider does not swallow the next flag's name as its value (P1b.4 guard)", async () => {
    // Regression for the raw-argv scan's `!startsWith(\"--\")` guard: a naive flag Map that
    // always consumes rest[i+1] as the value would read spec.crossProviderFailover as the
    // STRING "--provider" (truthy, but not "true" -> would coerce to false) and then treat
    // "codex" as a stray positional, losing --provider entirely.
    const fake = await startFakeDaemon(() => ({ result: { agentId: "agent-gotcha", state: "running" } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code } = await cli(
        ["spawn", "--prompt", "gotcha", "--cwd", "/tmp", "--cross-provider-failover", "--provider", "codex"], fenv,
      );
      expect(code).toBe(0);
      const req = fake.requests.find((r) => r.method === "agent.spawn");
      expect(req?.params).toEqual({ spec: { prompt: "gotcha", cwd: "/tmp", crossProviderFailover: true, provider: "codex" } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("spawn --provider alone (no --cross-provider-failover) forwards only spec.provider", async () => {
    const fake = await startFakeDaemon(() => ({ result: { agentId: "agent-provider-only", state: "running" } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code } = await cli(["spawn", "--prompt", "provider-only", "--cwd", "/tmp", "--provider", "codex"], fenv);
      expect(code).toBe(0);
      const req = fake.requests.find((r) => r.method === "agent.spawn");
      expect(req?.params).toEqual({ spec: { prompt: "provider-only", cwd: "/tmp", provider: "codex" } });
    } finally {
      await fake.close();
    }
  }, 20_000);
});
