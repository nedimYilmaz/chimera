import { describe, expect, it, vi } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { CodexAgentBackend, normalizeCodexEvent } from "@chimera/core/backends/codex";
import type { AgentBackend, BackendEvent, NativeVoiceHandle } from "@chimera/core/backend";
import { makeEngineHome } from "./helpers.js";
import { fakeCodex } from "./codex-backend-helpers.js";

function setup(provider = "codex", execBackend?: AgentBackend) {
  const dir = makeEngineHome();
  const fake = new FakeAgentBackend(Array.from({ length: 4 }, () => [
    { emit: normalizeCodexEvent({ type: "thread.started", thread_id: "saved-thread" }) as BackendEvent },
    { awaitClose: { resultText: "done" } },
  ]), provider);
  const native: NativeVoiceHandle = { start: vi.fn(async () => "answer"), stop: vi.fn(async () => {}) };
  const backend: AgentBackend = { provider, capabilities: fake.capabilities, spawn: (spec, sink, perm, dialog) => {
    if (execBackend && spec.providerOptions.codexTransport !== "app-server") return execBackend.spawn(spec, sink, perm, dialog);
    const handle = fake.spawn(spec, sink, perm, dialog);
    return { ...handle, ...(spec.providerOptions.codexTransport === "app-server" && spec.providerOptions.codexRealtime === true ? { nativeVoice: native } : {}) };
  } };
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(ChimeraConfigSchema.parse({ accounts: [{ name: "voice", provider, auth: { type: "subscription" } }], autoOrder: ["voice"] })),
    credentials: new CredentialResolver(async () => ({ stdout: "", code: 1 })),
    backends: new Map([[provider, backend]]), events, mailboxes: new MailboxStore(dir), cooldowns: new CooldownTracker(60_000),
  });
  return { sup, fake, native, events };
}

describe("native voice manual transport transition", () => {
  it("keeps approved meetings eligible during owned opt-in holds, but not manual pauses", async () => {
    const s = setup(); const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
    const resume = s.sup.resumePaused.bind(s.sup);
    const spy = vi.spyOn(s.sup, "resumePaused").mockImplementation(async id => {
      expect(s.sup.status(id).state).toBe("paused");
      expect(() => s.sup.nativeVoiceCheck(id)).toThrow("paused");
      expect(s.sup.nativeVoiceCheck(id, true)).toEqual({ needsTransition: true });
      return resume(id);
    });
    try {
      await vi.waitFor(() => expect(r.sessionId).toBe("saved-thread"));
      await s.sup.prepareNativeVoice(r.agentId, true); expect(spy).toHaveBeenCalledOnce();
      await s.sup.hold(r.agentId);
      expect(() => s.sup.nativeVoiceCheck(r.agentId, true)).toThrow("paused");
    } finally { spy.mockRestore(); await s.sup.kill(r.agentId); }
  });
  it("can disable realtime without killing the agent or losing its thread", async () => {
    const s = setup();
    const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none", persistent: true, providerOptions: { codexTransport: "app-server", codexRealtime: true } });
    try {
      await vi.waitFor(() => expect(r.sessionId).toBe("saved-thread"));
      expect(await s.sup.configureNativeVoice(r.agentId, false)).toEqual({ enabled: false });
      expect(s.sup.status(r.agentId)).toMatchObject({ state: "running", sessionId: "saved-thread", spec: { providerOptions: { codexRealtime: false } } });
      expect(s.sup.currentNativeVoice(r.agentId)).toBeUndefined();
      expect(s.fake.spawns.at(-1)).toMatchObject({ resume: "saved-thread", resumeOnly: true });
      expect(s.events.tail(r.agentId, 100).some(e => e.data.state === "killed")).toBe(false);
      const count = s.fake.spawns.length;
      await s.sup.configureNativeVoice(r.agentId, false);
      expect(s.fake.spawns).toHaveLength(count);
    } finally { await s.sup.kill(r.agentId); }
  });
  it("changes paused agents without starting a process and rejects killed agents", async () => {
    const s = setup();
    const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
    await s.sup.hold(r.agentId);
    await s.sup.configureNativeVoice(r.agentId, true);
    expect(s.sup.status(r.agentId)).toMatchObject({ state: "paused", spec: { providerOptions: { codexRealtime: true } } });
    await s.sup.configureNativeVoice(r.agentId, false);
    expect(s.sup.status(r.agentId)).toMatchObject({ state: "paused", spec: { providerOptions: { codexRealtime: false } } });
    expect(s.fake.spawns).toHaveLength(1);
    await s.sup.kill(r.agentId);
    await expect(s.sup.configureNativeVoice(r.agentId, true)).rejects.toThrow("killed");
  });
  it("opts in only the selected agent, including an existing app-server agent, and retains the choice after pause", async () => {
    const s = setup();
    const spec = { prompt: "work", cwd: "/tmp", isolation: "none", persistent: true, providerOptions: { codexTransport: "app-server" } };
    const selected = await s.sup.spawn(spec);
    const other = await s.sup.spawn(spec);
    try {
      await vi.waitFor(() => expect(s.sup.status(selected.agentId).sessionId).toBe("saved-thread"));
      expect(s.sup.nativeVoiceCheck(selected.agentId)).toEqual({ needsTransition: true });
      await expect(s.sup.prepareNativeVoice(selected.agentId, false)).rejects.toThrow("confirmation");
      expect(s.fake.spawns).toHaveLength(2);
      expect(await s.sup.prepareNativeVoice(selected.agentId, true)).toBe(s.native);
      expect(s.sup.status(selected.agentId).spec.providerOptions.codexRealtime).toBe(true);
      expect(s.sup.status(other.agentId).spec.providerOptions.codexRealtime).toBeUndefined();
      expect(s.sup.status(other.agentId).state).toBe("running");
      expect(s.sup.currentNativeVoice(other.agentId)).toBeUndefined();
      expect(s.sup.nativeVoiceCheck(other.agentId)).toEqual({ needsTransition: true });
      await s.sup.hold(selected.agentId);
      await s.sup.resumePaused(selected.agentId);
      expect(s.fake.spawns.at(-1)).toMatchObject({ resume: "saved-thread", resumeOnly: true, providerOptions: { codexRealtime: true } });
      expect(s.sup.nativeVoiceCheck(selected.agentId)).toEqual({ needsTransition: false });
    } finally { await s.sup.kill(selected.agentId); await s.sup.kill(other.agentId); }
  });
  it("captures the real Codex backend's thread event and resumes that exact thread for voice", async () => {
    const sdk = fakeCodex([[{ type: "thread.started", thread_id: "th-1" }, { type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }]]);
    const s = setup("codex", new CodexAgentBackend({ codexFactory: sdk.factory }));
    const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none", persistent: true, providerOptions: { codexTransport: "exec" } });
    try {
      await vi.waitFor(() => expect(s.sup.status(r.agentId).sessionId).toBe("th-1"));
      expect(await s.sup.prepareNativeVoice(r.agentId, true)).toBe(s.native);
      expect(s.fake.spawns[0]).toMatchObject({ resume: "th-1", resumeOnly: true });
    } finally { await s.sup.kill(r.agentId); }
  });
  it("retains a known resume target while the Codex backend is idle before its first turn", async () => {
    const sdk = fakeCodex([]);
    const s = setup("codex", new CodexAgentBackend({ codexFactory: sdk.factory }));
    const r = await s.sup.spawn({ prompt: "do not replay", resume: "existing-thread", resumeOnly: true, cwd: "/tmp", isolation: "none", persistent: true, providerOptions: { codexTransport: "exec" } });
    try {
      expect(r.sessionId).toBe("existing-thread");
      expect(sdk.threads.flatMap(t => t.runs)).toHaveLength(0);
      expect(await s.sup.prepareNativeVoice(r.agentId, true)).toBe(s.native);
      expect(s.fake.spawns[0]).toMatchObject({ resume: "existing-thread", resumeOnly: true });
    } finally { await s.sup.kill(r.agentId); }
  });
  it("still refuses a fresh idle agent that has never established a thread, without restarting it", async () => {
    const sdk = fakeCodex([]);
    const s = setup("codex", new CodexAgentBackend({ codexFactory: sdk.factory }));
    const r = await s.sup.spawn({ prompt: "work", resumeOnly: true, cwd: "/tmp", isolation: "none", persistent: true, providerOptions: { codexTransport: "exec" } });
    try {
      await expect(s.sup.prepareNativeVoice(r.agentId, true)).rejects.toThrow("establish its session");
      expect(s.sup.status(r.agentId).state).toBe("running");
      expect(s.fake.spawns).toHaveLength(0);
    } finally { await s.sup.kill(r.agentId); }
  });
  it("requires acknowledgement, then retains agent/session/model/permission identity without a killed event", async () => {
    const s = setup();
    const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none", model: "gpt-6-astra", permissionProfile: "acceptEdits", providerOptions: { codexTransport: "exec" } });
    try {
      await vi.waitFor(() => expect(s.sup.status(r.agentId).sessionId).toBe("saved-thread"));
      expect(s.sup.nativeVoiceCheck(r.agentId)).toEqual({ needsTransition: true });
      await expect(s.sup.prepareNativeVoice(r.agentId, false)).rejects.toThrow("confirmation");
      expect(s.fake.spawns).toHaveLength(1);
      expect(await s.sup.prepareNativeVoice(r.agentId, true)).toBe(s.native);
      expect(s.fake.spawns).toHaveLength(2);
      expect(s.fake.spawns[1]).toMatchObject({ agentId: r.agentId, resume: "saved-thread", resumeOnly: true, model: "gpt-6-astra", accountName: "voice", permissionProfile: "acceptEdits", persistent: true, providerOptions: { codexTransport: "app-server", codexRealtime: true } });
      expect(s.events.tail(r.agentId, 100).some(e => e.data.state === "killed")).toBe(false);
      expect(s.sup.nativeVoiceCheck(r.agentId)).toEqual({ needsTransition: false });
    } finally { await s.sup.kill(r.agentId); }
  });
  it("does not restart an already opted-in interactive persistent agent", async () => {
    const s = setup(); const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none", persistent: true, providerOptions: { codexTransport: "app-server", codexRealtime: true } });
    try { expect(await s.sup.prepareNativeVoice(r.agentId, false)).toBe(s.native); expect(s.fake.spawns).toHaveLength(1); }
    finally { await s.sup.kill(r.agentId); }
  });
  it("never starts a killed or paused agent implicitly", async () => {
    const s = setup(); const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
    await s.sup.hold(r.agentId);
    expect(() => s.sup.nativeVoiceCheck(r.agentId)).toThrow("paused");
    await s.sup.kill(r.agentId);
    await expect(s.sup.prepareNativeVoice(r.agentId, true)).rejects.toThrow("killed");
    expect(s.sup.currentNativeVoice(r.agentId)).toBeUndefined();
  });
  it("rejects non-Codex providers without changing them", async () => {
    const s = setup("claude"); const r = await s.sup.spawn({ prompt: "work", cwd: "/tmp", isolation: "none" });
    try { await expect(s.sup.prepareNativeVoice(r.agentId, true)).rejects.toThrow("Codex"); expect(s.fake.spawns).toHaveLength(1); }
    finally { await s.sup.kill(r.agentId); }
  });
});
