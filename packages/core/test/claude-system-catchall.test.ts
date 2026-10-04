import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// NOTHING-SILENTLY-DROPPED: the SDK emits ~40 `system` subtypes; this backend branched on five and
// let every other one fall off the end of the if/else chain, unseen. codex.ts and kimi.ts both
// already had a forward-compatible catch-all; claude.ts was the one that did not.
//
// It matters because of WHICH ones were vanishing: api_retry is how the CLI says it is retrying a
// failed request (without it a retry is indistinguishable from a hang), hook_* is hook execution,
// background_tasks_changed is a backgrounded shell, and error/error_during_execution are errors.

const src = readFileSync(new URL("../src/backends/claude.ts", import.meta.url), "utf8");

describe("claude.ts surfaces every system message", () => {
  it("has a catch-all for unhandled system subtypes", () => {
    expect(src).toContain('} else if (msg.type === "system") {');
    expect(src).toMatch(/sink\(\{ kind: "status", data: \{ sdkEvent:/);
  });

  it("puts it AFTER the specific branches, so the mapped ones keep their own shape", () => {
    const catchAll = src.indexOf('} else if (msg.type === "system") {');
    for (const specific of ["init", "commands_changed", "local_command_output", "compact_boundary"]) {
      const idx = src.indexOf(`msg.subtype === "${specific}"`);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(catchAll);
    }
  });

  it("carries the raw payload, so a subtype nobody has mapped yet is still inspectable", () => {
    const tail = src.slice(src.indexOf('} else if (msg.type === "system") {'));
    expect(tail.slice(0, 1400)).toContain("raw");
  });

  it("matches the discipline the other backends already had — each ends its dispatch with a pass-through", () => {
    // codex.ts: a `default:` returning status{itemType}. kimi.ts: the same, named a
    // "Forward-compatible catch-all". Both keep an unrecognised event visible instead of dropping
    // it; this backend was the only one that dropped.
    const codex = readFileSync(new URL("../src/backends/codex.ts", import.meta.url), "utf8");
    expect(codex).toMatch(/default:\s*\n\s*return \{ kind: "status", data: \{ itemType/);
    const kimi = readFileSync(new URL("../src/backends/kimi.ts", import.meta.url), "utf8");
    expect(kimi).toMatch(/Forward-compatible catch-all/);
  });
});
