// INPROC-CHIMERA-BRIDGE live acceptance: a generic agent's mcp__chimera__memory_add tool_call
// lands a REAL record in a REAL Engine's memory store, with ZERO chimera-mcp child processes
// involved. Prior to INPROC-CHIMERA-BRIDGE this drove a real bin/chimera-mcp.js subprocess
// (which autostarted its own SEPARATE chimerad); that whole subprocess/socket round-trip is
// gone now — GenericAgentBackend's McpHost reaches the SAME Engine this test constructs
// directly via engine.handle(), over an in-process MCP transport (InMemoryTransport). Only
// the CHAT transport is faked (same fetchFn seam as providers-f23-2c-sweep.test.ts's harness
// self-test), so this needs no provider API key and runs by default. Lives under
// packages/daemon/test (not packages/core/test) because it needs @chimera/client's
// ChimeraConfigSchema-adjacent wiring conventions -- see the same historical note this file
// always carried: core itself can't import @chimera/client.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import type { ProviderProfile } from "@chimera/protocol";
import { Engine } from "@chimera/core/engine";
import type { ChimeraEngineHandle } from "@chimera/core/backend";
import { GenericAgentBackend } from "@chimera/core/backends/generic";
import { openAiCompatClient } from "@chimera/core/providers/registry";

// INPROC-CHIMERA-BRIDGE acceptance: the chimera server no longer spawns bin/chimera-mcp.js as
// a stdio child -- assert that directly by replacing StdioClientTransport with a spy for the
// duration of this file. A genuinely external spec.mcpServers entry (untouched code path,
// covered structurally by core/test/generic-mcp.test.ts) would still hit this constructor;
// this test configures none, so it must stay at zero calls throughout.
const stdioTransportSpawns: unknown[] = [];
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/client/stdio.js")>();
  class SpyStdioClientTransport extends actual.StdioClientTransport {
    constructor(...args: ConstructorParameters<typeof actual.StdioClientTransport>) {
      stdioTransportSpawns.push(args);
      super(...args);
    }
  }
  return { ...actual, StdioClientTransport: SpyStdioClientTransport };
});

const LIVE_TIMEOUT_MS = 30_000;

afterEach(() => {
  stdioTransportSpawns.length = 0;
});

describe("INPROC-CHIMERA-BRIDGE live: a generic agent's chimera MCP grant runs in-process", () => {
  it("mcp__chimera__memory_add lands a real record via engine.handle(), with zero chimera-mcp child processes", async () => {
    const sseChunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`;
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      const lines: string[] =
        call === 1
          ? [
              sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mem", type: "function", function: { name: "mcp__chimera__memory_add", arguments: "" } }] }, finish_reason: null }] }),
              sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"MCP-HOST-GENERIC live smoke note","kind":"note","tags":["mcp-host-generic-live"]}' } }] }, finish_reason: null }] }),
              sseChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
              "data: [DONE]\n",
            ]
          : [
              sseChunk({ choices: [{ delta: { content: "noted" }, finish_reason: null }] }),
              sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
              "data: [DONE]\n",
            ];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(lines.join("")));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const mockProfile: ProviderProfile = {
      id: "mock-mcp-host", label: "Mock", kind: "openai-compat",
      baseUrl: "https://mock.internal/v1", defaultModel: "mock-model", models: [],
      // GENERIC-SPAWN-CREDENTIAL: openAiCompatClient reads the key from `profile.envVar`, and the
      // chat client refuses to send an empty bearer rather than letting the provider answer with
      // a confusing 401. A profile declaring authModes ["apiKey"] therefore needs BOTH halves —
      // the var's name here and its value in `env` below — even though this mock transport never
      // reads the header. Without them the spawn fails "no credential resolved" before any MCP
      // call happens, and this test is about the MCP bridge, not about auth.
      envVar: "MOCK_MCP_HOST_KEY",
      authModes: ["apiKey"], capabilities: { tools: true, vision: true, streaming: true },
    };

    // INPROC-CHIMERA-BRIDGE: GenericAgentBackend is constructed BEFORE Engine exists (exactly
    // like daemon/src/main.ts's boot sequence) -- engineBox is the same lazy-accessor pattern,
    // filled the moment Engine is constructed below.
    const engineBox: { current: ChimeraEngineHandle | null } = { current: null };
    const engineAccessor = { get: () => { if (!engineBox.current) throw new Error("engine not ready"); return engineBox.current; } };
    const backends = new Map([[mockProfile.id, new GenericAgentBackend(mockProfile.id, openAiCompatClient(mockProfile, { fetchFn, env: { ...process.env, MOCK_MCP_HOST_KEY: "mock-key" } }), { vision: true }, engineAccessor)]]);

    const home = mkdtempSync(join(tmpdir(), "chimera-inproc-mcp-live-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "chimera-inproc-mcp-live-cwd-"));
    const cfg = ChimeraConfigSchema.parse({
      accounts: [{ name: mockProfile.id, provider: mockProfile.id, auth: { type: "subscription" } }],
      autoOrder: [mockProfile.id],
      caps: { maxAgentsTotal: 1, perAccount: {} },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg, null, 2));

    const engine = new Engine({ home, backends });
    engineBox.current = engine;

    const rec = await engine.supervisor.spawn({
      prompt: "note this down via mcp__chimera__memory_add, then reply",
      cwd,
      account: mockProfile.id,
      provider: mockProfile.id,
      isolation: "none",
      permissionProfile: "full",
      maxTurns: 4,
      orchestration: { allow: true, maxDepth: 2 },
    });
    const final = await engine.supervisor.waitFor(rec.agentId, LIVE_TIMEOUT_MS);
    expect(final.state).toBe("done");

    const tail = engine.events.tail(rec.agentId, 500);
    const toolResult = tail.find((e) => e.kind === "tool_result" && (e.data as { toolName?: string })["toolName"] === "mcp__chimera__memory_add");
    expect(toolResult).toBeTruthy();
    expect((toolResult!.data as { isError?: boolean }).isError).toBeUndefined();

    // the SAME Engine instance this test constructed wrote this record in-process (via
    // engine.handle("memory.add", ...)) -- no daemon socket, no subprocess anywhere.
    const memPath = join(home, "memory.json");
    expect(existsSync(memPath)).toBe(true);
    const stored = JSON.parse(readFileSync(memPath, "utf8")) as { records: Array<{ text: string; tags?: string[] }> };
    expect(stored.records.some((r) => r.text === "MCP-HOST-GENERIC live smoke note" && r.tags?.includes("mcp-host-generic-live"))).toBe(true);

    expect(stdioTransportSpawns).toEqual([]);
  }, LIVE_TIMEOUT_MS);
});
