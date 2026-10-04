import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { CodexAppServer } from "@chimera/core/backends/codex-app-server";

it.skipIf(process.env.CHIMERA_CODEX_APP_SERVER_LOCAL !== "1").each([
  { wired: false, fullAccess: false, approvalPolicy: "on-request" },
  { wired: true, fullAccess: false, approvalPolicy: "on-request" },
  { wired: true, fullAccess: true, approvalPolicy: "on-request" },
  { wired: true, fullAccess: true, approvalPolicy: "never" },
])("installed Codex MCP: wired=$wired full=$fullAccess policy=$approvalPolicy", async ({ wired, fullAccess, approvalPolicy }) => {
  const fixture = mkdtempSync(join(tmpdir(), "chimera-mcp-approval-"));
  let turn = 0;
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
    if (!req.url?.includes("responses")) { res.writeHead(404); res.end(); return; }
    let body = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    if (req.headers["content-encoding"] === "zstd") body = zstdDecompressSync(body);
    const parsed = body.length ? JSON.parse(body.toString()) : {};
    requests.push({ method: req.method, url: req.url, keys: Object.keys(parsed), tools: parsed.tools?.map((t: any) => ({ name: t.name, type: t.type })), input: parsed.input?.slice(-2) });
    const step = turn;
    if (req.method === "POST") turn++;
    const output = step === 0
      ? { type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "call_test", input: "text(await tools.mcp__chimera__chimera_tools({}));", id: "fc_test", status: "completed" }
      : { type: "message", id: "msg_test", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: `resp_${turn}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: `resp_${turn}`, status: "completed", output: [output], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/KEY|TOKEN|SECRET|CODEX_HOME|CHIMERA_/.test(k))) as Record<string, string>;
  const dialogs: unknown[] = [];
  const client = new CodexAppServer({ apiKey: "local-only-key", env: { ...env, CODEX_HOME: fixture }, config: {
    openai_base_url: `http://127.0.0.1:${port}/v1`, check_for_update_on_startup: false,
    mcp_servers: { chimera: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/voice-mcp-server.mjs", import.meta.url))], required: true } },
  } }, async () => true, wired ? async req => { dialogs.push(req.payload); return { behavior: "completed", result: {} }; } : undefined, undefined, true, fullAccess);
  try {
    const thread = client.startThread({ model: "gpt-6-astra", workingDirectory: fixture, sandboxMode: "danger-full-access", approvalPolicy });
    const { events } = await thread.runStreamed("Use the local Chimera tool.", { signal: AbortSignal.timeout(20_000) });
    const received = []; for await (const event of events) received.push(event);
    if (wired) {
      expect(JSON.stringify(received), JSON.stringify({ dialogs, received, requests })).toContain("local-mcp-ok");
      // Under never, this CLI itself accepts empty server forms without asking
      // the host. Under on-request, our full-access bridge skips only Codex's
      // marked execution confirmation; the server's form still reaches UI.
      expect(dialogs).toHaveLength(approvalPolicy === "never" ? 0 : fullAccess ? 1 : 2);
      if (approvalPolicy !== "never") expect(dialogs).toContainEqual(expect.objectContaining({ message: "Approve local tool" }));
      expect(JSON.stringify(received)).not.toContain("user cancelled MCP tool call");
    } else {
      // Reproduce the exact live-log failure from the old full-autonomy wiring.
      expect(JSON.stringify(received)).toContain("user cancelled MCP tool call");
      expect(dialogs).toEqual([]);
    }
  } finally {
    client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    // close() signals the CLI; allow its final session writes to settle.
    rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
