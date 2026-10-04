// Shared CodexAgentBackend test scaffolding — extracted out of codex-backend.test.ts so other
// test files (codex-backend-conformance.test.ts) can reuse the scripted CodexFactory/spec
// builders without importing a .test.ts module for its exports (which would re-register that
// whole file's own describe()/it() blocks as a side effect of the import).
import { AgentSpecSchema } from "@chimera/protocol";
import type { CodexFactory, CodexThreadEvent } from "@chimera/core/backends/codex";
import type { ResolvedAgentSpec } from "@chimera/core/backend";
import type { CodexInput } from "@chimera/core/backends/codex-input";

export function fakeCodex(turnScripts: CodexThreadEvent[][]) {
  const codexCalls: Array<Record<string, unknown>> = [];
  const threads: Array<{ options: Record<string, unknown> | undefined; runs: Array<{ input: CodexInput; turnOptions?: Record<string, unknown> }> }> = [];
  const resumedIds: string[] = [];
  let turn = 0;
  const factory: CodexFactory = (opts) => {
    codexCalls.push(opts as Record<string, unknown>);
    return {
      startThread(options) {
        const rec = { options, runs: [] as Array<{ input: CodexInput; turnOptions?: Record<string, unknown> }> };
        threads.push(rec);
        return {
          id: "th-1",
          // W2-1 STRUCTURED-RETURNS: capture the FULL turnOptions (not just signal) so tests can
          // assert outputSchema was forwarded — `o` used to be narrowed to {signal} only.
          async runStreamed(input: CodexInput, o?: { signal?: AbortSignal; outputSchema?: unknown }) {
            rec.runs.push({ input, turnOptions: o as Record<string, unknown> | undefined });
            const script = turnScripts[turn++] ?? [];
            return {
              events: (async function* () {
                for (const e of script) {
                  if (o?.signal?.aborted) throw new Error("aborted");
                  yield e;
                }
                if ((script as CodexThreadEvent[] & { hang?: boolean }).hang) {
                  if (o?.signal?.aborted) throw new Error("aborted");
                  await new Promise<never>((_, rej) =>
                    o?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
                }
              })(),
            };
          },
        };
      },
      resumeThread(id, options) {
        resumedIds.push(id);
        return this.startThread(options);
      },
    };
  };
  return { factory, codexCalls, threads, resumedIds };
}

export function cxSpec(over: Record<string, unknown> = {}): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none", provider: "codex", ...over, providerOptions: { codexTransport: "exec", ...(over.providerOptions as Record<string, unknown> ?? {}) } }),
    agentId: "cx-1", accountName: "cx-main", resolvedProvider: "codex",
    env: { OPENAI_API_KEY: "sk-test", CODEX_HOME: "/tmp/codex-home-a", CHIMERA_AGENT_ID: "cx-1", CHIMERA_DEPTH: "0" },
    depth: 0,
  } as ResolvedAgentSpec;
}

export const settle = () => new Promise((r) => setTimeout(r, 30));
