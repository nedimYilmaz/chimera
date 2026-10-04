import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "@chimera/core/backends/codex-app-server";
import { CodexRpc, codexConfigArgs } from "@chimera/core/backends/codex-rpc";
import { buildCodexOptions } from "@chimera/core/backends/codex";
import { resolveCodexBinary } from "@chimera/core/providers/codex-cli-models";
import { cxSpec } from "./codex-backend-helpers.js";

// Real installed CLI, but a loopback model stub: no paid calls or real credentials.
it.skipIf(process.env.CHIMERA_CODEX_APP_SERVER_LOCAL !== "1")("real CLI recovers a missing rollout, authenticates locally and completes a turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "chimera-codex-rpc-"));
  const previousAuth = '{"OPENAI_API_KEY":"previous-local-key"}';
  writeFileSync(join(home, "auth.json"), previousAuth, { mode: 0o600 });
  const auth: Array<string | undefined> = [];
  const voiceHeaders: Array<string | string[] | undefined> = [];
  let compactionRequests = 0;
  let compacting = false;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url?.includes("responses/compact")) {
      compactionRequests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "cmp_local", object: "response.compaction", output: [{ type: "compaction", encrypted_content: "local-only-compacted-context" }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }));
      return;
    }
    if (req.url?.includes("realtime")) {
      voiceHeaders.push(req.headers["openai-alpha"]);
      // Exercise the real CLI's outgoing HTTP header, not just acceptance of the
      // JSON-RPC request. No live SDP answer or audio connection is simulated.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "local voice header verified" } }));
      return;
    }
    if (!req.url?.includes("responses")) { res.writeHead(404); res.end(); return; }
    auth.push(req.headers.authorization);
    const output = compacting ? { type: "compaction", id: "cmp_local", encrypted_content: "local-only-compacted-context" } : { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "local-ok", annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress", content: [] } },
      ...(!compacting ? [{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "local-ok" }] : []),
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { id: "resp_1", status: "completed", output: [output], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/KEY|TOKEN|SECRET|CODEX_HOME|CHIMERA_AGENT/.test(key))) as Record<string, string>;
  // Even an account-wide enable must not opt ordinary Chimera agents in.
  const globalConfig = "[features]\nrealtime_conversation = true\n";
  writeFileSync(join(home, "config.toml"), globalConfig);
  const localConfig = { openai_base_url: `http://127.0.0.1:${port}/v1`, experimental_realtime_webrtc_call_base_url: `http://127.0.0.1:${port}/realtime/calls`, experimental_realtime_ws_base_url: `ws://127.0.0.1:${port}/realtime`, mcp_servers: {}, check_for_update_on_startup: false };
  const client = new CodexAppServer({ apiKey: "local-only-key", env: { ...env, CODEX_HOME: home }, config: localConfig }, async () => false);
  try {
    const thread = client.resumeThread("00000000-0000-4000-8000-000000000000", { model: "gpt-6-astra", workingDirectory: home, sandboxMode: "read-only", approvalPolicy: "never" });
    const { events } = await thread.runStreamed("Say local-ok without using tools.", { signal: AbortSignal.timeout(20_000) });
    const received = []; for await (const event of events) received.push(event);
    expect(received).toContainEqual(expect.objectContaining({ type: "thread.resume_fallback", previousThreadId: "00000000-0000-4000-8000-000000000000" }));
    expect(thread.id).not.toBe("00000000-0000-4000-8000-000000000000");
    expect(received.some((event) => event.type === "turn.completed")).toBe(true);
    expect(received.some((event) => event.type === "turn.failed")).toBe(false);
    // The CLI may attempt WebSocket negotiation before falling back to SSE.
    expect(auth.length).toBeGreaterThan(0);
    expect(new Set(auth)).toEqual(new Set(["Bearer local-only-key"]));
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(previousAuth);
    // CLI 0.157 accepts realtime RPCs even when the feature flag is false.
    // Chimera must enforce the per-agent opt-in before issuing that request.
    await expect(client.nativeVoice.start("v=0\r\n", () => {})).rejects.toThrow("Enable native voice");
    expect(voiceHeaders).toEqual([]);
    const threadId = thread.id;
    const compactionEvents: any[] = [];
    client.onBackgroundEvent = e => compactionEvents.push(e);
    compacting = true;
    expect(await client.compact()).toMatchObject({ ok: true, command: "thread/compact/start" });
    await vi.waitFor(() => expect(compactionEvents, JSON.stringify(compactionEvents)).toContainEqual(expect.objectContaining({ type: "item.completed", item: expect.objectContaining({ type: "contextCompaction" }) })), { timeout: 15_000 });
    // API-key accounts may use ordinary Responses for compaction; native remote
    // compaction uses responses/compact. Both endpoints are local in this fixture.
    expect(compactionRequests).toBeLessThanOrEqual(1);
    compacting = false;
    client.close();
    // Same saved thread, fresh processes, same account: the only difference is
    // the per-agent opt-in. No real voice endpoint, credentials or microphone.
    for (const enabled of [false, true]) {
      const options = buildCodexOptions(cxSpec({ providerOptions: { codexTransport: "app-server", codexRealtime: enabled } }));
      const rpc = new CodexRpc(resolveCodexBinary(env), ["app-server", "--listen", "stdio://", ...codexConfigArgs({ ...options.config, ...localConfig, cli_auth_credentials_store: "ephemeral" })], { ...env, CODEX_HOME: home });
      try {
        await rpc.request("initialize", { clientInfo: { name: "chimera-local-test", version: "0.1.0" }, capabilities: { experimentalApi: true } });
        rpc.notify("initialized");
        await rpc.request("account/login/start", { type: "apiKey", apiKey: "local-only-key" });
        const resumed = await rpc.request("thread/resume", { threadId, model: "gpt-6-astra", cwd: home, approvalPolicy: "never", sandbox: "read-only", config: { "features.realtime_conversation": options.config!["features.realtime_conversation"] } });
        expect(resumed.thread.id).toBe(threadId);
        expect(JSON.stringify(resumed.thread.turns)).toContain("local-ok");
        if (!enabled) continue;
        const start = rpc.request("thread/realtime/start", { threadId, outputModality: "audio", transport: { type: "webrtc", sdp: "v=0\r\n" }, includeStartupContext: true, clientManagedHandoffs: false });
        await expect(start).resolves.toBeDefined();
        await vi.waitFor(() => expect(voiceHeaders.length).toBeGreaterThan(0), { timeout: 10000 });
        await rpc.request("thread/realtime/stop", { threadId });
      } finally { rpc.close(); }
    }
    voiceHeaders.length = 0;
    const voiceClient = new CodexAppServer({ apiKey: "local-only-key", env: { ...env, CODEX_HOME: home }, config: { ...localConfig, "features.realtime_conversation": true } }, async () => false);
    try {
      voiceClient.resumeThread(threadId!, { model: "gpt-6-astra", workingDirectory: home, sandboxMode: "read-only", approvalPolicy: "never" });
      // The expected local rejection must propagate, never turn into a misleading
      // SDP timeout. Its HTTP request must carry the V2 alpha negotiated by V3.
      await expect(voiceClient.nativeVoice.start("v=0\r\n", () => {})).rejects.toThrow("local voice header verified");
      await vi.waitFor(() => expect(voiceHeaders).toEqual(["quicksilver=v2"]));
    } finally { voiceClient.close(); }
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(globalConfig);
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(previousAuth);
  } finally {
    client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Only this test's freshly allocated fixture directory is removed.
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
