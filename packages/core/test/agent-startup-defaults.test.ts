import { describe, it, expect, vi } from "vitest";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { AgentSpecSchema, ChimeraConfigSchema } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js";

function rig() {
  const fake = new FakeAgentBackend([]);
  const engine = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", fake], ["codex", fake]]) });
  return { engine, fake };
}
describe("normal execution and native MCP startup defaults", () => {
  it("enables user/project sources and disables lean filtering without overriding explicit isolation", () => {
    expect(ChimeraConfigSchema.parse({}).leanAgentContext).toBe(false);
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp" }).inherit.settingSources).toEqual(["project", "user"]);
    expect(AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", inherit: { settingSources: [] } }).inherit.settingSources).toEqual([]);
  });
  it("applies default execute and both catalogs to a scheduled role spawn", async () => {
    const { engine, fake } = rig();
    await engine.handle("role.create", { spec: { name: "digest-default", cwd: "/tmp", isolation: "none", orchestration: { allow: true } } });
    await engine.handle("job.create", { spec: { name: "digest", schedule: { every: { unit: "hours", n: 1 } }, target: { role: "digest-default" }, prompt: "digest" } });
    await engine.handle("job.runNow", { name: "digest" });
    await vi.waitFor(() => expect(fake.spawns).toHaveLength(1));
    expect(fake.spawns[0]).toMatchObject({ executionMode: "execute", inherit: { settingSources: ["project", "user"] }, orchestration: { allow: true } });
    expect(fake.spawns[0]!.providerOptions.strictMcpConfig).toBeUndefined();
  });
  it("retains explicit plan, native MCP opt-out and Chimera grant independently", async () => {
    const { engine, fake } = rig();
    await engine.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none", executionMode: "plan", loadSettings: false, strictMcpConfig: true, orchestration: { allow: true } } });
    expect(fake.spawns[0]).toMatchObject({ executionMode: "plan", inherit: { settingSources: [] }, strictMcpConfig: true, orchestration: { allow: true } });
  });
  it("does not send a Claude-only control to Codex", async () => {
    const { engine, fake } = rig();
    await engine.handle("config.patch", { patch: { accounts: [{ name: "codex", provider: "codex", auth: { type: "subscription" } }], autoOrder: ["codex"] } });
    await engine.handle("agent.spawn", { spec: { prompt: "p", cwd: "/tmp", isolation: "none", provider: "codex" } });
    expect(fake.spawns[0]!.executionMode).toBeUndefined();
  });
});
