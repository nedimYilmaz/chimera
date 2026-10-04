import { afterEach, describe, expect, it } from "vitest";
import { Codex } from "@openai/codex-sdk";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as zlib from "node:zlib";
import {
  CodexAgentBackend,
  type CodexFactory,
  type CodexLike,
} from "@chimera/core/backends/codex";
import type { BackendEvent, ResolvedAgentSpec } from "@chimera/core/backend";
import { cxSpec } from "./codex-backend-helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-three-tools.mjs", import.meta.url));
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  // The codex SDK's internal process can still be flushing shutdown writes (rollout/session
  // files) into CODEX_HOME for a brief window after spawn()'s terminal event fires — under load
  // that races this rmSync into ENOTEMPTY. recursive rmSync's built-in retry absorbs that window.
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function decodeRequestBody(chunks: Buffer[], encoding: string | undefined): Record<string, unknown> {
  const body = Buffer.concat(chunks);
  const decoded = encoding?.split(",").some((part) => part.trim().toLowerCase() === "zstd")
    ? (zlib as typeof zlib & { zstdDecompressSync(input: Buffer): Buffer }).zstdDecompressSync(body)
    : body;
  return JSON.parse(decoded.toString("utf8")) as Record<string, unknown>;
}

async function captureServer(usageAfterSearch = 1): Promise<{
  baseUrl: string;
  requests: Record<string, unknown>[];
  compactions: Record<string, unknown>[];
}> {
  const requests: Record<string, unknown>[] = [];
  const compactions: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      const body = decodeRequestBody(chunks, req.headers["content-encoding"]);
      if (req.url?.endsWith("/compact")) {
        compactions.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "compact-test", object: "response.compaction", output: [{ type: "compaction", encrypted_content: "test-opaque-compaction" }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
        return;
      }
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const first = usageAfterSearch > 1 ? requests.length === 1 : requests.length % 2 === 1;
      const responseId = `resp-${requests.length}`;
      const output = first
        ? 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"tool_search_call","call_id":"search-1","execution":"client","arguments":{"query":"capture probe","limit":8}}}'
        : 'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","id":"msg-1","content":[{"type":"output_text","text":"done"}]}}';
      res.end([
        `event: response.created\ndata: {"type":"response.created","response":{"id":"${responseId}"}}`,
        output,
        `event: response.completed\ndata: {"type":"response.completed","response":{"id":"${responseId}","usage":{"input_tokens":${first ? usageAfterSearch : 1},"input_tokens_details":null,"output_tokens":1,"output_tokens_details":null,"total_tokens":${first ? usageAfterSearch + 1 : 2}}}}`,
        "",
      ].join("\n\n"));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, compactions };
}

describe("CodexAgentBackend first-request tool capture", () => {
  it("captures the first request and proves its first discovery exposes only the selected MCP tool", async () => {
    const { baseUrl, requests } = await captureServer();
    const factory: CodexFactory = (options) =>
      new Codex({
        ...options,
        config: {
          ...options.config,
          // The built-in OpenAI provider now always uses Responses-over-WebSocket. A custom
          // Responses provider with supports_websockets:false exercises the identical request
          // builder over hermetic HTTP/SSE, where this test can capture the provider payload.
          model_provider: "capture",
          model_providers: {
            capture: {
              name: "capture",
              base_url: baseUrl,
              env_key: "OPENAI_API_KEY",
              wire_api: "responses",
              supports_websockets: false,
            },
          },
        },
      }) as unknown as CodexLike;
    const runAgent = async (mcpToolAllowlist?: Record<string, string[]>): Promise<void> => {
      const home = mkdtempSync(join(tmpdir(), "chimera-codex-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "chimera-codex-cwd-"));
      tempDirs.push(home, cwd);
      const base = cxSpec({
        cwd,
        // Use a non-Lite model in the bundled catalog; removed models fall back to metadata
        // without tool search and cannot exercise deferred MCP discovery.
        model: "gpt-5.5",
        mcpServers: {
          probe: { command: process.execPath, args: [fixture] },
        },
        ...(mcpToolAllowlist !== undefined ? { mcpToolAllowlist } : {}),
      });
      const spec = {
        ...base,
        env: {
          ...base.env,
          CODEX_HOME: home,
          OPENAI_API_KEY: "sk-capture",
        },
      } as ResolvedAgentSpec;

      const terminal = new Promise<BackendEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Codex first-request capture timed out")), 30_000);
        new CodexAgentBackend({ codexFactory: factory }).spawn(
          spec,
          (event) => {
            if (event.kind === "result" || event.kind === "error") {
              clearTimeout(timer);
              resolve(event);
            }
          },
          async () => true,
        );
      });
      const terminalEvent = await terminal;
      expect(terminalEvent.kind, JSON.stringify(terminalEvent.data)).toBe("result");
    };

    await runAgent();                         // today's config-level behavior
    await runAgent({ probe: ["beta"] });      // narrowed per-agent behavior
    expect(requests).toHaveLength(4);

    // Capture the REAL provider payload produced by the pinned SDK/CLI after MCP initialize +
    // tools/list and enabled_tools filtering. The literal first provider request defers MCP
    // schemas behind tool_search, so it contains only the server source — never concrete names.
    const firstRequest = JSON.stringify(requests[2]);
    expect(firstRequest).toContain('"type":"tool_search"');
    expect(firstRequest).toContain("- probe");
    expect(firstRequest).not.toContain("mcp__probe");
    expect(firstRequest).not.toContain('"name":"alpha"');
    expect(firstRequest).not.toContain('"name":"beta"');
    expect(firstRequest).not.toContain('"name":"gamma"');

    // The first tool_search result is returned to the model in the next provider request of the
    // SAME initial turn. This is the point where a deferred Codex agent can first see concrete
    // MCP schemas, and the capture proves only the per-agent-selected tool is present.
    const firstDiscoveryResult = JSON.stringify(requests[3]);
    expect(firstDiscoveryResult).toContain('"type":"tool_search_output"');
    expect(firstDiscoveryResult).toContain('"name":"mcp__probe"');
    expect(firstDiscoveryResult).toContain('"name":"beta"');
    expect(firstDiscoveryResult).not.toContain('"name":"alpha"');
    expect(firstDiscoveryResult).not.toContain('"name":"gamma"');

    const discoveryOutput = (request: Record<string, unknown>) =>
      (request["input"] as Array<Record<string, unknown>>)
        .find((item) => item["type"] === "tool_search_output");
    const baselineDiscovery = JSON.stringify(discoveryOutput(requests[1]!));
    const narrowedDiscovery = JSON.stringify(discoveryOutput(requests[3]!));
    const baselineBytes = Buffer.byteLength(baselineDiscovery);
    const narrowedBytes = Buffer.byteLength(narrowedDiscovery);
    // baselineBytes/narrowedBytes are the exact tool_search_output payload size the ACTUAL `codex`
    // CLI binary emits for the unfiltered vs. per-agent-narrowed probe tool list. That binary is
    // NOT pinned by this package's @openai/codex-sdk dependency when CHIMERA_CODEX_CLI_PATH is set
    // (see codex.ts's codexPathOverride) — it resolves to whatever `codex` CLI is installed on the
    // host, so these numbers drift with an operator's out-of-band global CLI upgrade, not with a
    // chimera commit. A mismatch (or a missing "- probe" server line entirely) means the host's
    // codex CLI version no longer matches the shape this test was last pinned against; it is not
    // evidence of a code regression here.
    expect({ baselineBytes, narrowedBytes, removedBytes: baselineBytes - narrowedBytes }).toEqual({
      baselineBytes: 712,
      narrowedBytes: 404,
      removedBytes: 308,
    });
  }, 35_000);
});

// A real CLI + local Responses fixture proves that the configured threshold
// actually invokes provider-native compaction, without any external model call.
it("Codex exec auto-compacts at the Chimera configured threshold", async () => {
  const { baseUrl, requests } = await captureServer(120000);
  const home = mkdtempSync(join(tmpdir(), "chimera-compact-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "chimera-compact-cwd-"));
  tempDirs.push(home, cwd);
  const factory: CodexFactory = options => new Codex({ ...options, config: {
    ...options.config, model_provider: "capture",
    model_providers: { capture: { name: "capture", base_url: baseUrl, env_key: "OPENAI_API_KEY", wire_api: "responses", supports_websockets: false } },
  } }) as unknown as CodexLike;
  const spec = cxSpec({ cwd, model: "gpt-5.5", compactionThreshold: 100000, mcpServers: { probe: { command: process.execPath, args: [fixture] } } });
  spec.env = { ...spec.env, CODEX_HOME: home, OPENAI_API_KEY: "sk-capture" };
  const events: BackendEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { handle.kill(); reject(new Error("Compaction capture timed out")); }, 30000);
    const handle = new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => {
      events.push(event);
      if (event.kind === "result" || event.kind === "error") { clearTimeout(timer); resolve(); }
    }, async () => true);
  });
  expect(events.at(-1)?.kind, JSON.stringify(events.at(-1)?.data)).toBe("result");
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(events.filter(event => event.kind === "compaction" && event.data.phase === "end")).toHaveLength(1);
}, 35000);
