import { describe, it, expect } from "vitest";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { encodeFrame, decodeFrames, type RpcFrame, type RpcResponse } from "@chimera/protocol";
import { startRpcServer } from "@chimera/daemon/server";
import { makeMultiProviderHome } from "../../core/test/helpers.js";

// R2 (unified cache-aware token/ctx/cost metrics) — deterministic full-boot blackbox rig, real
// RPC over the real daemon socket, driven with FakeAgentBackend, mirroring
// self-heal-blackbox.test.ts's own precedent ("the QA gate's requirement that a daemon/
// system-behavior feature ship a test in this style rather than one that reaches into engine
// internals"). NOT using CHIMERA_BACKEND=fake + ChimeraClient (providers.test.ts's pattern):
// that env-var-only wiring gives every spawn the SAME generic zero-usage default scenario
// (main.ts: `new FakeAgentBackend([], p)`), with no way for a test process talking only over
// RPC to inject the specific per-provider raw usage shapes this test needs to drive — the
// in-process Engine + startRpcServer construction is the only way to do that while still
// exercising the real wire protocol end to end (agent.spawn / agent.status / usage.query).
function rpcClient(socketPath: string) {
  const sock = createConnection(socketPath);
  let buf = ""; const waiters: Array<(f: RpcFrame) => void> = []; const inbox: RpcFrame[] = [];
  sock.on("data", (d) => {
    buf += d.toString();
    const { frames, rest } = decodeFrames(buf); buf = rest;
    for (const f of frames) { const w = waiters.shift(); w ? w(f) : inbox.push(f); }
  });
  const next = () => new Promise<RpcFrame>((r) => { const f = inbox.shift(); f ? r(f) : waiters.push(r); });
  let id = 0;
  const request = async (method: string, params: unknown = {}): Promise<RpcResponse> => {
    sock.write(encodeFrame({ id: String(++id), type: "request", method, params }));
    let f = await next();
    while (f.type !== "response") f = await next();
    return f as RpcResponse;
  };
  return { request, end: () => sock.end() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > ms) throw new Error("condition not met before deadline");
    await sleep(20);
  }
}

describe("R2 unified token/ctx/cost metrics: daemon-level blackbox", () => {
  it("a codex-shaped and a claude-shaped result for the SAME conceptual turn normalize to the SAME ledger tokensIn, over the real RPC surface", async () => {
    const home = makeMultiProviderHome();
    const socketPath = join(home, "daemon.sock");

    // Same conceptual turn (60 fresh input tokens, 40 cache-read, 20 output) expressed in each
    // provider's own native raw shape — codex's input_tokens INCLUDES the 40 cached tokens (a
    // subset, verified against OpenAI docs); claude's EXCLUDES them (additive, verified against
    // the Anthropic SDK's Usage type).
    // TOKEN-OPT-P0-1: the terminal result event carries BOTH billableUsage (cumulative,
    // cost-scope — what the ledger's query() sums) and contextUsage (last-turn, ctx-meter
    // scope) — a bare `usage` field is a legacy pre-split shape usage.ts no longer reads.
    // One turn ⇒ both scopes carry the same payload here.
    const claudeBackend = new FakeAgentBackend([[{
      emit: {
        kind: "result",
        data: {
          text: "claude done", costUsd: 0.03,
          billableUsage: { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
          contextUsage: { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
        },
      },
    }]], "claude");
    const codexBackend = new FakeAgentBackend([[{
      emit: {
        kind: "result",
        data: {
          text: "codex done", costUsd: 0.02,
          billableUsage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 0 },
          contextUsage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 0 },
        },
      },
    }]], "codex");
    const engine = new Engine({
      home, backends: new Map<string, AgentBackend>([["claude", claudeBackend], ["codex", codexBackend]]),
    });
    const server = await startRpcServer({ socketPath, engine });
    const c = rpcClient(socketPath);

    const claudeSpawn = await c.request("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none" } });
    const codexSpawn = await c.request("agent.spawn", { spec: { prompt: "x", cwd: "/tmp", isolation: "none", provider: "codex" } });
    const claudeAgentId = (claudeSpawn.result as { agentId: string }).agentId;
    const codexAgentId = (codexSpawn.result as { agentId: string }).agentId;

    await until(
      async () => (await c.request("agent.status", { agentId: claudeAgentId })).result as { state: string },
      (r) => r.state === "done",
    );
    await until(
      async () => (await c.request("agent.status", { agentId: codexAgentId })).result as { state: string },
      (r) => r.state === "done",
    );

    // Wide time range — this rig has no injectable clock (unlike usage.test.ts's fakeEventLog),
    // so query the whole plausible window rather than pin an exact timestamp.
    const q = (await c.request("usage.query", { from: 0, to: Date.now() + 60_000, groupBy: "agent" })).result as {
      groups: Array<{ key: string; tokensIn: number; tokensOut: number; cacheReadTokens: number; costUsd: number }>;
    };
    const claudeRow = q.groups.find((g) => g.key === claudeAgentId);
    const codexRow = q.groups.find((g) => g.key === codexAgentId);
    expect(claudeRow).toBeDefined();
    expect(codexRow).toBeDefined();

    // The core claim: codex's raw input_tokens (100) gets normalized down to the SAME
    // fresh-only tokensIn (60) as claude's already-fresh input_tokens — proving the ledger's
    // own extraction (packages/core/src/usage.ts) was fixed end-to-end over the real RPC
    // surface, not just in the unit test that exercises UsageLedger directly.
    expect(codexRow!.tokensIn).toBe(60);
    expect(claudeRow!.tokensIn).toBe(60);
    expect(codexRow!.tokensIn).toBe(claudeRow!.tokensIn);
    expect(codexRow!.cacheReadTokens).toBe(40);
    expect(claudeRow!.cacheReadTokens).toBe(40);
    expect(codexRow!.tokensOut).toBe(20);
    expect(claudeRow!.tokensOut).toBe(20);
    // both backends' own reported costUsd flow through to the ledger verbatim (no ledger-side
    // cost computation — that's the backend's job, unit-tested separately).
    expect(codexRow!.costUsd).toBeCloseTo(0.02, 10);
    expect(claudeRow!.costUsd).toBeCloseTo(0.03, 10);

    c.end();
    await server.close();
  }, 20_000);
});
