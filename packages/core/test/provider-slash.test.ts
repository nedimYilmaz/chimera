import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { parseCodexCommand } from "@chimera/core/backends/codex-commands";

function fixture(opts: { legacyExec?: boolean } = {}) {
  let active = false;
  const home = makeEngineHome(), path = join(home, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.accounts[0].provider = "codex";
  writeFileSync(path, JSON.stringify(config));
  const fake = new FakeAgentBackend(Array.from({ length: 4 }, () => [
    { emit: { kind: "agent_started" as const, data: { sessionId: "native-session" } } }, { awaitSend: true as const },
  ]), "codex");
  const command = vi.fn(async (text: string) => `native ${text}`);
  const backend: AgentBackend = { provider: "codex", capabilities: fake.capabilities, spawn(spec, sink, permission) {
    const handle = fake.spawn(spec, sink, permission);
    // Restored pre-migration processes lack native commands even though new launches default to app-server.
    return { ...handle, isTurnActive: () => active, ...(spec.providerOptions.codexTransport === "app-server" && !(opts.legacyExec && fake.spawns.length === 1) ? { command } : {}) };
  } };
  const engine = new Engine({ home, backends: new Map([["codex", backend]]) });
  return { engine, fake, command, home, setActive: (value: boolean) => { active = value; } };
}

describe("native provider slash dispatch", () => {
  it("does not interrupt an active exec turn to migrate its connection", async () => {
    const { engine, fake, home, setActive } = fixture({ legacyExec: true });
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      setActive(true);
      await expect(engine.supervisor.send(r.agentId, "/goal test", "app", undefined, true)).rejects.toThrow("current turn");
      expect(fake.spawns).toHaveLength(1);
      expect(engine.supervisor.status(r.agentId).state).toBe("running");
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it("keeps an operator-held agent paused when a command arrives", async () => {
    const { engine, fake, command, home } = fixture();
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      await engine.supervisor.hold(r.agentId);
      await expect(engine.supervisor.send(r.agentId, "/goal resume", "app", undefined, true)).rejects.toThrow("resume it");
      expect(engine.supervisor.status(r.agentId).state).toBe("paused");
      expect(fake.spawns).toHaveLength(1);
      expect(command).not.toHaveBeenCalled();
    } finally { await engine.supervisor.suspendForShutdown(); }
  });
  it("reattaches a restored exec session to app-server, keeps identity/session/permissions, and does not enqueue a prompt", async () => {
    const { engine, fake, command, home } = fixture({ legacyExec: true });
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true, permissionProfile: "full", acknowledgeCodexFullAccessRisk: true });
    try {
      await vi.waitFor(() => expect(r.sessionId).toBe("native-session"));
      const messageId = "510fb1f9-f412-44c8-98ff-cc83ffdfac73";
      const result = await engine.supervisor.send(r.agentId, "/goal Test fixture", "app", undefined, true, undefined, { messageId });
      expect(result).toMatchObject({ ack: "command", turnStarted: false, deliveryId: messageId });
      expect(engine.events.tail(r.agentId, 30).find(event => event.data.delivered)?.data.messageId).toBe(messageId);
      expect(engine.events.tail(r.agentId, 30).find(event => event.data.delivered)?.data.messageMetadata).toMatchObject({ from: "app", source: "operator", engineId: "local" });
      expect(command).toHaveBeenCalledExactlyOnceWith("/goal Test fixture");
      const updated = engine.supervisor.status(r.agentId);
      expect(updated).toMatchObject({ agentId: r.agentId, accountName: r.accountName, sessionId: "native-session", state: "running" });
      expect(updated.spec).toMatchObject({ resume: "native-session", resumeOnly: true, persistent: true, cwd: home, permissionProfile: "full", providerOptions: { codexTransport: "app-server" } });
      expect(fake.spawns).toHaveLength(2);
      expect(updated.promptStall).toBeNull();
      await engine.supervisor.send(r.agentId, "/goal pause", "app", undefined, true);
      expect(fake.spawns).toHaveLength(2);
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it.each(["/bogus", "/goal edit", `/goal ${"x".repeat(4001)}`])("rejects invalid commands before changing a connection", async text => {
    const { engine, fake, command, home } = fixture();
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      await expect(engine.supervisor.send(r.agentId, text, "app", undefined, true)).rejects.toThrow();
      expect(fake.spawns).toHaveLength(1);
      expect(command).not.toHaveBeenCalled();
      expect(engine.supervisor.status(r.agentId).state).toBe("running");
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it("respects an explicit exec transport override", async () => {
    const { engine, fake, home } = fixture();
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true, providerOptions: { codexTransport: "exec" } });
    try {
      await expect(engine.supervisor.send(r.agentId, "/goal", "app", undefined, true)).rejects.toThrow("explicitly pins");
      expect(fake.spawns).toHaveLength(1);
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it("keeps goal pause/resume updates separate from objective replacement", () => {
    expect(parseCodexCommand("/goal pause")).toEqual({ name: "goal", action: "set", status: "paused" });
    expect(parseCodexCommand("/goal resume")).not.toHaveProperty("objective");
    expect(parseCodexCommand("/goal edit new objective")).toMatchObject({ objective: "new objective" });
  });
});
