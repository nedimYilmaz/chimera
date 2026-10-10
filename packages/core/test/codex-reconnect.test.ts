import { describe, expect, it } from "vitest";
import { CodexAgentBackend, normalizeCodexEvent, type CodexThreadEvent } from "@chimera/core/backends/codex";
import type { BackendEvent } from "@chimera/core/backend";
import { cxSpec, fakeCodex } from "./codex-backend-helpers.js";
import { Codex } from "@openai/codex-sdk";
import type { CodexLike } from "@chimera/core/backends/codex";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const notice = "Reconnecting... 2/5 (stream disconnected before completion: IO error: Broken pipe (os error 32))";
const start: CodexThreadEvent = { type: "thread.started", thread_id: "th-1" };
const complete: CodexThreadEvent = { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };

async function run(script: CodexThreadEvent[]) {
  const fake = fakeCodex([script]);
  const events: BackendEvent[] = [];
  const handle = new CodexAgentBackend({ codexFactory: fake.factory }).spawn(
    cxSpec({ resume: "saved-thread" }), event => events.push(event), async () => true,
  );
  try {
    await expect.poll(() => events.some(e => e.kind === "result" || e.kind === "error")).toBe(true);
    return { events, fake };
  } finally { await handle.kill(); }
}

describe("Codex native reconnect notices", () => {
  it("drains the real SDK child through reconnect and process exit without a second launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "chimera-reconnect-"));
    const executable = join(root, "fake-codex.cjs");
    const launched = join(root, "launches");
    writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launched)}, "launch\\n");
const emit = e => process.stdout.write(JSON.stringify(e) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  emit({type:"thread.started",thread_id:"reconnect-proof"});
  emit({type:"turn.started"});
  emit({type:"error",message:${JSON.stringify(notice)}});
  setTimeout(() => {
    emit({type:"item.completed",item:{id:"final",type:"agent_message",text:"connection recovered"}});
    emit({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});
  }, 30);
});
`, { mode: 0o700 });
    const events: BackendEvent[] = [];
    const handle = new CodexAgentBackend({
      codexFactory: options => new Codex({ ...options, codexPathOverride: executable } as ConstructorParameters<typeof Codex>[0]) as unknown as CodexLike,
    }).spawn(cxSpec({ cwd: root, resume: "saved-thread" }), e => events.push(e), async () => true);
    try {
      await expect.poll(() => events.find(e => e.kind === "result" || e.kind === "error"), { timeout: 5000 }).toMatchObject({ kind: "result", data: { text: "connection recovered" } });
      expect(events.filter(e => e.kind === "error")).toEqual([]);
      expect(events.filter(e => e.data.reconnecting)).toHaveLength(1);
      expect(readFileSync(launched, "utf8")).toBe("launch\n");
    } finally { await handle.kill(); rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the same resumed invocation alive until the provider completes", async () => {
    const { events, fake } = await run([start, { type: "turn.started" }, { type: "error", message: notice },
      { type: "error", message: "Reconnecting... 5/5 (stream disconnected before completion)" },
      { type: "item.completed", item: { id: "answer", type: "agent_message", text: "recovered" } }, complete]);
    expect(events.filter(e => e.kind === "error")).toEqual([]);
    expect(events.filter(e => e.data.reconnecting)).toHaveLength(2);
    expect(events.find(e => e.kind === "result")?.data.text).toBe("recovered");
    expect(fake.resumedIds).toEqual(["saved-thread"]);
    expect(fake.threads).toHaveLength(1);
    expect(fake.threads[0]!.runs).toHaveLength(1);
  });

  it("still stops on turn.failed even when its text looks like a reconnect notice", async () => {
    const { events } = await run([start, { type: "error", message: notice },
      { type: "turn.failed", error: { message: notice } }, complete]);
    expect(events.filter(e => e.kind === "error").map(e => e.data.message)).toEqual([notice]);
    expect(events.some(e => e.kind === "result" || e.kind === "turn_complete")).toBe(false);
  });

  it("fails an exhausted stream without inventing success or replaying input", async () => {
    const { events, fake } = await run([start, { type: "error", message: notice }]);
    expect(events.find(e => e.kind === "error")?.data.phase).toBe("codex-turn-incomplete");
    expect(events.some(e => e.kind === "result")).toBe(false);
    expect(fake.threads[0]!.runs).toHaveLength(1);
  });

  it.each(["Broken pipe (os error 32)", "Reconnecting... 0/5", "Reconnecting... 6/5", "Reconnecting... 2/0", "Reconnecting... 2/5 unexpected", "Authentication failed"])(
    "preserves terminal handling for unrecognized error: %s", message => {
      expect(normalizeCodexEvent({ type: "error", message })).toMatchObject({ kind: "error", data: { message } });
    },
  );
});
