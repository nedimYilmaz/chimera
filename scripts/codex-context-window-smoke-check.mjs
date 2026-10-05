import assert from "node:assert/strict";

// Separate from the live runner so captured results can verify the acceptance gate offline.
export function assertContextWindowSmoke(record) {
  const limits = record.contextLimits;
  assert.equal(record.error, undefined, "smoke returned an error");
  assert.equal(record.nativeConfig?.model_context_window, 500000, "native window override missing");
  assert.equal(record.nativeConfig?.model_auto_compact_token_limit, 450000, "native compact target missing");
  assert.equal(limits?.requestedWindow, 500000, "requested window missing or changed");
  assert.equal(limits?.compactAt, 450000, "compact target missing or changed");
  assert.ok(Number.isSafeInteger(limits?.sessionWindow) && limits.sessionWindow > 258400,
    "usable capacity missing or still at the default session window");
  assert.equal(record.effectiveContextLimit, Math.min(limits.compactAt, limits.sessionWindow),
    "effective limit must retain compaction/session minimum semantics");
  assert.equal(record.result?.trim(), "READY", "smoke did not complete with READY");
}
