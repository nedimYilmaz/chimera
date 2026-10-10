import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSpecSchema } from "@chimera/protocol";
import { MCP_TOOL_TABLE } from "@chimera/protocol/mcp-tools";
import { Engine } from "@chimera/core/engine";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import type { AgentBackend } from "@chimera/core/backend";
import { reconstructAgentsFromLog } from "@chimera/core/replay";
import { makeEngineHome } from "./helpers.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
function harness() {
  const calls: Array<{ options: Record<string, unknown> }> = [];
  const setPermissionMode = vi.fn(async (_mode: string) => {});
  let emit: (m: Record<string, unknown>) => void = () => {};
  let finish: () => void = () => {};
  const queryFn = ((args: { options: Record<string, unknown> }) => {
    calls.push(args);
    let next: (v: IteratorResult<Record<string, unknown>>) => void = () => {};
    const queue: Record<string, unknown>[] = [];
    let ended = false, waiting = false;
    emit = m => { if (waiting) { waiting = false; next({ done: false, value: m }); } else queue.push(m); };
    finish = () => { ended = true; next({ done: true, value: undefined }); };
    return {
      [Symbol.asyncIterator]() { return this; },
      next() { return ended ? Promise.resolve({ done: true, value: undefined }) : queue.length
        ? Promise.resolve({ done: false, value: queue.shift() })
        : new Promise(resolve => { waiting = true; next = resolve as typeof next; }); },
      setPermissionMode,
      interrupt: vi.fn(async () => finish()),
    };
  }) as never;
  const backend = new ClaudeAgentBackend({ queryFn });
  return { backend, calls, setPermissionMode, emit: (m: Record<string, unknown>) => emit(m) };
}
async function live(over: Record<string, unknown> = {}) {
  const h = harness();
  const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", h.backend]]) });
  const a = await e.handle("agent.spawn", { spec: { prompt: "Waiting for input", resumeOnly: true, resume: "native-session", cwd: "/tmp", isolation: "none", session: true, ...over } }) as { agentId: string };
  cleanup.push(() => e.supervisor.kill(a.agentId));
  h.emit({ type: "system", subtype: "init", session_id: "native-session", permissionMode: "plan" });
  await vi.waitFor(() => expect(e.supervisor.status(a.agentId).executionMode).toBe("plan"));
  return { ...h, e, id: a.agentId };
}

describe("native Claude execution mode", () => {
  it.each(["readOnly", "acceptEdits", "full"] as const)("spawn plan and exit restore %s, independent of autonomy", async profile => {
    const h = await live({ executionMode: "plan", permissionProfile: profile, autonomy: "full" });
    expect(h.calls[0]!.options.permissionMode).toBe("plan");
    const rec = h.e.supervisor.status(h.id);
    const res = await h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } });
    expect(res).toMatchObject({ respawned: false, applied: ["executionMode"] });
    expect(h.setPermissionMode).toHaveBeenCalledWith(({ readOnly: "default", acceptEdits: "auto", full: "auto" })[profile]);
    expect(rec.executionMode).toBe("execute"); expect(rec.spec.executionMode).toBe("execute");
    expect(rec.spec.permissionProfile).toBe(profile); expect(rec.spec.autonomy).toBe("full");
    expect(rec.sessionId).toBe("native-session"); expect(h.calls).toHaveLength(1);
  });
  it("explicit auto overrides a role's native mode, survives resume and preserves profile/session", async () => {
    const h = await live({ permissionProfile: "full", executionMode: "plan", providerOptions: { permissionMode: "bypassPermissions" } });
    const result = await h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "auto" } });
    expect(result).toMatchObject({ respawned: false, applied: ["executionMode"] });
    expect(h.setPermissionMode).toHaveBeenLastCalledWith("auto");
    const rec = h.e.supervisor.status(h.id);
    expect(rec.executionMode).toBe("auto");
    expect(rec.spec.executionMode).toBe("auto");
    expect(rec.spec.permissionProfile).toBe("full");
    expect(rec.sessionId).toBe("native-session");
    // A session born with bypass wiring must stop returning native allow after auto ACK.
    const hooks = h.calls[0]!.options.hooks as { PreToolUse: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> };
    expect(await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "Read", tool_input: { file_path: "/tmp/example" } })).toEqual({});
    const replay = structuredClone(rec);
    delete replay.spec.executionMode; replay.executionMode = undefined;
    reconstructAgentsFromLog([replay], [{ seq: 3, ts: 3, agentId: h.id, kind: "status", data: { executionMode: "auto", requestedExecutionMode: "auto" } }]);
    expect(replay.spec.executionMode).toBe("auto"); expect(replay.executionMode).toBe("auto");
    await h.e.handle("agent.reconfigure", { agentId: h.id, patch: { maxTurns: 123 } });
    expect(h.calls[1]!.options.permissionMode).toBe("auto");
    expect(h.calls[1]!.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(h.calls[1]!.options.resume).toBe("native-session");
    h.emit({ type: "system", subtype: "init", session_id: "native-session", permissionMode: "auto" });
    await vi.waitFor(() => expect(rec.executionMode).toBe("auto"));
  });
  it("auto refusal retains the previous mode and stopped auto is saved without a native call", async () => {
    const h = await live({ executionMode: "plan" });
    h.setPermissionMode.mockRejectedValueOnce(new Error("auto unavailable"));
    await expect(h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "auto" } })).rejects.toThrow("auto unavailable");
    expect(h.e.supervisor.status(h.id).spec.executionMode).toBe("plan");
    await h.e.supervisor.kill(h.id);
    await h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "auto" } });
    expect(h.e.supervisor.status(h.id).spec.executionMode).toBe("auto");
    expect(h.e.supervisor.status(h.id).executionMode).toBeUndefined();
    expect(h.setPermissionMode).toHaveBeenCalledTimes(1);
  });
  it("preserves an explicit native permission mode on execute and resume", async () => {
    const h = await live({ permissionProfile: "full", providerOptions: { permissionMode: "acceptEdits" } });
    expect(h.calls[0]!.options.permissionMode).toBe("acceptEdits");
    expect(h.calls[0]!.options.allowDangerouslySkipPermissions).toBeUndefined();
    await h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } });
    expect(h.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    await h.e.handle("agent.reconfigure", { agentId: h.id, patch: { maxTurns: 123 } });
    expect(h.calls[1]!.options.permissionMode).toBe("acceptEdits");
  });
  it("reports native entry into plan mode and persists it across event replay", async () => {
    const h = await live({ permissionProfile: "acceptEdits" });
    expect(h.calls[0]!.options.permissionMode).toBe("auto");
    const rec = h.e.supervisor.status(h.id);
    const restored = structuredClone(rec);
    restored.executionMode = undefined; delete restored.spec.executionMode;
    reconstructAgentsFromLog([restored], [{ seq: 2, ts: 2, agentId: h.id, kind: "status", data: { executionMode: "plan" } }]);
    expect(restored.executionMode).toBe("plan"); expect(restored.spec.executionMode).toBeUndefined();
    h.emit({ type: "system", subtype: "status", status: null, permissionMode: "default" });
    await vi.waitFor(() => expect(rec.executionMode).toBe("execute"));
  });
  it("defaults to execute on resume without turning an observed plan into a saved preference", async () => {
    const h = await live({ permissionProfile: "acceptEdits" });
    expect(h.calls[0]!.options.permissionMode).toBe("auto");
    const rec = h.e.supervisor.status(h.id);
    expect(rec.executionMode).toBe("plan");
    expect(rec.spec.executionMode).toBeUndefined();
    await h.e.handle("agent.reconfigure", { agentId: h.id, patch: { maxTurns: 123 } });
    expect(h.calls[1]!.options.permissionMode).toBe("auto");
    expect(h.calls[1]!.options.resume).toBe("native-session");
  });
  it("preserves an explicit plan preference across restart and requested-mode replay", async () => {
    const h = await live({ permissionProfile: "acceptEdits", executionMode: "plan" });
    await h.e.handle("agent.reconfigure", { agentId: h.id, patch: { maxTurns: 123 } });
    expect(h.calls[1]!.options.permissionMode).toBe("plan");
    const restored = structuredClone(h.e.supervisor.status(h.id));
    reconstructAgentsFromLog([restored], [{ seq: 2, ts: 2, agentId: h.id, kind: "status", data: { executionMode: "execute", requestedExecutionMode: "execute" } }]);
    expect(restored.spec.executionMode).toBe("execute");
    reconstructAgentsFromLog([restored], [{ seq: 3, ts: 3, agentId: h.id, kind: "status", data: { executionMode: "plan" } }]);
    expect(restored.executionMode).toBe("plan");
    expect(restored.spec.executionMode).toBe("execute");
  });
  it("never acknowledges before SDK acceptance, preserves mode on rejection, blocks concurrent transitions", async () => {
    const h = await live(); let reject!: (e: Error) => void;
    h.setPermissionMode.mockImplementationOnce(() => new Promise<void>((_, r) => { reject = r; }));
    const pending = h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } });
    const rejection = expect(pending).rejects.toThrow("native refused");
    expect(h.e.supervisor.status(h.id).executionMode).toBe("plan");
    await expect(h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "plan" } })).rejects.toThrow("already pending");
    reject(new Error("native refused")); await rejection;
    expect(h.e.supervisor.status(h.id).spec.executionMode).toBeUndefined();
    await h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } });
    expect(h.e.supervisor.status(h.id).executionMode).toBe("execute");
  });
  it("keeps full/plan and the same session when managed policy refuses bypass", async () => {
    const h = await live({ permissionProfile: "full", executionMode: "plan", providerOptions: { permissionMode: "bypassPermissions" } });
    h.setPermissionMode.mockRejectedValueOnce(new Error("Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration"));
    await expect(h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } }))
      .rejects.toThrow("disabled by settings or configuration");
    expect(h.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(h.setPermissionMode).toHaveBeenCalledWith("bypassPermissions");
    const rec = h.e.supervisor.status(h.id);
    expect(rec.executionMode).toBe("plan");
    expect(rec.spec.permissionProfile).toBe("full");
    expect(rec.sessionId).toBe("native-session");
    expect(h.calls).toHaveLength(1);
  });
  it("rejects stale acknowledgment after stop; saves stopped mode only for next launch", async () => {
    const h = await live(); let resolve!: () => void;
    h.setPermissionMode.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    const pending = h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } });
    const rejection = expect(pending).rejects.toThrow("session changed");
    await h.e.supervisor.kill(h.id); resolve(); await rejection;
    await h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } });
    const rec = h.e.supervisor.status(h.id);
    expect(rec.executionMode).toBeUndefined(); expect(rec.spec.executionMode).toBe("execute");
    expect(h.setPermissionMode).toHaveBeenCalledTimes(1);
  });
  it("an old generation's pending control cannot block or acknowledge its replacement", async () => {
    const h = await live(); let resolve!: () => void;
    h.setPermissionMode.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; }));
    const pending = h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } });
    const rejection = expect(pending).rejects.toThrow("session changed");
    await h.e.handle("agent.reconfigure", { agentId: h.id, patch: { maxTurns: 123 } });
    await h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "plan" } });
    resolve(); await rejection;
    expect(h.e.supervisor.status(h.id).executionMode).toBe("plan");
    expect(h.calls).toHaveLength(2);
  });
  it("MCP spawn and mode controls carry the same first-class values; invalid/unsupported inputs fail", async () => {
    const spawn = MCP_TOOL_TABLE.find(t => t.name === "agent_spawn")!;
    const mode = MCP_TOOL_TABLE.find(t => t.name === "agent_set_mode")!;
    expect(spawn.resolve(z.object(spawn.inputSchema).parse({ prompt: "p", cwd: "/tmp", executionMode: "plan" }), {})).toMatchObject({ params: { spec: { executionMode: "plan" } } });
    expect(mode.resolve({ agentId: "a", mode: "execute" }, {})).toMatchObject({ method: "agent.reconfigure", params: { agentId: "a", live: { executionMode: "execute" } } });
    expect(mode.resolve(z.object(mode.inputSchema).parse({ agentId: "a", mode: "auto" }), {})).toMatchObject({ params: { live: { executionMode: "auto" } } });
    expect(spawn.resolve(z.object(spawn.inputSchema).parse({ prompt: "p", cwd: "/tmp", executionMode: "auto" }), {})).toMatchObject({ params: { spec: { executionMode: "auto" } } });
    expect(() => AgentSpecSchema.parse({ prompt: "p", cwd: "/tmp", executionMode: "invalid" })).toThrow();
    const h = await live();
    const rec = h.e.supervisor.status(h.id); rec.spec.runtime = "terminal";
    await expect(h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } })).rejects.toThrow("Claude SDK");
    rec.spec.runtime = "sdk"; rec.provider = "codex";
    await expect(h.e.handle("agent.reconfigure", { agentId: h.id, live: { executionMode: "execute" } })).rejects.toThrow("Claude SDK");
    expect(h.setPermissionMode).not.toHaveBeenCalled();
  });
});
