import { expect, it } from "vitest";
import { assertContextWindowSmoke } from "../../../scripts/codex-context-window-smoke-check.mjs";

// Metadata captured by the four real 0.160.0 smokes documented in codex-openai-readiness.md.
const captured = ["gpt-6.1-sol", "gpt-6-astra"].flatMap(model => ["exec", "app-server"].map(transport => ({
  model, effort: "high", transport,
  nativeConfig: { model_context_window: 500000, model_auto_compact_token_limit: 450000 },
  contextLimits: { source: "codex", defaultWindow: 272000, maxWindow: 872000, requestedWindow: 500000, compactAt: 450000, sessionWindow: 475000 },
  effectiveContextLimit: 450000, result: "READY",
})));

it.each(captured)("accepts captured $model/$transport capacity independently of compaction", record => {
  expect(() => assertContextWindowSmoke(record)).not.toThrow();
});

it.each([
  { contextLimits: { requestedWindow: 272000, compactAt: 450000, sessionWindow: 475000 } },
  { contextLimits: { requestedWindow: 500000, compactAt: 500000, sessionWindow: 475000 } },
  { contextLimits: { requestedWindow: 500000, compactAt: 450000, sessionWindow: 258400 } },
  { contextLimits: { requestedWindow: 500000, compactAt: 450000 } },
  { contextLimits: undefined },
  { effectiveContextLimit: 475000 },
  { nativeConfig: {} },
  { result: undefined },
  { result: "not ready" },
  { error: "provider failed" },
])("rejects ignored overrides, missing metadata and incorrect completion (%j)", patch => {
  expect(() => assertContextWindowSmoke({ ...captured[0], ...patch })).toThrow();
});
