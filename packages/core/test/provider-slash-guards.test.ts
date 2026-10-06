import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { BudgetDeniedError } from "@chimera/core/budget";
import { makeEngineHome } from "./helpers.js";

const SESSION: FakeStep = { emit: { kind: "agent_started", data: { sessionId: "native-session" } } };

function fixture(opts: { steps?: FakeStep[]; exposeCommand?: boolean } = {}) {
  const home = makeEngineHome(), path = join(home, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.accounts[0].provider = "codex";
  writeFileSync(path, JSON.stringify(config));
  const steps = opts.steps ?? [SESSION, { awaitSend: true }];
  const fake = new FakeAgentBackend(Array.from({ length: 4 }, () => steps), "codex");
  const command = vi.fn(async (text: string) => `native ${text}`);
  const exposeCommand = opts.exposeCommand ?? true;
  const backend: AgentBackend = { provider: "codex", capabilities: fake.capabilities, spawn(spec, sink, permission) {
    const handle = fake.spawn(spec, sink, permission);
    return { ...handle, isTurnActive: () => false, ...(exposeCommand && spec.providerOptions.codexTransport === "app-server" ? { command } : {}) };
  } };
  const engine = new Engine({ home, backends: new Map([["codex", backend]]) });
  return { engine, fake, command, home };
}

describe("Codex native command guards", () => {
  it.each(["/compact", "/goal resume"])("refuses %s while the agent's budget node is exhausted", async text => {
    const { engine, fake, command, home } = fixture({ steps: [SESSION, { emit: { kind: "turn_complete", data: { costUsd: 1 } } }, { awaitSend: true }] });
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true, maxBudgetUsd: 0.05 });
    try {
      await vi.waitFor(() => expect(engine.supervisor.treePaused(r.agentId)).toBe(true));
      expect(engine.supervisor.status(r.agentId).state).toBe("running");
      const sent = engine.supervisor.send(r.agentId, text, "app", undefined, true);
      await expect(sent).rejects.toBeInstanceOf(BudgetDeniedError);
      await expect(sent).rejects.toThrow("cannot start native work");
      expect(command).not.toHaveBeenCalled();
      expect(fake.spawns).toHaveLength(1);
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it("refuses a native command while a native-voice change is in flight and does not respawn", async () => {
    const { engine, fake, command, home } = fixture();
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      await vi.waitFor(() => expect(engine.supervisor.status(r.agentId).sessionId).toBe("native-session"));
      let release!: (held: boolean) => void;
      const hold = vi.spyOn(engine.supervisor, "hold").mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
      const voice = engine.supervisor.configureNativeVoice(r.agentId, true);
      await vi.waitFor(() => expect(hold).toHaveBeenCalledOnce());
      await expect(engine.supervisor.send(r.agentId, "/goal", "app", undefined, true)).rejects.toThrow("An agent connection change is in progress");
      expect(fake.spawns).toHaveLength(1);
      expect(command).not.toHaveBeenCalled();
      release(false);
      await expect(voice).rejects.toThrow("retry");
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it("refuses /goal on an exec agent that has no session yet without reattaching", async () => {
    const { engine, fake, command, home } = fixture({ steps: [{ awaitSend: true }] });
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      expect(engine.supervisor.status(r.agentId).sessionId).toBeFalsy();
      await expect(engine.supervisor.send(r.agentId, "/goal", "app", undefined, true)).rejects.toThrow("Wait for the Codex agent to establish its session");
      expect(fake.spawns).toHaveLength(1);
      expect(command).not.toHaveBeenCalled();
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it("rejects when the hold fails during reattach and leaves the next command unblocked", async () => {
    const { engine, fake, command, home } = fixture();
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      await vi.waitFor(() => expect(engine.supervisor.status(r.agentId).sessionId).toBe("native-session"));
      vi.spyOn(engine.supervisor, "hold").mockResolvedValueOnce(false);
      await expect(engine.supervisor.send(r.agentId, "/goal", "app", undefined, true)).rejects.toThrow("Agent changed while enabling native commands; retry");
      expect(command).not.toHaveBeenCalled();
      expect(fake.spawns).toHaveLength(1);
      await engine.supervisor.send(r.agentId, "/goal", "app", undefined, true);
      expect(command).toHaveBeenCalledExactlyOnceWith("/goal");
      expect(fake.spawns).toHaveLength(2);
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it("rejects /goal when the backend never exposes native commands, even after reattach", async () => {
    const { engine, fake, command, home } = fixture({ exposeCommand: false });
    const events: { kind: string; data: unknown }[] = [];
    engine.events.subscribe(e => events.push(e));
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      await vi.waitFor(() => expect(engine.supervisor.status(r.agentId).sessionId).toBe("native-session"));
      await expect(engine.supervisor.send(r.agentId, "/goal", "app", undefined, true)).rejects.toThrow("This Codex backend does not expose native commands");
      expect(fake.spawns).toHaveLength(2);
      expect(command).not.toHaveBeenCalled();
      expect(events.some(e => (e.data as { nativeCommand?: boolean } | undefined)?.nativeCommand)).toBe(false);
    } finally { await engine.supervisor.suspendForShutdown(); }
  });

  it.each([
    ["images", [{ mediaType: "image/png" as const, data: "aGk=" }], undefined],
    ["content", undefined, [{ type: "text" as const, text: "extra" }]],
  ])("rejects a Codex slash command carrying %s without invoking the native command", async (_label, images, content) => {
    const { engine, fake, command, home } = fixture();
    const r = await engine.supervisor.spawn({ prompt: "fixture", cwd: home, isolation: "none", provider: "codex", conductor: true });
    try {
      await vi.waitFor(() => expect(engine.supervisor.status(r.agentId).sessionId).toBe("native-session"));
      await expect(engine.supervisor.send(r.agentId, "/goal ship it", "app", images, true, content as Parameters<typeof engine.supervisor.send>[5])).rejects.toThrow("Send native commands without attachments");
      expect(command).not.toHaveBeenCalled();
      expect(fake.spawns).toHaveLength(1);
    } finally { await engine.supervisor.suspendForShutdown(); }
  });
});
