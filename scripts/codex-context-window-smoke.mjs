// Run with node --import tsx; opt-in live smoke, never part of the offline test suite.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSpecSchema } from "../packages/protocol/src/index.ts";
import { CodexAgentBackend, buildCodexOptions } from "../packages/core/src/backends/codex.ts";
import { assertContextWindowSmoke } from "./codex-context-window-smoke-check.mjs";

const cwd = mkdtempSync(join(tmpdir(), "chimera-context-smoke-"));
try {
  for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
    for (const transport of ["exec", "app-server"]) {
      const spec = {
        ...AgentSpecSchema.parse({
          cwd, isolation: "none", provider: "codex", model, effort: "high",
          contextWindow: 500000, compactionThreshold: 450000,
          permissionProfile: "readOnly", autonomy: "full",
          prompt: "Reply with exactly READY. Do not use tools or modify files.",
          providerOptions: { codexTransport: transport },
        }),
        agentId: "context-window-smoke", accountName: "local", resolvedProvider: "codex", env: {}, depth: 0,
      };
      let settle;
      const completed = new Promise(resolve => { settle = resolve; });
      const events = [];
      const handle = new CodexAgentBackend().spawn(spec, event => {
        events.push(event);
        if (event.kind === "error" || event.kind === "result") settle();
      }, async () => false);
      const timer = setTimeout(() => settle(), 120000);
      try {
        await completed;
        const error = events.find(e => e.kind === "error");
        const measurement = events.filter(e => e.kind === "usage" && e.data.contextLimits?.sessionWindow).at(-1);
        const started = events.find(e => e.kind === "agent_started");
        const nativeConfig = buildCodexOptions(spec).config;
        const record = {
          model, modelSource: "configured", effort: spec.effort, transport,
          reportedModel: null,
          reportedModelUnavailable: "Normalized start events use the configured model; no serving-model echo is captured.",
          nativeConfig: { model_context_window: nativeConfig.model_context_window, model_auto_compact_token_limit: nativeConfig.model_auto_compact_token_limit },
          sessionId: started?.data.sessionId,
          contextLimits: measurement?.data.contextLimits,
          effectiveContextLimit: measurement?.data.effectiveContextLimit,
          contextUsage: measurement?.data.contextUsage ?? null,
          sessionUsage: measurement?.data.sessionUsage ?? null,
          result: events.find(e => e.kind === "result")?.data.text,
          error: error?.data.message,
        };
        console.log(JSON.stringify(record));
        assertContextWindowSmoke(record);
      } finally {
        clearTimeout(timer);
        await handle.kill();
      }
    }
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
