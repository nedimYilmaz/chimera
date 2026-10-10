import { Codex } from "@openai/codex-sdk";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { CodexAppServer } from "@chimera/core/backends/codex-app-server";
import { CodexRpc, codexConfigArgs } from "@chimera/core/backends/codex-rpc";
import { resolveCodexBinary } from "@chimera/core/providers/codex-cli-models";

// Real exec → app-server migration, isolated credentials and loopback inference.
it.skipIf(process.env.CHIMERA_CODEX_APP_SERVER_LOCAL !== "1")("preserves exec history when resuming a rollout with a >16 MiB transcript", async () => {
  const home = mkdtempSync(join(tmpdir(), "chimera-resume-history-"));
  const inputs: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) { res.writeHead(404); res.end(); return; }
    const body = Buffer.concat(chunks);
    inputs.push(JSON.parse((req.headers["content-encoding"]?.includes("zstd") ? zstdDecompressSync(body) : body).toString()).input);
    const output = { type: "message", role: "assistant", id: "msg_fixture", content: [{ type: "output_text", text: "HISTORY_REPLY_SENTINEL" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      { type: "response.created", response: { id: "resp_fixture" } },
      { type: "response.output_item.done", item: output },
      { type: "response.completed", response: { id: "resp_fixture", output: [output], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/KEY|TOKEN|SECRET|CODEX|CHIMERA/.test(key))) as Record<string, string>;
  Object.assign(env, { CODEX_HOME: home, OPENAI_API_KEY: "local-only-key" });
  const binary = resolveCodexBinary(env);
  const config = {
    model_provider: "fixture", check_for_update_on_startup: false,
    model_providers: { fixture: { name: "fixture", base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, env_key: "OPENAI_API_KEY", wire_api: "responses", supports_websockets: false } },
  };
  let client: CodexAppServer | undefined;
  let probe: CodexRpc | undefined;
  try {
    const sdk = new Codex({ codexPathOverride: binary, env, config });
    const old = sdk.startThread({ model: "gpt-6.1-sol", workingDirectory: home, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never" });
    await old.run("HISTORY_USER_SENTINEL. Reply without tools.");
    expect(old.id).toBeTruthy();
    const rollout = readdirSync(join(home, "sessions"), { recursive: true }).find(p => String(p).endsWith(`${old.id}.jsonl`));
    expect(rollout).toBeDefined();
    const path = join(home, "sessions", String(rollout));
    let rows: any[] = [];
    await vi.waitFor(() => {
      rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows.some(row => row.type === "response_item" && row.payload?.role === "assistant")).toBe(true);
    });
    // Inflate only the display event, leaving native model history small and
    // uncompacted so the next inference request can prove exact preservation.
    // Older exec sessions use the legacy transcript reader. Reproduce that
    // format even when the installed CLI now creates paginated sessions.
    rows[0].payload.history_mode = "legacy";
    const display = rows.find(row => row.type === "event_msg" && row.payload?.type === "agent_message");
    if (display) display.payload.message = "x".repeat(17 * 1024 * 1024);
    else rows.splice(rows.findIndex(row => row.payload?.type === "task_complete"), 0, { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "agent_message", message: "x".repeat(17 * 1024 * 1024), phase: "final_answer" } });
    for (const row of rows) delete row.ordinal;
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");

    probe = new CodexRpc(binary, ["app-server", "--listen", "stdio://", ...codexConfigArgs(config)], env);
    await probe.request("initialize", { clientInfo: { name: "chimera-resume-test", version: "1" } });
    probe.notify("initialized");
    await expect(probe.request("thread/resume", { threadId: old.id })).rejects.toThrow("JSONL frame exceeded 16 MiB");
    probe.close();

    client = new CodexAppServer({ codexPathOverride: binary, env, config }, async () => false);
    const resumed = client.resumeThread(old.id!, { model: "gpt-6.1-sol", workingDirectory: home, sandboxMode: "read-only", approvalPolicy: "never", requireResume: true });
    const { events } = await resumed.runStreamed("FOLLOWUP_SENTINEL. Continue without tools.", { signal: AbortSignal.timeout(20_000) });
    const received = []; for await (const event of events) received.push(event);
    expect(resumed.id).toBe(old.id);
    expect(received.some(e => e.type === "turn.completed")).toBe(true);
    expect(received.some(e => e.type === "thread.resume_fallback")).toBe(false);
    const nextInput = JSON.stringify(inputs.at(-1));
    expect(nextInput).toContain("HISTORY_USER_SENTINEL");
    expect(nextInput).toContain("HISTORY_REPLY_SENTINEL");
    expect(nextInput).toContain("FOLLOWUP_SENTINEL");
  } finally {
    client?.close(); probe?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 60_000);
