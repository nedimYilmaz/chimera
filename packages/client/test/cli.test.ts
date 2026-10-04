import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ChimeraClient } from "@chimera/client";
import { encodeFrame, decodeFrames, type RpcRequest } from "@chimera/protocol";
import { makeEngineHome } from "../../core/test/helpers.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const home = makeEngineHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };

function cli(args: string[], customEnv: NodeJS.ProcessEnv = env): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", CLI, ...args], { env: customEnv }, (err, stdout) =>
      resolve({ stdout, code: err ? (err as { code?: number }).code ?? 1 : 0 }));
  });
}

// ---------- fake daemon for send/signal: the FakeAgentBackend's default
// script (agent_started -> turn_complete -> result) completes essentially
// instantly inside the daemon process, long before a second CLI child
// process (a fresh node + tsx cold start) could ever spawn, connect, and
// race it. agent.send requires the target to still be "running" (spec),
// so racing the real daemon for send/signal would be flaky by construction.
// This minimal fake daemon instead asserts the EXACT wire request the CLI
// sends — the thing cli.ts is actually responsible for — deterministically.
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

afterAll(async () => {
  const c = await ChimeraClient.connect({ home, env, autostart: false }).catch(() => null);
  await c?.request("daemon.stop").catch(() => {});
  c?.close();
});

describe("chimera CLI", () => {
  it("status autostarts the daemon and prints JSON", async () => {
    const { stdout, code } = await cli(["status"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).protocolVersion).toBe(1);
  }, 20_000);

  it("runs as a real executable via the bin/chimera.js launcher under plain node (no --import tsx)", async () => {
    // F1 guard: the OS execs the `bin` shebang as plain `node bin/chimera.js`, with NO tsx
    // loader — the launcher must register tsx itself. Pointing `bin` straight at cli.ts (a
    // .ts file) ERR_MODULE_NOT_FOUNDs on `import "./client.js"`. Note: argv has no --import tsx.
    const LAUNCHER = fileURLToPath(new URL("../bin/chimera.js", import.meta.url));
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve) => {
      execFile(process.execPath, [LAUNCHER, "status"], { env }, (err, out) =>
        resolve({ stdout: out, code: err ? (err as { code?: number }).code ?? 1 : 0 }));
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).protocolVersion).toBe(1);
  }, 20_000);

  it("spawn --wait returns the finished record", async () => {
    const { stdout, code } = await cli(["spawn", "--prompt", "ping", "--cwd", "/tmp", "--isolation", "none", "--wait"]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(rec.state).toBe("done");
    expect(rec.resultText).toBe("fake:ping");
  }, 20_000);

  it("listen exits with the first matching event (the poke channel)", async () => {
    const listening = cli(["listen", "--events", "result", "--timeout", "10000"]);
    await new Promise((r) => setTimeout(r, 500));                       // listener attaches
    await cli(["spawn", "--prompt", "poke me", "--cwd", "/tmp", "--isolation", "none"]);
    const { stdout, code } = await listening;
    expect(code).toBe(0);
    const ev = JSON.parse(stdout);
    expect(ev.kind).toBe("result");
    expect(ev.data.text).toBe("fake:poke me");
  }, 20_000);

  it("listen times out with exit code 2", async () => {
    const { code } = await cli(["listen", "--events", "failover", "--timeout", "300"]);
    expect(code).toBe(2);
  }, 20_000);

  // ---------- additional coverage beyond the brief's four example tests ----------

  it("wait <agentId> resolves with the terminal record (default timeout)", async () => {
    const spawned = await cli(["spawn", "--prompt", "wait-me", "--cwd", "/tmp", "--isolation", "none"]);
    expect(spawned.code).toBe(0);
    const { agentId } = JSON.parse(spawned.stdout) as { agentId: string };
    const { stdout, code } = await cli(["wait", agentId]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(rec.state).toBe("done");
    expect(rec.resultText).toBe("fake:wait-me");
  }, 20_000);

  it("wait <agentId> --timeout <ms> accepts an explicit timeout", async () => {
    const spawned = await cli(["spawn", "--prompt", "wait-me-2", "--cwd", "/tmp", "--isolation", "none"]);
    const { agentId } = JSON.parse(spawned.stdout) as { agentId: string };
    const { stdout, code } = await cli(["wait", agentId, "--timeout", "5000"]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(rec.state).toBe("done");
    expect(rec.resultText).toBe("fake:wait-me-2");
  }, 20_000);

  // KILL-REPORTS-WHAT-HAPPENED: `ok` means the request was accepted; `killed` says whether this
  // call is what ended the agent. They differ exactly when the agent had already finished — the
  // case that used to report a bare {ok:true} and read as "killed" for an agent nothing killed.
  it("kill <agentId> reports whether it actually ended the agent, not merely that the call went through", async () => {
    const spawned = await cli(["spawn", "--prompt", "kill-me", "--cwd", "/tmp", "--isolation", "none"]);
    const { agentId } = JSON.parse(spawned.stdout) as { agentId: string };
    const { stdout, code } = await cli(["kill", agentId]);
    expect(code).toBe(0);
    const res = JSON.parse(stdout) as { ok: boolean; killed: boolean; state: string };
    expect(res.ok).toBe(true);
    // the fake backend's script may already have ended this agent; either way the report is
    // internally consistent — `killed` is true only when the state it left behind is "killed"
    expect(res.killed).toBe(res.state === "killed");
  }, 20_000);

  it("kill on an unknown agentId fails with exit 1 (error path)", async () => {
    const { code } = await cli(["kill", "no-such-agent-ever"]);
    expect(code).toBe(1);
  }, 20_000);

  it("spawn without --wait prints the initial (running) record and forwards account/profile/deliver-to flags", async () => {
    const { stdout, code } = await cli([
      "spawn", "--prompt", "solo", "--cwd", "/tmp",
      "--account", "main", "--profile", "full", "--deliver-to", "nobody-listens",
    ]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(typeof rec.agentId).toBe("string");
    expect(rec.state).toBe("running");
    expect(rec.resultText).toBeUndefined();
  }, 20_000);

  it("spawn --wait placed before other flags still parses, and accepts an explicit --timeout", async () => {
    const { stdout, code } = await cli([
      "spawn", "--wait", "--prompt", "ping2", "--cwd", "/tmp", "--isolation", "none", "--timeout", "5000",
    ]);
    expect(code).toBe(0);
    const rec = JSON.parse(stdout);
    expect(rec.state).toBe("done");
    expect(rec.resultText).toBe("fake:ping2");
  }, 20_000);

  it("listen without --events defaults to kind 'result', and --agent scopes the subscription", async () => {
    const { code } = await cli(["listen", "--agent", "no-such-agent-ever", "--timeout", "300"]);
    expect(code).toBe(2);
  }, 20_000);

  it("send <agentId> <text...> issues agent.send with the joined text", async () => {
    const fake = await startFakeDaemon(() => ({ result: { ok: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(["send", "agent-123", "hello", "world"], fenv);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true });
      const req = fake.requests.find((r) => r.method === "agent.send");
      expect(req?.params).toEqual({ agentId: "agent-123", text: "hello world" });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("send with no text produces an empty string that the daemon rejects (exit 1)", async () => {
    expect.assertions(1);
    const { code } = await cli(["send", "some-agent-id"]);
    expect(code).toBe(1);
  }, 20_000);

  it("signal --agent --kind --text wraps agent.send with from: hook:<kind>", async () => {
    const fake = await startFakeDaemon(() => ({ result: { ok: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(
        ["signal", "--agent", "agent-42", "--kind", "pretooluse", "--text", "blocked: rm -rf"],
        fenv,
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true });
      const req = fake.requests.find((r) => r.method === "agent.send");
      expect(req?.params).toEqual({ agentId: "agent-42", text: "blocked: rm -rf", from: "hook:pretooluse" });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("signal without --kind or --text defaults to hook:unknown and empty text", async () => {
    const fake = await startFakeDaemon(() => ({ result: { ok: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(["signal", "--agent", "agent-99"], fenv);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ ok: true });
      const req = fake.requests.find((r) => r.method === "agent.send");
      expect(req?.params).toEqual({ agentId: "agent-99", text: "", from: "hook:unknown" });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("answer <questionId> --option a --option b --text note issues agent.answerQuestion", async () => {
    const fake = await startFakeDaemon(() => ({ result: { handled: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(
        ["answer", "q-1", "--option", "a", "--option", "b", "--text", "note"], fenv,
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ handled: true });
      const req = fake.requests.find((r) => r.method === "agent.answerQuestion");
      expect(req?.params).toEqual({ questionId: "q-1", answer: { optionIds: ["a", "b"], text: "note" } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("answer <questionId> --text 'just text' sends a free-form answer with no optionIds", async () => {
    const fake = await startFakeDaemon(() => ({ result: { handled: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(["answer", "q-2", "--text", "just text"], fenv);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ handled: true });
      const req = fake.requests.find((r) => r.method === "agent.answerQuestion");
      expect(req?.params).toEqual({ questionId: "q-2", answer: { text: "just text" } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("answer <questionId> --option a sends an option-only answer (no text key)", async () => {
    const fake = await startFakeDaemon(() => ({ result: { handled: false } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(["answer", "q-3", "--option", "a"], fenv);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ handled: false });
      const req = fake.requests.find((r) => r.method === "agent.answerQuestion");
      expect(req?.params).toEqual({ questionId: "q-3", answer: { optionIds: ["a"] } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  // ---------- additional coverage beyond the brief's three example tests ----------

  it("answer <questionId> with neither --option nor --text sends an empty answer object", async () => {
    const fake = await startFakeDaemon(() => ({ result: { handled: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(["answer", "q-4"], fenv);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ handled: true });
      const req = fake.requests.find((r) => r.method === "agent.answerQuestion");
      expect(req?.params).toEqual({ questionId: "q-4", answer: {} });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("answer with a trailing --option (no following token) does not push a dangling entry", async () => {
    // Boundary: rest[i] === "--option" but rest[i+1] is undefined (end of argv) — the
    // scan must check `!== undefined` and skip it, not push `undefined` into optionIds.
    const fake = await startFakeDaemon(() => ({ result: { handled: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(["answer", "q-5", "--option"], fenv);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ handled: true });
      const req = fake.requests.find((r) => r.method === "agent.answerQuestion");
      // The generic flag parser also sees a dangling --option and sets flags.set("option","true"),
      // but that flag is never consulted for the answer verb — only the raw-argv scan feeds optionIds.
      expect(req?.params).toEqual({ questionId: "q-5", answer: {} });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("answer with --option immediately before another flag does not fabricate a bogus optionId", async () => {
    // F1 guard: `--option` followed by another `--flag` (not a value) must contribute
    // nothing, mirroring the top-level parser's `!startsWith("--")` check — otherwise the
    // flag's name is swallowed as a junk optionId that would resolve the question with garbage.
    const fake = await startFakeDaemon(() => ({ result: { handled: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code } = await cli(["answer", "q-6", "--option", "--text", "note"], fenv);
      expect(code).toBe(0);
      const req = fake.requests.find((r) => r.method === "agent.answerQuestion");
      expect(req?.params).toEqual({ questionId: "q-6", answer: { text: "note" } }); // NOT optionIds:["--text"]
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("answer <questionId> --option a --text t --option b accumulates options regardless of interleaving with --text", async () => {
    // Ordering: --option occurrences are collected in argv order even when --text is
    // interleaved between them; --text is read from the flags Map independent of position.
    const fake = await startFakeDaemon(() => ({ result: { handled: true } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { stdout, code } = await cli(
        ["answer", "q-6", "--option", "a", "--text", "t", "--option", "b"], fenv,
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ handled: true });
      const req = fake.requests.find((r) => r.method === "agent.answerQuestion");
      expect(req?.params).toEqual({ questionId: "q-6", answer: { optionIds: ["a", "b"], text: "t" } });
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("answer with a daemon error (unknown questionId) exits 1", async () => {
    expect.assertions(1);
    const fake = await startFakeDaemon(() => ({ error: { code: "not_found", message: "no such question" } }));
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code } = await cli(["answer", "no-such-question", "--text", "x"], fenv);
      expect(code).toBe(1);
    } finally {
      await fake.close();
    }
  }, 20_000);

  it("an unknown command prints usage and exits 1", async () => {
    expect.assertions(2);
    const { stdout, code } = await cli(["bogus-command"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
  }, 20_000);

  it("the usage string lists 'answer' among the recognized verbs", async () => {
    // `answer` is implemented (agent.answerQuestion, tested above) but was missing from
    // the usage string a user sees on `--help`/unknown command — undiscoverable otherwise.
    expect.assertions(2);
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", CLI, "bogus-command"], { env },
        (err, _stdout, stderrOut) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr: stderrOut }));
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/\banswer\b/);
  }, 20_000);

  it("listen surfaces a subscribe failure as a clean error, not a swallowed/unhandled rejection", async () => {
    // A daemon that completes the handshake but REJECTS 'subscribe' must surface the
    // error via fail() as clean JSON on stderr. Without the .catch, the void'd rejection
    // becomes an unhandled-rejection crash — same exit code, but no actionable message.
    // Assert the clean JSON shape (JSON.stringify) which the crash path never prints.
    expect.assertions(2);
    const fake = await startFakeDaemon((req) =>
      req.method === "subscribe" ? { error: { code: "boom", message: "subscribe refused" } } : { result: { ok: true } });
    try {
      const fenv = { ...process.env, CHIMERA_HOME: fake.home };
      const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(process.execPath, ["--import", "tsx", CLI, "listen", "--events", "result", "--timeout", "8000"], { env: fenv },
          (err, _stdout, stderrOut) => resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr: stderrOut }));
      });
      expect(code).toBe(1);
      expect(stderr).toContain('"code":"boom"'); // fail()'s JSON.stringify output; the unhandled-rejection crash prints inspect format instead
    } finally {
      await fake.close();
    }
  }, 20_000);
});
