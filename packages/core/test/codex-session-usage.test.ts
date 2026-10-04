import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionUsage, codexUsage, codexUsageDelta } from "../src/backends/codex-session-usage.js";
import { usageFromRaw } from "../src/budget.js";
import { CodexAgentBackend } from "../src/backends/codex.js";
import { cxSpec, fakeCodex } from "./codex-backend-helpers.js";
import type { BackendEvent } from "../src/backend.js";
import { vi } from "vitest";

const homes: string[] = [];
const id = "01a0e9d0-ce5d-7b51-8fc8-40797bd8507e";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-")); homes.push(home);
  const dir = join(home, "sessions", "2026", "09", "28"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-test-${id}.jsonl`);
  writeFileSync(path, "");
  return { home, path };
}
const usage = (input: number, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: 595, reasoning_output_tokens: 281 });
function row(input = 109416, total = 2406861) {
  return JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
    last_token_usage: usage(input, 108800), total_token_usage: usage(total, 2293760), model_context_window: 258400,
  } } }) + "\n";
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("Codex exec session measurements", () => {
  it("separates the reported 2.4M session total from the real 109K context", async () => {
    const { home, path } = fixture(); writeFileSync(path, row());
    const sample = await new CodexSessionUsage(home, id).read();
    expect(sample.context?.input_tokens).toBe(109416);
    expect(sample.total?.input_tokens).toBe(2406861);
    expect(sample.window).toBe(258400);
    expect(usageFromRaw(sample.context!)).toEqual({ input: 616, cacheRead: 108800, cacheCreation: 0, output: 595 });
  });
  it("accounts only the growth from a resumed session baseline", () => {
    expect(codexUsageDelta(codexUsage(usage(2406861))!, codexUsage(usage(2297445))!).input_tokens).toBe(109416);
    expect(codexUsageDelta(codexUsage(usage(2406861))!, codexUsage(usage(2406861))!).input_tokens).toBe(0);
  });
  it("emits real context and bills only new usage when exec resumes", async () => {
    const { home, path } = fixture(); writeFileSync(path, row(108917, 2297445));
    const { factory } = fakeCodex([[{ type: "thread.started", thread_id: id }, { type: "turn.completed", thread_id: id, usage: usage(2406861, 2293760) }]]);
    const events: BackendEvent[] = [];
    const spec = cxSpec({ resume: id, compactionThreshold: 500000 });
    spec.env.CODEX_HOME = home;
    new CodexAgentBackend({ codexFactory: factory }).spawn(spec, event => {
      events.push(event);
      if (event.kind === "agent_started") appendFileSync(path, row());
    }, async () => true);
    await vi.waitFor(() => expect(events.some(e => e.kind === "result")).toBe(true));
    const result = events.find(e => e.kind === "result")!;
    expect(result.data.contextUsage).toMatchObject({ input_tokens: 109416 });
    expect(result.data.billableUsage).toMatchObject({ input_tokens: 109416 });
    expect(events.some(e => e.kind === "usage" && e.data.effectiveContextLimit === 258400)).toBe(true);
  });
  it("reads partial appended records once and clears occupancy when compaction completes", async () => {
    const { home, path } = fixture(); writeFileSync(path, row());
    const reader = new CodexSessionUsage(home, id, 0); await reader.read();
    const compact = JSON.stringify({ type: "compacted", timestamp: new Date().toISOString() });
    appendFileSync(path, compact.slice(0, 20));
    expect((await reader.read()).compactions).toBe(0);
    appendFileSync(path, compact.slice(20) + "\n");
    expect(await reader.read()).toMatchObject({ context: null, compactions: 1 });
    expect((await reader.read()).compactions).toBe(0);
    appendFileSync(path, row(12000, 2500000));
    expect((await reader.read()).context?.input_tokens).toBe(12000);
  });
  it("finds a rollout flushed at exit even inside the lookup throttle", async () => {
    const { home, path } = fixture(); rmSync(path);
    const reader = new CodexSessionUsage(home, id);
    expect((await reader.read()).context).toBeNull();
    writeFileSync(path, row());
    expect((await reader.read(true)).context?.input_tokens).toBe(109416);
  });
  it("does not invent context for missing or malformed session files", async () => {
    const { home, path } = fixture(); writeFileSync(path, 'not json "token_count"\n');
    expect((await new CodexSessionUsage(home, id).read()).context).toBeNull();
    expect((await new CodexSessionUsage(home, "../../credentials").read()).context).toBeNull();
  });
  it("does not add cache writes and reasoning to their parent counters twice", () => {
    expect(usageFromRaw({ ...usage(1000, 400), cache_write_input_tokens: 100 })).toEqual({ input: 500, cacheRead: 400, cacheCreation: 100, output: 595 });
  });
});
