import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { ResolvedAgentSpec } from "@chimera/core/backend";
import { ModelListCache, installModelListCache, cachedProviderModels } from "@chimera/core/providers/model-list-cache";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SDK-MODEL-LISTS: a real Query object exposes supportedModels() (awaits the SAME
// initialize handshake that produced the system/init message) — this fake mirrors that
// surface so ClaudeAgentBackend's opportunistic cache-populate on system/init is exercised
// without a real CLI subprocess.
function fakeQueryWithModels(messages: Array<Record<string, unknown>>, models: unknown[]) {
  const fn = (() => ({
    async *[Symbol.asyncIterator]() { for (const m of messages) yield m; },
    interrupt: vi.fn(async () => {}),
    supportedModels: vi.fn(async () => models),
  })) as never;
  return fn;
}

function spec(): ResolvedAgentSpec {
  return {
    ...AgentSpecSchema.parse({ prompt: "task", cwd: "/tmp/repo", isolation: "none" }),
    agentId: "ag-1", accountName: "main", resolvedProvider: "claude",
    env: { CHIMERA_AGENT_ID: "ag-1", CHIMERA_DEPTH: "0" }, depth: 0,
  } as ResolvedAgentSpec;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("ClaudeAgentBackend: SDK-MODEL-LISTS cache populate", () => {
  // DYNAMIC-MODEL-LISTS: the backend records into the module-installed shared cache (it has no
  // Engine reference); a fresh temp-dir cache per test keeps the on-disk file out of the way and
  // stops one test's models leaking into the next.
  beforeEach(() => {
    installModelListCache(new ModelListCache(mkdtempSync(join(tmpdir(), "chimera-mlc-"))));
  });

  it("caches supportedModels() on system/init, mapped to {value,displayName,description}", async () => {
    const fn = fakeQueryWithModels(
      [{ type: "system", subtype: "init", session_id: "s1", model: "m1" }],
      [
        { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "fast" },
        { value: "opus", resolvedModel: "claude-opus-4-8", displayName: "Opus" },
      ],
    );
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), () => {}, async () => true);
    await settle();
    expect(cachedProviderModels("claude")).toEqual([
      { value: "claude-sonnet-5", displayName: "Sonnet", description: "fast" },
      { value: "opus", displayName: "Opus" },
    ]);
  });

  it("never throws / breaks the turn when the queryFn stub doesn't implement supportedModels", async () => {
    const fn = ((): unknown => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "s1", model: "m1" };
        yield { type: "result", subtype: "success", result: "ok", total_cost_usd: 0 };
      },
      interrupt: vi.fn(async () => {}),
      // no supportedModels — mirrors every pre-existing test fake in claude-backend.test.ts
    })) as never;
    const evs: Array<{ kind: string }> = [];
    new ClaudeAgentBackend({ queryFn: fn }).spawn(spec(), (e) => evs.push(e as { kind: string }), async () => true);
    await settle();
    expect(evs.map((e) => e.kind)).toEqual(["agent_started", "turn_complete", "result"]);
  });
});
