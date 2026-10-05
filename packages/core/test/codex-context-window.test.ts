import { describe, expect, it, vi } from "vitest";
import { CodexAgentBackend, buildCodexOptions } from "../src/backends/codex.js";
import { cxSpec, fakeCodex } from "./codex-backend-helpers.js";
import type { BackendEvent } from "../src/backend.js";

describe("Codex explicit context window", () => {
  it("selects the native window independently of compaction", () => {
    const spec = { ...cxSpec({ compactionThreshold: 450000 }), contextWindow: 500000 };
    expect(buildCodexOptions(spec).config).toMatchObject({ model_context_window: 500000, model_auto_compact_token_limit: 450000 });
    expect(buildCodexOptions(cxSpec({ compactionThreshold: 500000 })).config).not.toHaveProperty("model_context_window");
    expect(buildCodexOptions(cxSpec({ contextWindow: null })).config).not.toHaveProperty("model_context_window");
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid native windows (%s)", (contextWindow) => {
    expect(() => buildCodexOptions({ ...cxSpec(), contextWindow })).toThrow(/contextWindow/);
  });

  it.each([872001, 500000])("rejects over-max or unknown live capacity before running (%s)", async (contextWindow) => {
    const mock = fakeCodex([[]]);
    const events: BackendEvent[] = [];
    const backend = new CodexAgentBackend({ codexFactory: mock.factory, validateModel: async () => ({ source: "codex", ...(contextWindow === 872001 ? { maxWindow: 872000 } : {}) }) });
    backend.spawn({ ...cxSpec(), contextWindow }, e => events.push(e), async () => true);
    await vi.waitFor(() => expect(events.some(e => e.kind === "error")).toBe(true));
    expect(events.some(e => e.kind === "result")).toBe(false);
    expect(events.some(e => e.kind === "error" && /contextWindow/.test(String(e.data.message)))).toBe(true);
    expect(mock.threads[0]?.runs).toHaveLength(0);
  });
});
