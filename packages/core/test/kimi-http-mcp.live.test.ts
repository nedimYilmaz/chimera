import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSpecSchema } from "@chimera/protocol";
import type { ChimeraEngineAccessor, ResolvedAgentSpec } from "../src/backend.js";
import { LoopbackMcpListener } from "../src/mcp-listener.js";
import { KimiAgentBackend, resolveKimiCliPath } from "../src/backends/kimi.js";

// F49 LIVE ACCEPTANCE. The listener is a stateless Streamable-HTTP MCP server; the SDK's own
// Client is NOT proof it works for kimi, whose ACP layer speaks to it with a different client and
// a different request sequence. This is the only test that closes that gap, so it drives the REAL
// CLI. Off by default (needs a kimi install and real model tokens): CHIMERA_LIVE_KIMI=1 to run.
const LIVE = process.env["CHIMERA_LIVE_KIMI"] === "1" && existsSync(resolveKimiCliPath());

type Call = { method: string; params: unknown };

describe.skipIf(!LIVE)("kimi over the loopback http MCP listener (live)", () => {
  it("calls a chimera tool through the granted http endpoint", async () => {
    const calls: Call[] = [];
    const wire: string[] = [];
    const listener = new LoopbackMcpListener({
      enabled: true,
      dispatch: async (method, params) => {
        calls.push({ method, params });
        if (method === "mcpstore.list") return [];
        // A canned answer, not a real engine: the assertion is that the CALL crossed the wire,
        // and a live daemon's memory would make the result unstable anyway.
        if (method === "memory.search") return { results: [{ id: "live-1", title: "f49 live probe", text: "chimera" }] };
        return {};
      },
      createServerImpl: (handler) => http.createServer((req, res) => {
        res.once("finish", () => { wire.push(`${req.method} ${req.url} -> ${res.statusCode}`); });
        handler(req, res);
      }),
    });

    const workdir = mkdtempSync(join(tmpdir(), "kimi-live-"));
    const engine = { get: () => ({ mcpListener: listener }) } as unknown as ChimeraEngineAccessor;
    const backend = new KimiAgentBackend({ engine });
    const spec = {
      ...AgentSpecSchema.parse({
        prompt: "Call the memory_search tool with query 'chimera' and report the result verbatim. Use no other tool.",
        cwd: workdir,
        isolation: "none",
        provider: "kimi",
        orchestration: { allow: true, maxDepth: 1 },
      }),
      agentId: "km-live-1",
      accountName: "km-main",
      resolvedProvider: "kimi",
      env: { CHIMERA_AGENT_ID: "km-live-1", CHIMERA_DEPTH: "0" },
      depth: 0,
    } as ResolvedAgentSpec;

    const handle = backend.spawn(spec, () => {}, async () => true);
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && !calls.some((c) => c.method === "memory.search")) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await handle.kill();
    await listener.close();

    // eslint-disable-next-line no-console -- the HTTP trace IS this test's deliverable
    console.log(`[live] http: ${wire.join(" | ")}\n[live] dispatch: ${calls.map((c) => c.method).join(", ")}`);
    // The operator's ~/.kimi-code/mcp.json may ALSO register a stdio chimera server, so a
    // tool_call event alone would not prove which door was used. This spy only fires for a
    // request that authenticated against the grant minted here.
    expect(calls.map((c) => c.method)).toContain("memory.search");
    expect(wire.some((w) => w.endsWith("-> 200"))).toBe(true);
  }, 180_000);
});
