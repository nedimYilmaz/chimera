import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpecSchema } from "@chimera/protocol";
import type { ResolvedAgentSpec } from "../src/backend.js";
import { connectKimiAcp, type KimiAcpUpdate } from "../src/backends/kimi.js";
import { probeKimiModels } from "../src/providers/model-probes.js";

const executable = fileURLToPath(new URL("./fixtures/kimi-sdk-wire.mjs", import.meta.url));

it("preserves model config through the SDK's full v1 entrypoint", async () => {
  const models = await probeKimiModels({ env: { ...process.env, CHIMERA_KIMI_CLI_PATH: executable } });
  expect(models).toContainEqual(expect.objectContaining({ value: "kimi-wire-model", displayName: "Wire model" }));
});

it("dispatches updates and permission requests, and cancels a pending prompt over real stdio", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "chimera-acp-sdk-"));
  const spec = {
    ...AgentSpecSchema.parse({ prompt: "task", provider: "kimi", cwd, isolation: "none", executionMode: "execute", orchestration: { allow: false }, providerOptions: { executable } }),
    agentId: "wire-agent", accountName: "test", resolvedProvider: "kimi", env: {}, depth: 0,
  } as ResolvedAgentSpec;
  const updates: KimiAcpUpdate[] = [];
  const permissions: string[] = [];
  const handle = connectKimiAcp(spec, cwd, {
    onUpdate: update => updates.push(update),
    decidePermission: async request => { permissions.push(request.toolName); return true; },
  });
  try {
    const session = await handle.ready;
    expect(await session.prompt([{ type: "text", text: "run" }])).toMatchObject({ stopReason: "end_turn" });
    expect(permissions).toEqual(["Read fixture"]);
    expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: "compaction_update", status: "completed" }));
    updates.length = 0;
    const pending = session.prompt([{ type: "text", text: "wait" }]);
    await expect.poll(() => updates.length).toBe(1);
    await session.cancel();
    expect(await pending).toMatchObject({ stopReason: "cancelled" });
  } finally {
    handle.killNow();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 10_000);
