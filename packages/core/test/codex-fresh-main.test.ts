import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import type { AgentRecord } from "@chimera/core/supervisor";
import { buildThreadOptions, codexTransportFor } from "@chimera/core/backends/codex";
import { reattachConductors } from "@chimera/core/reattach";
import { initialState, reduce, type UiStore } from "../../ui-state/src/index.js";
import { createAgentCommands, type RpcFn } from "../../app/src/state/commands.agents.js";

const homes: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) {
    for (const record of engine.supervisor.list()) {
      if (record.state === "running" || record.state === "paused") await engine.supervisor.kill(record.agentId);
    }
    engine.events.flushDurable();
    engine.mailboxes.flushDurable();
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function freshEngine() {
  const home = mkdtempSync(join(tmpdir(), "chimera-fresh-codex-main-"));
  homes.push(home);
  expect(existsSync(join(home, "config.json"))).toBe(false);
  const backend = new FakeAgentBackend([[{ emit: { kind: "agent_started", data: { sessionId: "codex-session" } } }, { awaitSend: true }, { turn: {} }, { awaitSend: true }]], "codex");
  const engine = new Engine({ home, backends: new Map([["codex", backend]]) });
  engines.push(engine);
  return { home, backend, engine };
}

async function addMetadata(engine: Engine, profile?: "readOnly" | "acceptEdits" | "full") {
  // This is the persisted metadata produced by onboarding; no credentials or provider calls.
  await engine.handle("config.patch", { patch: {
    accounts: [{ name: "codex", provider: "codex", auth: { type: "subscription" } }],
    autoOrder: ["codex"],
    ...(profile ? { conductorPermissionProfile: profile } : {}),
  } });
}

it("the actual app first-send command delivers once on a fresh Codex-only home using the established full-conductor policy", async () => {
  const { home, backend, engine } = freshEngine();
  await addMetadata(engine);
  let state = { ...initialState };
  const store: UiStore = {
    getState: () => state,
    dispatch: (action) => { state = reduce(state, action); },
    subscribe: () => () => {},
    connectAndLoad: async () => {},
  };
  const calls: string[] = [];
  const rpc: RpcFn = async <T>(method: string, params?: unknown) => {
    calls.push(method);
    return await engine.handle(method, params ?? {}) as T;
  };
  await createAgentCommands(store, rpc).sendToMain("hello");
  expect(state.lastError).toBeNull();
  expect(calls).toEqual(["main.conductor.ensure", "agent.send"]);
  const record = engine.supervisor.status(state.mainConductorId!);
  try {
    expect(backend.spawns).toHaveLength(1);
    expect(record.spec.permissionProfile).toBe("full");
    expect(record.spec.acknowledgeCodexFullAccessRisk).toBe(true);
    expect(codexTransportFor(backend.spawns[0]!)).toBe("exec");
    expect(buildThreadOptions(backend.spawns[0]!, record.spec.cwd)).toMatchObject({ sandboxMode: "danger-full-access", approvalPolicy: "never" });
    expect(backend.deliveries.map((d) => d.text)).toEqual(["hello"]);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  } finally {
    await engine.supervisor.kill(record.agentId);
  }
});

it.each(["readOnly", "acceptEdits"] as const)("a fresh MAIN honors configured %s access without full-access acknowledgment", async (profile) => {
  const { backend, engine } = freshEngine();
  await addMetadata(engine, profile);
  const record = await engine.handle("main.conductor.ensure", {}) as AgentRecord;
  try {
    await engine.handle("agent.send", { agentId: record.agentId, text: "hello", from: "app" });
    expect(backend.spawns).toHaveLength(1);
    expect(backend.spawns[0]?.permissionProfile).toBe(profile);
    expect(backend.spawns[0]?.acknowledgeCodexFullAccessRisk).toBe(false);
    expect(codexTransportFor(backend.spawns[0]!)).toBe("app-server");
    expect(buildThreadOptions(backend.spawns[0]!, record.spec.cwd)).toMatchObject({ sandboxMode: profile === "readOnly" ? "read-only" : "workspace-write", approvalPolicy: "on-request" });
    expect(backend.deliveries.map((d) => d.text)).toEqual(["hello"]);
  } finally {
    await engine.supervisor.kill(record.agentId);
  }
});

it.each(["full", "acceptEdits"] as const)("a resumed MAIN retains its stored %s profile and acknowledgment after config changes", async (profile) => {
  const { home, engine } = freshEngine();
  await addMetadata(engine, profile);
  const original = await engine.ensureMainConductor();
  await vi.waitFor(() => expect(original.sessionId).toBe("codex-session"));
  const prior = structuredClone(original);
  await engine.supervisor.kill(original.agentId);
  const backend = new FakeAgentBackend([[{ awaitSend: true }, { turn: {} }, { awaitSend: true }]], "codex");
  const restarted = new Engine({ home, backends: new Map([["codex", backend]]) });
  engines.push(restarted);
  await restarted.handle("config.patch", { patch: { conductorPermissionProfile: profile === "full" ? "acceptEdits" : "full" } });
  reattachConductors(restarted, [prior]);
  const record = await restarted.ensureMainConductor();
  expect(record.agentId).toBe(original.agentId);
  expect(record.state).toBe("paused");
  expect(backend.spawns).toHaveLength(0);
  try {
    await restarted.handle("agent.send", { agentId: record.agentId, text: "resume hello", from: "app" });
    expect(backend.spawns).toHaveLength(1);
    expect(backend.spawns[0]).toMatchObject({ permissionProfile: profile, acknowledgeCodexFullAccessRisk: profile === "full", resume: "codex-session" });
    expect(backend.deliveries.map((d) => d.text)).toEqual(["resume hello"]);
  } finally {
    await restarted.supervisor.kill(record.agentId);
  }
});

it("the first Codex subscription account starts one usable MAIN seat before the first app send", async () => {
  const { backend, engine } = freshEngine();
  await engine.handle("accounts.add_subscription", { provider: "codex" });
  await vi.waitFor(() => expect(backend.spawns).toHaveLength(1));
  const record = await engine.ensureMainConductor();
  await engine.handle("agent.send", { agentId: record.agentId, text: "first onboarding message", from: "app" });
  expect(backend.spawns).toHaveLength(1);
  expect(record.spec).toMatchObject({ permissionProfile: "full", acknowledgeCodexFullAccessRisk: true });
  expect(backend.deliveries.map((d) => d.text)).toEqual(["first onboarding message"]);
});
